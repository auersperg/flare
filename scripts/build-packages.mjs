import { cp, mkdir, rm } from "node:fs/promises";
await rm("packages/sdk/dist", { recursive: true, force: true });
await mkdir("packages/sdk/dist", { recursive: true });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
for (const name of [
  "client",
  "server",
  "react",
  "protocol",
  "cloudflare",
  "schema",
  "database",
  "backup",
]) {
  const source = await Bun.file(`packages/sdk/src/${name}.ts`).text();
  await Bun.write(
    `packages/sdk/dist/${name}.js`,
    transpiler.transformSync(source),
  );
}
const result = Bun.spawnSync(
  [
    process.execPath,
    "node_modules/typescript/bin/tsc",
    "-p",
    "packages/sdk/tsconfig.build.json",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) process.exit(result.exitCode);
// One distributable package. Internal workspaces are never registry dependencies
// of flared; the portable SDK and the Bun-only CLI have separate entry points.
await rm("packages/flared/dist", { recursive: true, force: true });
await cp("packages/sdk/dist", "packages/flared/dist/sdk", { recursive: true });
const pkg = await Bun.file("packages/flared/package.json").json();
const cli = await Bun.build({
  entrypoints: ["packages/cli/bin/flared.mjs"],
  outdir: "packages/flared/dist/cli",
  target: "bun",
  format: "esm",
  splitting: true,
  env: "disable",
  metafile: true,
  external: Object.keys(pkg.dependencies),
});
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");
if (
  Object.keys(cli.metafile.inputs).some((path) =>
    /packages\/core\/|node_modules\/(agents|wrangler|workerd)\//.test(path),
  )
)
  throw new Error("Platform code entered application CLI");
console.log(
  "Single flared package built: portable SDK/types and separate lazy Bun CLI",
);
