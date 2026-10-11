import { mkdir, rm } from "node:fs/promises";
const out = "packages/flared/dist";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/sdk`, { recursive: true });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const sourceRoot = "packages/flared/src/sdk";
for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot })) {
  if (file.endsWith(".d.ts")) continue;
  const source = await Bun.file(`${sourceRoot}/${file}`).text();
  await Bun.write(
    `${out}/sdk/${file.replace(/\.ts$/, ".js")}`,
    transpiler.transformSync(source),
  );
}
const result = Bun.spawnSync(
  [
    process.execPath,
    "node_modules/typescript/bin/tsc",
    "-p",
    "packages/flared/tsconfig.build.json",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) process.exit(result.exitCode);
const pkg = await Bun.file("packages/flared/package.json").json();
const cli = await Bun.build({
  entrypoints: ["packages/flared/src/cli/main.mjs"],
  outdir: `${out}/cli`,
  naming: { entry: "flared.js" },
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
  throw Error("Platform code entered application CLI");
console.log(
  "Single flared package built directly: portable SDK/types and lazy Bun CLI",
);
