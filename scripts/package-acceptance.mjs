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
import { loadPlatformRelease } from "../packages/flare/src/cli/platform-release.mjs";
const root = process.cwd(),
  external = await mkdtemp(join(tmpdir(), "flare-package-proof-"));
function run(args, cwd = root) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout),
    stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(stderr + stdout);
  return stdout;
}
try {
  await mkdir("artifacts/packages/flare", { recursive: true });
  const destination = resolve("artifacts/packages/flare");
  const filename = run(
    ["pm", "pack", "--ignore-scripts", "--quiet", "--destination", destination],
    resolve("packages/flare"),
  ).trim();
  const archive = resolve("packages/flare", filename);
  const files = await new Bun.Archive(await Bun.file(archive).bytes()).files();
  const packed = JSON.parse(await files.get("package/package.json").text());
  assert.equal(packed.name, "@auersperg/flare");
  assert.equal(packed.sideEffects, false);
  assert.equal(packed.private, undefined);
  assert.equal(packed.license, "MIT");
  assert.equal(packed.publishConfig.access, "public");
  assert.equal(packed.publishConfig.tag, "next");
  assert.ok(files.has("package/LICENSE"));
  assert.ok(
    (await files.get("package/LICENSE").text()).includes("MIT License"),
  );
  assert.ok(!files.has("package/index.js"), "Unexpected forwarding wrapper");
  for (const contract of Object.values(packed.exports)) {
    for (const entry of [contract.import, contract.types]) {
      assert.ok(
        files.has("package/" + entry.slice(2)),
        "Missing direct export: " + entry,
      );
    }
  }
  assert.ok(
    files.has("package/" + packed.bin.flare.slice(2)),
    "Missing compiled CLI",
  );
  assert.equal(packed.dependencies["@flare/sdk"], undefined);
  assert.equal(packed.dependencies["@flare/cli"], undefined);
  for (const file of files.keys())
    assert.ok(!/\.private|\.dev\.vars|node_modules|kernel-token/.test(file));
  const packages = [archive];
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({
      name: "fresh-flare-proof",
      private: true,
      type: "module",
      dependencies: { "@auersperg/flare": `file:${archive}` },
      devDependencies: { typescript: "6.0.2", "@types/node": "24.19.2" },
    }),
  );
  run(["install", "--ignore-scripts"], external);
  assert.equal(
    (
      await lstat(join(external, "node_modules/@auersperg/flare"))
    ).isSymbolicLink(),
    false,
  );
  // A fresh directory alone does not prove the package manager used this tarball.
  for (const [path, blob] of files) {
    assert.ok(path.startsWith("package/"), "Unexpected archive root");
    const installed = await readFile(
      join(
        external,
        "node_modules/@auersperg/flare",
        path.slice("package/".length),
      ),
    );
    assert.equal(
      createHash("sha256").update(installed).digest("hex"),
      createHash("sha256")
        .update(new Uint8Array(await blob.arrayBuffer()))
        .digest("hex"),
      `Installed bytes differ from verified archive: ${path}`,
    );
  }
  assert.equal(
    await lstat(join(external, "node_modules/react")).then(
      () => true,
      () => false,
    ),
    false,
    "Non-React application installed an optional framework peer",
  );
  // Inspect the installed tree, independent of the package manager's lockfile format.
  const forbidden = new Set([
    "agents",
    "wrangler",
    "workerd",
    "@cloudflare/vite-plugin",
    "@flare/platform",
    "@flare/sdk",
    "@flare/cli",
    "@reactive-cloud/sdk",
    "drizzle-orm",
    "drizzle-kit",
  ]);
  async function inspectDependencies(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      },
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        await inspectDependencies(path);
        continue;
      }
      const metadata = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      );
      assert.ok(
        !forbidden.has(metadata.name),
        `Unexpected core/emulator dependency: ${metadata.name}`,
      );
      await inspectDependencies(join(path, "node_modules"));
    }
  }
  await inspectDependencies(join(external, "node_modules"));
  const help = run(["--bun", "./node_modules/.bin/flare", "--help"], external);
  assert.ok(
    help.includes(`Flare ${packed.version} trusted-team preview`) &&
      help.includes("Cloudflare-only"),
  );
  const platformPayload = await loadPlatformRelease(
    join(external, "node_modules/@auersperg/flare/dist/platform"),
  );
  assert.equal(platformPayload.manifest.version, packed.version);
  for (const entry of Object.values(packed.exports))
    assert.ok(
      !JSON.stringify(entry).includes("platform/"),
      "Platform payload entered public SDK exports",
    );
  const platformHelp = run(
    ["--bun", "./node_modules/.bin/flare", "platform", "--help"],
    external,
  );
  assert.ok(platformHelp.includes("install|status|update"));
  await writeFile(
    join(external, "mock-account.mjs"),
    `
    import assert from 'node:assert/strict';
    process.env.CLOUDFLARE_API_TOKEN='synthetic-cloudflare-token';
    process.env.FLARE_CONFIG_HOME=${JSON.stringify(join(external, "platform-config"))};
    globalThis.fetch=async(url,init)=>{
      assert.equal(init.method,'GET','Platform dry-run must not issue cloud writes');
      assert.equal(init.headers.authorization,'Bearer synthetic-cloudflare-token');
      const path=new URL(url).pathname.split('/accounts/'+'a'.repeat(32)+'/')[1];
      assert.ok(path,'Unexpected API destination');
      let result;
      if(path==='access/organizations')result={auth_domain:'team.cloudflareaccess.com'};
      else if(path==='workers/subdomain')result={subdomain:'account'};
      else if(path==='r2/buckets')result={buckets:[]};
      else if(['d1/database','queues','access/apps','workers/scripts','workers/domains'].includes(path))result=[];
      else throw Error('Unexpected Cloudflare API path '+path);
      return Response.json({success:true,result});
    };
  `,
  );
  const platformPlan = JSON.parse(
    run(
      [
        "--preload",
        "./mock-account.mjs",
        "./node_modules/@auersperg/flare/dist/cli/flare.js",
        "platform",
        "install",
        "--dry-run",
        "--account",
        "a".repeat(32),
        "--owner",
        "owner@example.test",
      ],
      external,
    ),
  );
  assert.equal(platformPlan.to, packed.version);
  assert.equal(platformPlan.digest, platformPayload.manifest.digest);
  assert.equal(
    await lstat(join(external, "platform-config")).then(
      () => true,
      () => false,
    ),
    false,
  );
  // Portable JS remains usable without Bun or window, independently of CLI.
  const portable = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {createClient, FlareError} from '@auersperg/flare';
    const client = createClient({url:'https://application.example/dev'});
    client.dispose();
    await assert.rejects(client.query({path:'test',kind:'query'},{}), FlareError);
  `,
    ],
    { cwd: external, encoding: "utf8" },
  );
  assert.equal(portable.status, 0, portable.stderr);
  await writeFile(
    join(external, "app.ts"),
    `import {defineApp,defineSchema,defineTable,createFunctions,z} from "@auersperg/flare/server";
const schema=defineSchema({counter:defineTable(z.object({value:z.number()}))});const {query,mutation,action}=createFunctions<typeof schema>();
const get={auth:"public" as const,input:z.object({}),output:z.number(),handler:async({db}:any)=>(await db.query("counter").first())?.value ?? 0};
export default defineApp({schema,functions:{get:query(get),increment:mutation({auth:"public",input:z.object({}),output:z.number(),handler:async({db})=>{const r=await db.query("counter").first();const value=(r?.value ?? 0)+1;if(r)await db.patch("counter",r._id,{value});else await db.insert("counter",{value});return value;}}),echo:action({auth:"public",input:z.object({value:z.number()}),output:z.number(),handler:(_ctx,a)=>a.value})}});`,
  );
  run(
    [
      "--bun",
      "./node_modules/.bin/flare",
      "build",
      "--entry",
      "app.ts",
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
  assert.ok(
    api.includes("flare") &&
      !api.includes("@flare/") &&
      !api.includes("@reactive-cloud/"),
  );
  run(
    [
      "x",
      "--bun",
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
  assert.equal(Object.keys(manifest.functions).length, 3);
  assert.equal(
    JSON.parse(await readFile(join(external, "release/openapi.json"), "utf8"))
      .openapi,
    "3.1.0",
  );
  // Same input => same content-addressed artifact; never overwrite a prior build.
  run(
    [
      "--bun",
      "./node_modules/.bin/flare",
      "build",
      "--entry",
      "app.ts",
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
      "add",
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
    `import {createClient} from '@auersperg/flare'; import {FlareProvider,useQuery} from '@auersperg/flare/react'; import {api} from '../../release/api';
const client = createClient({url: 'https://application.example/dev'});
function Tasks() { const value = useQuery(api.get, {}); return <button onClick={() => client.query(api.get, {})}>{value ?? 'Loading'}</button>; }
export default function App() { return <FlareProvider client={client}><Tasks /></FlareProvider>; }`,
  );
  run(["x", "--bun", "astro", "build"], external);
  for (const file of await readdir(join(external, "dist/_astro")))
    if (file.endsWith(".js")) {
      const code = await readFile(join(external, "dist/_astro", file), "utf8");
      assert(
        !/DEV_SIGNING_KEY|FLARE_DEPLOY_TOKEN|cloudflare:workers|drizzle-orm|modelcontextprotocol|Bun\.|dist\/cli/.test(
          code,
        ),
        "Backend or credential capability entered frontend",
      );
    }
  // Empty apps are valid: production project creation must not seed test functions/data.
  await writeFile(
    join(external, "empty.ts"),
    'import {defineApp} from "@auersperg/flare/server"; export default defineApp({schema:{}, functions:{}});\n',
  );
  run(
    [
      "--bun",
      "./node_modules/.bin/flare",
      "build",
      "--entry",
      "empty.ts",
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
      await readFile(join(external, "empty-release/schema.json"), "utf8"),
    ),
    {},
  );
  assert.deepEqual(
    await readdir(join(external, ".flare/tmp")),
    [],
    "CLI build left temporary metadata",
  );
  await writeFile(
    join(external, "invalid.ts"),
    'throw new Error("Expected metadata failure"); export default {};\n',
  );
  const failure = spawnSync(
    process.execPath,
    [
      "--bun",
      "./node_modules/.bin/flare",
      "build",
      "--entry",
      "invalid.ts",
      "--outdir",
      "failed-release",
    ],
    { cwd: external, encoding: "utf8" },
  );
  // Metadata evaluation failure must clean scratch state and must not change the completed immutable releases.
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr + failure.stdout, /Expected metadata failure/);
  assert.deepEqual(await readdir(join(external, ".flare/tmp")), []);
  // Exercise the installed no-flags dev command, including native schema compilation.
  // Every HTTP call is intercepted: this is a local packaging/flow proof only.
  await mkdir(join(external, "flare"));
  await writeFile(
    join(external, "flare/schema.ts"),
    'import {defineSchema,defineTable,z} from "@auersperg/flare/server"; export default defineSchema({notes:defineTable(z.object({title:z.string()}))});\n',
  );
  await writeFile(
    join(external, "flare/notes.ts"),
    'import {z} from "@auersperg/flare/server"; import {query} from "./_generated/server"; export const list=query({auth:"public",input:z.object({}),output:z.array(z.object({_id:z.string(),_creationTime:z.number(),title:z.string()})),handler:({db})=>db.query("notes").take(100)});\n',
  );
  const project = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    join(external, ".flare/project.json"),
    JSON.stringify({
      platform: "https://package-proof.invalid/control",
      project,
    }),
  );
  await writeFile(
    join(external, "mock-control.mjs"),
    `
    import assert from 'node:assert/strict';
    process.env.FLARE_DEPLOY_TOKEN='package-proof-only';
    const calls=[];
    globalThis.fetch=async (url,options)=>{
      assert.equal(new URL(url).origin,'https://package-proof.invalid');
      calls.push(options.method);
      if(options.method==='GET') return Response.json(new URL(url).pathname.endsWith('/health')?{active:'a'.repeat(64)}:{project:${JSON.stringify(project)}});
      assert.equal(new URL(url).pathname,'/control/api/projects/${project}/dev/deploy');
      const {bundle,expected}=JSON.parse(options.body);
      assert.equal(expected,'a'.repeat(64));
      assert.equal(bundle.manifest.functions['notes/list'].kind,'query');
      assert.equal(bundle.manifest.runtimeAbi,4);
      assert.equal(bundle.schema.notes.document.type,"object");
      return Response.json({url:'https://package-proof.invalid/notes/dev'});
    };
    const log=console.log;
    console.log=(...args)=>{
      log(...args);
      if(String(args[0]).startsWith('Watching application code')) {
        assert.deepEqual(calls,['GET','GET','POST']);
        log('PASS packaged automatic dev (mock control API)');
        process.exit(0);
      }
    };
  `,
  );
  run(
    [
      "--preload",
      "./mock-control.mjs",
      "./node_modules/@auersperg/flare/dist/cli/flare.js",
      "dev",
    ],
    external,
  );
  assert.match(
    await readFile(join(external, "flare/_generated/references.ts"), "utf8"),
    /from "@auersperg\/flare"/,
  );
  run(
    [
      "x",
      "--bun",
      "tsc",
      "--noEmit",
      "--strict",
      "--moduleResolution",
      "bundler",
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--lib",
      "ES2022,DOM",
      "flare/notes.ts",
    ],
    external,
  );
  assert.match(
    await readFile(join(external, ".env.local"), "utf8"),
    /PUBLIC_FLARE_URL=/,
  );
  assert.deepEqual(await readdir(join(external, ".flare/tmp")), []);
  const report = {
    status: "PASS",
    archive: {
      name: packed.name,
      version: packed.version,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      platformDigest: platformPayload.manifest.digest,
    },
    runtime: "bun",
    bun: Bun.version,
    externalDirectory: external,
    externalDirectoryRemovedAfterSuccess: true,
    symlinks: false,
    packages,
    releaseHash: release.hash,
    tests: [
      "One self-contained tarball, no overrides or internal packages",
      "Every installed package file matches the verified archive SHA-256",
      "Platform payload checksums/version verified outside the repository",
      "Packaged platform help and read-only install plan use only an intercepted mock account API",
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
    "No-flags packaged dev: discovery, native schema, public types and env (mock HTTP only)",
    "Non-React install does not pull React",
    "Portable client imported and exercised under Node without Bun/window",
    "Ephemeral Astro/React frontend built from packed SDK and generated references",
    "Frontend bundle excludes backend code and platform credentials",
    "Flare package/CLI/generated API naming",
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
    "PASS: single packaged flare SDK/CLI build (Bun install and runtime); external proof workspace removed",
  );
} finally {
  await rm(external, { recursive: true, force: true });
}
