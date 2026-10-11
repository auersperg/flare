import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local cleanup removes only reproducible output and preserves operator/application state", async () => {
  const root = await mkdtemp(join(tmpdir(), "flare-clean-"));
  const put = async (path: string, value = "keep") => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), value);
  };
  try {
    await put(
      "scripts/clean.mjs",
      await readFile(new URL("../scripts/clean.mjs", import.meta.url), "utf8"),
    );
    const preserved = [
      ".private/flare-install.json",
      ".private/kernel-token",
      ".private/cloudflare/admin.wrangler.json",
      ".private/cloudflare/runtime.wrangler.json",
      ".flare/project.json",
      "tests/fixtures/tasks/app.ts",
      "node_modules/dependency/index.js",
      ".git/config",
    ];
    for (const path of preserved) await put(path);
    const generated = [
      "artifacts/releases/old.tgz",
      ".wrangler/cache",
      "packages/flare/dist/sdk/index.js",
      "packages/flare/dist/index.js",
      "packages/core/dist/dashboard/index 2.html",
      "packages/core/dashboard/.astro/types.d.ts",
      "test/node_modules/.vite/deps/old.js",
      "node_modules/.vite-temp/old.js",
      ".private/.DS_Store",
      "packages/.DS_Store",
    ];
    for (const path of generated) await put(path);
    // An unrelated application's source makes the legacy directory nonempty.
    await put("test/application.ts");
    const run = () =>
      Bun.spawnSync([process.execPath, "scripts/clean.mjs"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(run().exitCode).toBe(0);
    for (const path of preserved)
      expect(await readFile(join(root, path), "utf8")).toBe("keep");
    expect(await readFile(join(root, "test/application.ts"), "utf8")).toBe(
      "keep",
    );
    for (const path of generated)
      await expect(access(join(root, path))).rejects.toThrow();
    expect(run().exitCode).toBe(0);
    await rm(join(root, "test/application.ts"));
    expect(run().exitCode).toBe(0);
    await expect(access(join(root, "test"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
