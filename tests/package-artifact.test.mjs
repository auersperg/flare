import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyPackageArtifact } from "../scripts/verify-package-artifact.mjs";

test("release uses exact accepted archive and rejects repacking, failed/stale proofs and unsafe versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "flare-artifact-test-"));
  const pkg = { name: "@auersperg/flare", version: "0.3.4" };
  const bytes = Buffer.from("accepted immutable archive");
  const report = {
    status: "PASS",
    archive: {
      ...pkg,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  const metadata = join(root, "packages/flare/package.json");
  const proof = join(root, "artifacts/package-acceptance.json");
  const archive = join(
    root,
    "artifacts/packages/flare/auersperg-flare-0.3.4.tgz",
  );
  try {
    await mkdir(join(root, "packages/flare"), { recursive: true });
    await mkdir(join(root, "artifacts/packages/flare"), { recursive: true });
    await writeFile(metadata, JSON.stringify(pkg));
    await writeFile(proof, JSON.stringify(report));
    await writeFile(archive, bytes);
    expect((await verifyPackageArtifact(root)).sha256).toBe(
      report.archive.sha256,
    );
    await writeFile(archive, "repacked bytes");
    await expect(verifyPackageArtifact(root)).rejects.toThrow(
      "Archive changed",
    );
    await writeFile(archive, bytes);
    for (const bad of [
      { ...report, status: "FAIL" },
      { ...report, archive: { ...report.archive, version: "0.3.3" } },
      { ...report, archive: { ...report.archive, sha256: "invalid" } },
    ]) {
      await writeFile(proof, JSON.stringify(bad));
      await expect(verifyPackageArtifact(root)).rejects.toThrow(
        "Missing or incompatible",
      );
    }
    await writeFile(proof, JSON.stringify(report));
    await writeFile(
      metadata,
      JSON.stringify({ ...pkg, version: "../../other" }),
    );
    await expect(verifyPackageArtifact(root)).rejects.toThrow(
      "Missing or incompatible",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
