import {
  boundedJson,
  stableJson,
  type Manifest,
} from "../../sdk/src/protocol.js";
import { digest, fail } from "./security.js";
export type ReleaseUpload = {
  release: {
    protocol: 1;
    hash: string;
    compatibilityDate: string;
    checksums: Record<string, string>;
  };
  manifest: Manifest;
  migrations: {
    journal: { entries: { idx: number; when: number; tag: string }[] };
    migrations: Record<string, string>;
  };
  facet: string;
  action: string;
};
export async function validateRelease(bundle: ReleaseUpload) {
  if (
    !bundle ||
    bundle.release?.protocol !== 1 ||
    bundle.release.compatibilityDate !== "2026-10-10" ||
    !bundle.manifest ||
    bundle.manifest.protocol !== 1 ||
    !bundle.manifest.functions ||
    !bundle.migrations?.journal?.entries
  )
    fail("INVALID_RELEASE");
  if (
    bundle.manifest.runtimeAbi !== undefined &&
    ![1, 2].includes(bundle.manifest.runtimeAbi)
  )
    fail("INVALID_RELEASE");
  for (const role of ["facet", "action"] as const) {
    if (
      typeof bundle[role] !== "string" ||
      new TextEncoder().encode(bundle[role]).length > 1048576 ||
      (await digest(bundle[role])) !== bundle.release.checksums[role]
    )
      fail("INVALID_RELEASE");
  }
  for (const field of ["manifest", "migrations"] as const) {
    boundedJson(bundle[field], 1048576);
    if (
      (await digest(stableJson(bundle[field]))) !==
      bundle.release.checksums[field]
    )
      fail("INVALID_RELEASE");
  }
  if (
    (await digest(
      stableJson({
        protocol: 1,
        compatibilityDate: bundle.release.compatibilityDate,
        checksums: bundle.release.checksums,
      }),
    )) !== bundle.release.hash
  )
    fail("INVALID_RELEASE");
  let previous = -1;
  for (const [idx, m] of bundle.migrations.journal.entries.entries()) {
    if (
      m.idx !== idx ||
      !Number.isSafeInteger(m.when) ||
      m.when <= previous ||
      !/^\w+$/.test(m.tag) ||
      typeof bundle.migrations.migrations[
        `m${String(idx).padStart(4, "0")}`
      ] !== "string"
    )
      fail("INVALID_RELEASE");
    previous = m.when;
  }
  return bundle;
}
export function compatibleMigration(
  old: ReleaseUpload | null,
  next: ReleaseUpload,
  production: boolean,
) {
  const entries = old?.migrations.journal.entries ?? [];
  if (next.migrations.journal.entries.length < entries.length)
    fail("INVALID_MIGRATION");
  for (const [i, e] of entries.entries()) {
    const k = `m${String(i).padStart(4, "0")}`;
    if (
      stableJson(e) !== stableJson(next.migrations.journal.entries[i]) ||
      old!.migrations.migrations[k] !== next.migrations.migrations[k]
    )
      fail("INVALID_MIGRATION");
  }
  if (production)
    for (const e of next.migrations.journal.entries.slice(entries.length)) {
      const sql =
        next.migrations.migrations[`m${String(e.idx).padStart(4, "0")}`];
      // Deliberately conservative: production preview accepts only schema additions.
      for (const statement of sql
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean))
        if (
          !/^(CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\b|ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\w+)\s+ADD\s+(?:COLUMN\s+)?)/i.test(
            statement,
          )
        )
          fail("INVALID_MIGRATION");
    }
}
