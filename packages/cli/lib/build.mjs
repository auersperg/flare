import { build } from "esbuild";
import { compile } from "json-schema-to-typescript";
import { manifest } from "@flared/sdk/server";
import { stableJson } from "@flared/sdk/protocol";
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
  const dir = resolve(options.migrations);
  const journal = JSON.parse(
    await readFile(join(dir, "meta/_journal.json"), "utf8"),
  );
  if (!Array.isArray(journal.entries))
    throw new Error("Invalid Drizzle migration journal");
  const migrations = {};
  let previous = -1;
  for (const [index, item] of journal.entries.entries()) {
    if (
      item.idx !== index ||
      !Number.isSafeInteger(item.when) ||
      item.when <= previous ||
      typeof item.tag !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(item.tag)
    )
      throw new Error("Invalid or non-monotonic Drizzle migrations");
    migrations[`m${String(item.idx).padStart(4, "0")}`] = await readFile(
      join(dir, `${item.tag}.sql`),
      "utf8",
    );
    previous = item.when;
  }
  const migrationConfig = { journal: { entries: journal.entries }, migrations };
  await mkdir(join(working, ".flared/tmp"), { recursive: true });
  const temporary = await mkdtemp(join(working, ".flared/tmp/build-"));
  try {
    // Metadata evaluation executes only trusted application modules locally, never in a request.
    const metadataPath = join(temporary, "metadata.mjs");
    await build({
      entryPoints: [entry],
      outfile: metadataPath,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(metadataPath).href);
    if (!module.default)
      throw new Error("Application entry must default-export defineApp(...)");
    const contract = manifest(module.default);
    const facet = await compileRole("facet", entry, working, migrationConfig);
    const action = await compileRole("action", entry, working, migrationConfig);
    const checksums = {
      facet: digest(facet),
      action: digest(action),
      migrations: digest(stableJson(migrationConfig)),
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
      join(staging, "migrations.json"),
      JSON.stringify(migrationConfig, null, 2),
    );
    await writeFile(
      join(staging, "release.json"),
      JSON.stringify({ ...artifact, hash }, null, 2),
    );
    let generated = 'import {reference} from "@flared/sdk";\n';
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
    await writeFile(join(staging, "api.ts"), generated);
    const calls = Object.entries(contract.functions).filter(
      ([, fn]) => fn.kind !== "live",
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
      info: { title: "Flared application contract", version: hash },
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
async function compileRole(role, entry, working, migrations) {
  const code =
    role === "facet"
      ? `import app from ${JSON.stringify(entry)}; import {createFacet} from "@flared/sdk/cloudflare"; export class AppFacet extends createFacet(app, ${JSON.stringify(migrations)}) {}`
      : `import app from ${JSON.stringify(entry)}; import {createAction} from "@flared/sdk/cloudflare"; export class Action extends createAction(app) {}`;
  const result = await build({
    stdin: {
      contents: code,
      resolveDir: working,
      sourcefile: `${role}-entry.ts`,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    metafile: true,
    logLevel: "silent",
  });
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /modelcontextprotocol|agents\//.test(path),
    )
  )
    throw new Error("Full Agents/MCP code entered application bundle");
  const output = result.outputFiles[0].text;
  if (Buffer.byteLength(output) > 1048576)
    throw new Error("Application bundle exceeds the preview 1 MiB limit");
  return output;
}
