import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = process.cwd(),
  external = await mkdtemp(join(tmpdir(), "flared-package-proof-"));
function run(args, cwd = root) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout;
}
try {
  await mkdir("artifacts/packages/flared", { recursive: true });
  const packages = ["sdk", "cli"].map((name) => {
    const output = JSON.parse(
      run([
        "pack",
        `./packages/${name}`,
        "--json",
        "--pack-destination",
        "artifacts/packages/flared",
      ]),
    );
    const packed = Array.isArray(output) ? output[0] : Object.values(output)[0];
    if (!packed?.filename) throw new Error("npm pack did not return a package");
    assert.equal(packed.name, `@flared/${name}`);
    assert.ok(
      packed.files.every(
        (file) =>
          !/\.private|\.dev\.vars|node_modules|dashboard|kernel-token/.test(
            file.path,
          ),
      ),
    );
    return resolve("artifacts/packages/flared", packed.filename);
  });
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({
      name: "fresh-flared-proof",
      private: true,
      type: "module",
    }),
  );
  run(
    [
      "install",
      "--ignore-scripts",
      ...packages,
      "drizzle-orm@0.45.4",
      "zod@4.6.5",
      "typescript@7.0.2",
      "@types/node@24.10.0",
    ],
    external,
  );
  for (const name of ["sdk", "cli"])
    assert.equal(
      (
        await lstat(join(external, "node_modules/@flared", name))
      ).isSymbolicLink(),
      false,
    );
  const graph = JSON.parse(
    await readFile(join(external, "package-lock.json"), "utf8"),
  );
  for (const path of Object.keys(graph.packages))
    assert.ok(
      !/(?:^|\/)node_modules\/(?:agents|wrangler|workerd|@cloudflare\/vite-plugin|@flared\/platform|@reactive-cloud\/sdk)(?:\/|$)/.test(
        path,
      ),
      `Unexpected core/emulator dependency: ${path}`,
    );
  const help = run(["exec", "--", "flared", "--help"], external);
  assert.ok(help.includes("Flared 0.2") && help.includes("Cloudflare-only"));
  await mkdir(join(external, "drizzle/meta"), { recursive: true });
  await writeFile(
    join(external, "drizzle/meta/_journal.json"),
    JSON.stringify({
      entries: [{ idx: 0, when: 1000, tag: "0000_counter", breakpoints: true }],
    }),
  );
  await writeFile(
    join(external, "drizzle/0000_counter.sql"),
    "CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  );
  await writeFile(
    join(external, "app.ts"),
    `import {defineApp, query, mutation, live, action} from "@flared/sdk/server";
import {integer, sqliteTable} from "drizzle-orm/sqlite-core"; import {sql} from "drizzle-orm"; import {z} from "zod";
const counter = sqliteTable("counter", {id: integer().primaryKey(), value: integer().notNull()});
const get = {auth: "public" as const, input: z.object({}), output: z.number(), handler: ({db}: any) => db.select().from(counter).get()?.value ?? 0};
export default defineApp({tables: {counter}, functions: {get: query(get), watch: live(get), increment: mutation({auth: "public", input: z.object({}), output: z.number(), handler: ({db}) => {db.insert(counter).values({id: 1,value: 1}).onConflictDoUpdate({target: counter.id,set:{value:sql\`\${counter.value}+1\`}}).run(); return db.select().from(counter).get()!.value;}}), echo: action({auth: "public", input: z.object({value: z.number()}), output: z.number(), handler: (_ctx, args) => args.value})}});`,
  );
  run(
    [
      "exec",
      "--",
      "flared",
      "build",
      "--entry",
      "app.ts",
      "--migrations",
      "drizzle",
      "--outdir",
      "release",
    ],
    external,
  );
  const release = JSON.parse(
    await readFile(join(external, "release/release.json"), "utf8"),
  );
  for (const role of ["facet", "action"]) {
    const code = await readFile(join(external, `release/${role}.js`), "utf8");
    assert.equal(
      createHash("sha256").update(code).digest("hex"),
      release.checksums[role],
    );
    assert.ok(!code.includes("modelcontextprotocol"));
  }
  const api = await readFile(join(external, "release/api.ts"), "utf8");
  assert.ok(!api.includes("app.ts"));
  assert.ok(!api.includes("sdk/server"));
  assert.ok(api.includes("@flared/sdk") && !api.includes("@reactive-cloud/"));
  run(
    [
      "exec",
      "--",
      "tsc",
      "--noEmit",
      "--skipLibCheck",
      "--moduleResolution",
      "bundler",
      "--module",
      "esnext",
      "--target",
      "es2022",
      "release/api.ts",
    ],
    external,
  );
  const manifest = JSON.parse(
    await readFile(join(external, "release/manifest.json"), "utf8"),
  );
  assert.equal(Object.keys(manifest.functions).length, 4);
  assert.equal(
    JSON.parse(await readFile(join(external, "release/openapi.json"), "utf8"))
      .openapi,
    "3.1.0",
  );
  // Same input => same content-addressed artifact; never overwrite a prior build.
  run(
    [
      "exec",
      "--",
      "flared",
      "build",
      "--entry",
      "app.ts",
      "--migrations",
      "drizzle",
      "--outdir",
      "release-2",
    ],
    external,
  );
  assert.equal(
    JSON.parse(await readFile(join(external, "release-2/release.json"), "utf8"))
      .hash,
    release.hash,
  );
  // An ephemeral frontend fixture verifies the real tarball SDK; no demo tree is shipped.
  run(
    [
      "install",
      "--ignore-scripts",
      "react@19.3.0",
      "react-dom@19.3.0",
      "astro@7.3.8",
      "@astrojs/react@7.0.1",
    ],
    external,
  );
  await mkdir(join(external, "src/pages"), { recursive: true });
  await mkdir(join(external, "src/components"), { recursive: true });
  await writeFile(
    join(external, "astro.config.mjs"),
    `import {defineConfig} from 'astro/config'; import react from '@astrojs/react';
export default defineConfig({output: 'static', integrations: [react()], vite: {environments: {prerender: {resolve: {noExternal: ['@astrojs/react', 'cookie']}}}}});`,
  );
  await writeFile(
    join(external, "src/pages/index.astro"),
    `---
import App from '../components/App';
---
<html lang="en"><head><title>SDK packaging test</title></head><body><App client:only="react" /></body></html>`,
  );
  await writeFile(
    join(external, "src/components/App.tsx"),
    `import {createClient} from '@flared/sdk'; import {api} from '../../release/api';
const client = createClient({url: 'https://application.example/dev'});
export default function App() { return <button onClick={() => client.call(api.get, {})}>Query</button>; }`,
  );
  run(["exec", "--", "astro", "build"], external);
  for (const file of await readdir(join(external, "dist/_astro")))
    if (file.endsWith(".js")) {
      const code = await readFile(join(external, "dist/_astro", file), "utf8");
      assert(
        !/DEV_SIGNING_KEY|FLARED_DEPLOY_TOKEN|cloudflare:workers|drizzle-orm|modelcontextprotocol/.test(
          code,
        ),
        "Backend or credential capability entered frontend",
      );
    }
  // Empty apps are valid: production project creation must not seed test functions/data.
  await writeFile(
    join(external, "empty.ts"),
    'import {defineApp} from "@flared/sdk/server"; export default defineApp({tables:{}, functions:{}});\n',
  );
  await mkdir(join(external, "empty-drizzle/meta"), { recursive: true });
  await writeFile(
    join(external, "empty-drizzle/meta/_journal.json"),
    JSON.stringify({ entries: [] }),
  );
  run(
    [
      "exec",
      "--",
      "flared",
      "build",
      "--entry",
      "empty.ts",
      "--migrations",
      "empty-drizzle",
      "--outdir",
      "empty-release",
    ],
    external,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(external, "empty-release/manifest.json"), "utf8"),
    ).functions,
    {},
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(external, "empty-release/migrations.json"), "utf8"),
    ).journal.entries,
    [],
  );
  assert.deepEqual(
    await readdir(join(external, ".flared/tmp")),
    [],
    "CLI build left temporary metadata",
  );
  await writeFile(
    join(external, "invalid.ts"),
    'throw new Error("Expected metadata failure"); export default {};\n',
  );
  const failure = spawnSync(
    "npm",
    [
      "exec",
      "--",
      "flared",
      "build",
      "--entry",
      "invalid.ts",
      "--migrations",
      "drizzle",
      "--outdir",
      "failed-release",
    ],
    { cwd: external, encoding: "utf8" },
  );
  // Metadata evaluation failure must clean scratch state and must not change the completed immutable releases.
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr + failure.stdout, /Expected metadata failure/);
  assert.deepEqual(await readdir(join(external, ".flared/tmp")), []);
  const report = {
    status: "PASS",
    runtime: "node",
    node: process.version,
    externalDirectory: external,
    externalDirectoryRemovedAfterSuccess: true,
    symlinks: false,
    packages,
    releaseHash: release.hash,
    tests: [
      "Clean non-workspace tarball installation",
      "Native facet/action compilation",
      "Immutable bundle checksums",
      "Generated API has no backend imports",
      "Generated client TypeScript compiles",
      "OpenAPI 3.1 generated",
      "Identical build content hash",
    ],
    finishedAt: new Date().toISOString(),
  };
  report.tests.push(
    "Ephemeral Astro/React frontend built from packed SDK and generated references",
    "Frontend bundle excludes backend code and platform credentials",
    "Flared package/CLI/generated API naming",
    "Thin dependency graph without core/dashboard/emulator",
    "CLI build leaves no temporary metadata after success or failure",
    "Packaged payload excludes credentials and dashboard",
    "Empty application compiles without demo tables or functions",
  );
  await writeFile(
    "artifacts/package-acceptance.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS: clean packaged SDK/CLI build; external proof workspace removed",
  );
} finally {
  await rm(external, { recursive: true, force: true });
}
