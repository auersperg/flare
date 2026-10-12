import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Publish only the bytes installed and exercised by package acceptance.
// No cloud requests, publication, rebuilding or credential discovery.
export async function verifyPackageArtifact(root = process.cwd()) {
  const pkg = JSON.parse(
    await readFile(join(root, "packages/flare/package.json"), "utf8"),
  );
  const report = JSON.parse(
    await readFile(join(root, "artifacts/package-acceptance.json"), "utf8"),
  );
  if (
    pkg.name !== "@auersperg/flare" ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    report.status !== "PASS" ||
    report.archive?.name !== pkg.name ||
    report.archive?.version !== pkg.version ||
    !/^[a-f0-9]{64}$/.test(report.archive?.sha256 ?? "")
  )
    throw Error(
      "Missing or incompatible package acceptance; run bun scripts/package-acceptance.mjs",
    );
  const archive = join(
    root,
    "artifacts/packages/flare",
    `auersperg-flare-${pkg.version}.tgz`,
  );
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  if (sha256 !== report.archive.sha256)
    throw Error(
      "Archive changed after acceptance; refusing publication of untested bytes",
    );
  return { archive: resolve(archive), version: pkg.version, sha256 };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const artifact = await verifyPackageArtifact();
  console.log(
    `PASS: exact accepted archive ${artifact.version} (${artifact.sha256})`,
  );
}
