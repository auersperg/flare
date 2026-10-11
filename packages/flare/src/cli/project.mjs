import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  access,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { bundle } from "./bundle.mjs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export async function scaffold() {
  await access("package.json");
  await mkdir("flare", { recursive: true });
  // Never overwrite application code.
  try {
    await writeFile(
      "flare/schema.ts",
      'import {defineSchema} from "@auersperg/flare/server";\nexport default defineSchema({});\n',
      { flag: "wx" },
    );
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  for (const [file, text] of [
    [".gitignore", "\n.flare/\nflare/_generated/\n.env.local\n"],
    [".prettierignore", "\n.flare/\nflare/_generated/\n"],
  ]) {
    const previous = await readFile(file, "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return "";
    });
    if (!previous.includes("flare/_generated/"))
      await writeFile(file, previous + text);
  }
}

async function modules(directory, prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name),
      name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...(await modules(path, name + "/")));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      name !== "schema.ts" &&
      !name.endsWith(".d.ts")
    )
      result.push({ path: resolve(path), name: name.slice(0, -3) });
  }
  return result;
}

export async function prepare() {
  await scaffold();
  await mkdir(".flare/build", { recursive: true });
  await mkdir("flare/_generated", { recursive: true });
  await writeFile(
    "flare/_generated/server.ts",
    'import type schema from "../schema";\nimport {createFunctions} from "@auersperg/flare/server";\nexport const {query,mutation,action}=createFunctions<typeof schema>();\n',
  );
  const files = await modules("flare");
  const schema = resolve("flare/schema.ts"),
    entry = resolve(".flare/build/app.ts");
  const imports = files
    .map((file, i) => `import * as f${i} from ${JSON.stringify(file.path)};`)
    .join("\n");
  const source = `import {defineApp} from "@auersperg/flare/server";
import schema from ${JSON.stringify(schema)};
${imports}
const functions={};
${files.map((file, i) => `functions[${JSON.stringify(file.name)}]=Object.fromEntries(Object.entries(f${i}).filter(([,fn])=>fn && typeof fn === "object" && ["query","mutation","action"].includes(fn.kind)));`).join("\n")}
const tree=Object.create(null);
for(const [path,exports] of Object.entries(functions)) {
  const parts=path.split("/");let node=tree;
  for(const part of parts.slice(0,-1))node=node[part]??=Object.create(null);
  const key=parts.at(-1); if(key in node)throw Error("Function namespace conflict: "+path);
  node[key]=exports;
}
export default defineApp({schema,functions:tree});
`;
  await writeFile(entry, source);
  const metadata = resolve(`.flare/build/metadata-${randomUUID()}.mjs`);
  try {
    await bundle({
      entrypoints: [entry],
      outdir: resolve(".flare/build"),
      naming: { entry: metadata.split("/").at(-1) },
      packages: "external",
      target: "bun",
      format: "esm",
    });
    const app = await import(pathToFileURL(metadata).href);
    if (!app.default?.schema)
      throw Error("Schema must export defineSchema(...)");
    // Generate static named imports from the evaluated registry, not a JS parser.
    // An action worker never imports schema/query/mutation-only modules.
    const imports = [],
      declarations = [];
    for (const file of files) {
      const node = file.name
        .split("/")
        .reduce((tree, name) => tree?.[name], app.default.functions);
      for (const [name, fn] of Object.entries(node ?? {})) {
        if (fn?.kind !== "action") continue;
        const symbol = `action${imports.length}`;
        imports.push(
          `import {${name} as ${symbol}} from ${JSON.stringify(file.path)};`,
        );
        declarations.push(
          `${JSON.stringify(file.name + "/" + name)}:${symbol}`,
        );
      }
    }
    const actionEntry = resolve(".flare/build/actions.ts");
    await writeFile(
      actionEntry,
      `${imports.join("\n")}\nexport default {functions:{${declarations.join(",")}}};\n`,
    );
    return { entry, actionEntry };
  } finally {
    await rm(metadata, { force: true });
  }
}

export async function generateApi(directory) {
  await mkdir("flare/_generated", { recursive: true });
  const flat = await readFile(join(directory, "api.ts"), "utf8");
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  const paths = Object.keys(manifest.functions);
  const tree = Object.create(null);
  for (const path of paths) {
    let node = tree;
    const parts = path.split("/");
    for (const part of parts.slice(0, -1))
      node = node[part] ??= Object.create(null);
    node[parts.at(-1)] = path;
  }
  const serialize = (value) =>
    typeof value === "string"
      ? `references[${JSON.stringify(value)}]`
      : `{${Object.entries(value)
          .map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`)
          .join(",")}}`;
  await writeFile("flare/_generated/references.ts", flat);
  await writeFile(
    "flare/_generated/api.ts",
    `import {api as references} from "./references";\nexport const api = ${serialize(tree)} as const;\n`,
  );
}

export async function frontendEnvironment(url) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const variable = dependencies.astro
    ? "PUBLIC_FLARE_URL"
    : dependencies.expo
      ? "EXPO_PUBLIC_FLARE_URL"
      : "VITE_FLARE_URL";
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw Error("Invalid environment URL");
  let previous = await readFile(".env.local", "utf8").catch((e) => {
    if (e.code !== "ENOENT") throw e;
    return "";
  });
  const line = variable + "=" + JSON.stringify(parsed.href);
  const pattern = new RegExp("^" + variable + "=.*$", "m");
  const next = pattern.test(previous)
    ? previous.replace(pattern, () => line)
    : previous +
      (previous.endsWith("\n") || !previous ? "" : "\n") +
      line +
      "\n";
  if (next !== previous) await writeFile(".env.local", next, { mode: 0o600 });
}
