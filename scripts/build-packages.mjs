import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
await rm("packages/sdk/dist", { recursive: true, force: true });
await mkdir("packages/sdk/dist", { recursive: true });
await build({
  entryPoints: [
    "client",
    "server",
    "react",
    "protocol",
    "cloudflare",
    "read-sql",
  ].map((name) => `packages/sdk/src/${name}.ts`),
  outdir: "packages/sdk/dist",
  bundle: false,
  format: "esm",
  target: "es2022",
  sourcemap: true,
});
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "packages/sdk/tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(
  "SDK JS and declarations built; browser entry does not import backend code",
);
