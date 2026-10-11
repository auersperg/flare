import { bundle } from "./bundle.mjs";
import { compile } from "json-schema-to-typescript";
import { manifest, schemaContract } from "../sdk/server.js";
import { stableJson } from "../sdk/protocol.js";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (data) => createHash("sha256").update(data).digest("hex");
export async function buildApplication(options) {
  const entry = resolve(options.entry),
    outdir = resolve(options.outdir),
    working = dirname(entry);
  try {
    await access(outdir);
    throw new Error(
      "Output directory already exists; builds never overwrite an existing release",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await access(entry);
  await mkdir(join(working, ".flare/tmp"), { recursive: true });
  const temporary = await mkdtemp(join(working, ".flare/tmp/build-"));
  try {
    // Metadata evaluation executes only trusted application modules locally, never in a request.
    const metadataPath = join(temporary, "metadata.mjs");
    await bundle({
      entrypoints: [entry],
      outdir: temporary,
      naming: { entry: "metadata.mjs" },
      packages: "external",
      target: "bun",
      format: "esm",
    });
    const module = await import(pathToFileURL(metadataPath).href);
    if (!module.default)
      throw new Error("Application entry must default-export defineApp(...)");
    const contract = manifest(module.default);
    const schema = schemaContract(module.default.schema);
    const facet = await compileRole("facet", entry, working);
    const action = await compileRole(
      "action",
      options.actionEntry ? resolve(options.actionEntry) : entry,
      working,
    );
    const checksums = {
      facet: digest(facet),
      action: digest(action),
      schema: digest(stableJson(schema)),
      manifest: digest(stableJson(contract)),
    };
    const artifact = {
      protocol: 1,
      compatibilityDate: "2026-10-10",
      checksums,
    };
    const hash = digest(stableJson(artifact));
    const staging = join(temporary, "release");
    await mkdir(staging);
    await writeFile(join(staging, "facet.js"), facet);
    await writeFile(join(staging, "action.js"), action);
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(contract, null, 2),
    );
    await writeFile(
      join(staging, "schema.json"),
      JSON.stringify(schema, null, 2),
    );
    await writeFile(
      join(staging, "release.json"),
      JSON.stringify({ ...artifact, hash }, null, 2),
    );
    await writeFile(
      join(staging, "api.ts"),
      await generateReferences(contract),
    );
    const calls = Object.entries(contract.functions).filter(
      ([, fn]) => fn.auth !== "internal",
    );
    const schemas = Object.create(null);
    const refSchema = (schema, name) => {
      const rewrite = (value) => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            key === "$ref" && typeof item === "string" && item.startsWith("#/")
              ? `#/components/schemas/${name}/${item.slice(2)}`
              : rewrite(item),
          ]),
        );
      };
      schemas[name] = rewrite(schema);
      return { $ref: `#/components/schemas/${name}` };
    };
    const callSchemas = calls.map(([path, fn], index) => ({
      path,
      fn,
      input: refSchema(fn.input, `Input${index}`),
      output: refSchema(fn.output, `Output${index}`),
    }));
    const openapi = {
      openapi: "3.1.0",
      info: { title: "Flare application contract", version: hash },
      components: {
        schemas,
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      paths: calls.length
        ? {
            "/v1/call": {
              post: {
                operationId: "callFunction",
                security: calls.some(([, fn]) => fn.auth === "public")
                  ? [{}, { bearer: [] }]
                  : [{ bearer: [] }],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        oneOf: callSchemas.map(({ path, fn, input }) => ({
                          type: "object",
                          additionalProperties: false,
                          required: ["path", "kind", "args"],
                          properties: {
                            path: { const: path },
                            kind: { const: fn.kind },
                            args: input,
                          },
                        })),
                      },
                    },
                  },
                },
                responses: {
                  200: {
                    description: "Validated function result",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          required: ["result"],
                          properties: {
                            result: {
                              anyOf: callSchemas.map(({ output }) => output),
                            },
                          },
                        },
                      },
                    },
                  },
                  401: { description: "Unauthorized" },
                  500: {
                    description:
                      "Execution failed; write outcome may be ambiguous",
                  },
                },
              },
            },
          }
        : {},
    };
    await writeFile(
      join(staging, "openapi.json"),
      JSON.stringify(openapi, null, 2),
    );
    await mkdir(dirname(outdir), { recursive: true });
    await rename(staging, outdir);
    return { hash, outdir, checksums };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function compileRole(role, entry, working) {
  const code =
    role === "facet"
      ? `import app from ${JSON.stringify(entry)}; import {createFacet} from "flare/cloudflare"; export class AppFacet extends createFacet(app) {}`
      : `import app from ${JSON.stringify(entry)}; import {createAction} from "flare/cloudflare"; export class Action extends createAction(app) {}`;
  const virtualEntry = join(working, `${role}-entry.ts`);
  const result = await bundle({
    entrypoints: [virtualEntry],
    files: { [virtualEntry]: code },
    external: ["cloudflare:workers"],
    metafile: true,
  });
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /modelcontextprotocol|agents\//.test(path),
    )
  )
    throw new Error("Full Agents/MCP code entered application bundle");
  if (result.outputs.length !== 1 || result.outputs[0].kind !== "entry-point")
    throw new Error(
      "Application runtime must compile to one JavaScript module",
    );
  const output = await result.outputs[0].text();
  if (Buffer.byteLength(output) > 1048576)
    throw new Error("Application bundle exceeds the preview 1 MiB limit");
  return output;
}

export async function generateReferences(contract) {
  let generated = 'import {reference} from "flare";\n';
  const refs = [];
  for (const [index, [path, fn]] of Object.entries(
    contract.functions,
  ).entries()) {
    generated += await compile(fn.input, `Input${index}`, {
      bannerComment: "",
    });
    generated += await compile(fn.output, `Output${index}`, {
      bannerComment: "",
    });
    refs.push(
      `${JSON.stringify(path)}: reference<Input${index}, Output${index}>(${JSON.stringify(path)}, ${JSON.stringify(fn.kind)})`,
    );
  }
  generated += `\nexport const api = {\n${refs.join(",\n")}\n} as const;\n`;
  return generated;
}
