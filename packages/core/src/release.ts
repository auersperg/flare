import {
  boundedJson,
  stableJson,
  assertPath,
  type Manifest,
} from "../../flare/src/sdk/protocol.js";
import {
  assertSchemaContract,
  type SchemaContract,
} from "../../flare/src/sdk/schema.js";
import { scopeForDeletion } from "./maintenance.js";
import { digest, fail } from "./security.js";
export type ReleaseUpload = {
  release: {
    protocol: 1;
    hash: string;
    compatibilityDate: string;
    checksums: Record<string, string>;
  };
  manifest: Manifest;
  schema: SchemaContract;
  facet: string;
  action: string;
};
export async function validateRelease(bundle: ReleaseUpload) {
  if (
    !bundle ||
    bundle.release?.protocol !== 1 ||
    bundle.release.compatibilityDate !== "2026-10-10" ||
    bundle.manifest?.protocol !== 1 ||
    bundle.manifest.runtimeAbi !== 4 ||
    !bundle.manifest.functions ||
    !bundle.schema
  )
    fail("INVALID_RELEASE");
  try {
    assertSchemaContract(bundle.schema);
  } catch {
    fail("INVALID_SCHEMA");
  }
  if (
    Array.isArray(bundle.manifest.functions) ||
    typeof bundle.manifest.functions !== "object" ||
    Object.keys(bundle.manifest.functions).length > 200
  )
    fail("INVALID_RELEASE");
  for (const [path, fn] of Object.entries(bundle.manifest.functions)) {
    try {
      assertPath(path);
    } catch {
      fail("INVALID_RELEASE");
    }
    if (
      !fn ||
      !["query", "mutation", "action"].includes(fn.kind) ||
      !["public", "required", "internal"].includes(fn.auth) ||
      !fn.input ||
      Array.isArray(fn.input) ||
      typeof fn.input !== "object" ||
      !fn.output ||
      Array.isArray(fn.output) ||
      typeof fn.output !== "object"
    )
      fail("INVALID_RELEASE");
  }
  if (
    !bundle.release.checksums ||
    Object.keys(bundle.release.checksums).sort().join() !==
      "action,facet,manifest,schema"
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
  for (const field of ["manifest", "schema"] as const) {
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
  return bundle;
}
export function compatibleSchema(
  old: ReleaseUpload | null,
  next: ReleaseUpload,
) {
  // Facet activation validates stored documents atomically. There is no historical SQL or legacy ABI.
  if (next.manifest.runtimeAbi !== 4 || (old && old.manifest.runtimeAbi !== 4))
    fail("INVALID_RELEASE");
  try {
    assertSchemaContract(next.schema);
  } catch {
    fail("INVALID_SCHEMA");
  }
}

/** Per-environment immutable builds avoid a shared cross-project GC registry. */
export function buildPrefix(scope: string) {
  return `releases/${scopeForDeletion(scope)}/`;
}
export function buildKey(
  scope: string,
  hash: string,
  role: "facet" | "action",
) {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("INVALID_RELEASE");
  return `${buildPrefix(scope)}${hash}/${role}.js`;
}
