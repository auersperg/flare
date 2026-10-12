// Two clean checkouts at different absolute paths, one pinned toolchain.
// No cloud auth, generated-output normalization, npm publication or repository rebuild.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPlatformRelease } from "../packages/flare/src/cli/platform-release.mjs";

const root = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "flare-reproducibility-"));
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      CI: "true",
      ASTRO_TELEMETRY_DISABLED: "1",
      WRANGLER_SEND_METRICS: "false",
    },
  });
  if (result.status !== 0)
    throw Error(
      `Reproducible build ${args[0]} failed: ${result.stderr.slice(-2000)}`,
    );
};
try {
  const releases = [];
  for (const name of ["short", "different-absolute-checkout-path"]) {
    const checkout = join(scratch, name);
    await mkdir(checkout);
    for (const path of [
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "scripts",
      "packages",
    ])
      await cp(join(root, path), join(checkout, path), {
        recursive: true,
        filter: (source) =>
          !source
            .slice(root.length + 1)
            .split(/[\\/]/)
            .some((part) =>
              [
                "node_modules",
                "dist",
                ".astro",
                ".wrangler",
                ".flare",
                ".private",
              ].includes(part),
            ),
      });
    run(["install", "--frozen-lockfile", "--ignore-scripts"], checkout);
    run(["run", "build"], checkout);
    releases.push(
      (
        await loadPlatformRelease(
          join(checkout, "packages/flare/dist/platform"),
        )
      ).manifest,
    );
  }
  assert.deepEqual(
    releases[1],
    releases[0],
    "Identical sources produced different platform bytes across checkout paths",
  );
  const current = await loadPlatformRelease(
    join(root, "packages/flare/dist/platform"),
  );
  assert.deepEqual(
    current.manifest,
    releases[0],
    "Workspace payload differs from clean reproducible builds; build from the frozen dependency graph before release",
  );
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(
    "artifacts/platform-reproducibility.json",
    JSON.stringify(
      {
        status: "PASS",
        version: releases[0].version,
        digest: releases[0].digest,
        bun: Bun.version,
        files: releases[0].files.length,
        method:
          "Two isolated frozen-lockfile builds at different absolute paths; complete manifests identical; no output normalization",
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: two independent platform builds are byte-identical (${releases[0].digest})`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
