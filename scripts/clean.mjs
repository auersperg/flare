import { readdir, rm, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Work only in this repository; never touch Cloudflare or operator credentials.
const root = fileURLToPath(new URL("../", import.meta.url));
for (const path of [
  "artifacts",
  ".wrangler",
  "packages/flare/dist",
  "packages/core/dist",
  "packages/core/dashboard/.astro",
  "packages/core/dashboard/.wrangler",
  "packages/core/dashboard/node_modules/.astro",
  "packages/core/dashboard/node_modules/.vite",
  "node_modules/.vite",
  "node_modules/.vite-temp",
  "packages/core/dashboard/node_modules/.vite-temp",
  "test/node_modules/.vite",
  "packages/core/bootstrap/.flare",
  "tests/fixtures/tasks/.flare",
  "tests/kernel/.wrangler",
]) {
  await rm(resolve(root, path), { recursive: true, force: true });
}
async function removeFinderMetadata(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.name === ".DS_Store" && item.isFile()) await rm(path);
    else if (
      item.isDirectory() &&
      !["node_modules", ".git"].includes(item.name)
    )
      await removeFinderMetadata(path);
  }
}
await removeFinderMetadata(root);
// Remove obsolete empty directories, never an application or CLI connection.
for (const path of ["test/node_modules", "test", ".flare"]) {
  await rmdir(resolve(root, path)).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  });
}
console.log(
  "Generated builds, test reports, caches and Finder metadata removed. Sources and credentials preserved.",
);
