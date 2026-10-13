import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  payloadFiles,
  sha256,
  manifestDigest,
  loadPlatformRelease,
  WRANGLER_VERSION,
} from "../packages/flare/src/cli/platform-release.mjs";

const directory = "packages/flare/dist/platform";
const pkg = JSON.parse(await readFile("packages/flare/package.json", "utf8"));
const core = JSON.parse(await readFile("packages/core/package.json", "utf8"));
if (pkg.version !== core.version)
  throw Error("CLI/core release versions differ");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
for (const path of ["admin.js", "runtime.js", "dashboard"])
  await cp(join("packages/core/dist", path), join(directory, path), {
    recursive: true,
  });
await cp("packages/core/migrations", join(directory, "migrations"), {
  recursive: true,
});
const files = [];
for (const path of await payloadFiles(directory)) {
  const bytes = await readFile(join(directory, path));
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}
const manifest = {
  format: 1,
  version: pkg.version,
  stateFormat: 1,
  protocol: 1,
  runtimeAbi: 4,
  compatibilityDate: "2026-10-10",
  wranglerVersion: WRANGLER_VERSION,
  // Add earlier managed versions only after exercising their upgrade in native/cloud acceptance.
  upgradeFrom: ["0.3.8"],
  files,
};
manifest.digest = manifestDigest(manifest);
await writeFile(
  join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
await loadPlatformRelease(directory);
console.log(
  `Verified platform payload ${manifest.version} (${manifest.digest}) included in the single npm package`,
);
