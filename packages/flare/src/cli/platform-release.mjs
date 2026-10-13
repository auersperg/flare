import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const PLATFORM_FORMAT = 1;
export const WRANGLER_VERSION = "4.150.0";
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const manifestDigest = ({ digest: _digest, ...manifest }) =>
  sha256(JSON.stringify(manifest));

export async function payloadFiles(directory, prefix = "") {
  const files = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix + name;
    const stat = await lstat(join(directory, path));
    if (stat.isSymbolicLink())
      throw Error("Platform payload contains a symlink");
    if (stat.isDirectory())
      files.push(...(await payloadFiles(directory, path + "/")));
    else if (stat.isFile()) files.push(path);
    else throw Error("Unsupported platform payload entry");
  }
  return files;
}

export async function loadPlatformRelease(
  directory = fileURLToPath(new URL("../platform/", import.meta.url)),
) {
  let manifest;
  try {
    const bytes = await readFile(join(directory, "manifest.json"));
    if (bytes.length > 512 * 1024) throw Error("Oversized manifest");
    manifest = JSON.parse(bytes);
  } catch {
    throw Error(
      "Platform payload missing or invalid. Install a complete Flare npm release.",
    );
  }
  if (
    manifest.format !== PLATFORM_FORMAT ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version ?? "") ||
    manifest.protocol !== 1 ||
    manifest.runtimeAbi !== 4 ||
    manifest.stateFormat !== 1 ||
    ![WRANGLER_VERSION, "4.149.0"].includes(manifest.wranglerVersion) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(manifest.compatibilityDate ?? "") ||
    !Array.isArray(manifest.upgradeFrom) ||
    manifest.upgradeFrom.some(
      (version) =>
        !/^\d+\.\d+\.\d+$/.test(version) ||
        Bun.semver.order(version, manifest.version) >= 0,
    ) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 1000 ||
    !/^[a-f0-9]{64}$/.test(manifest.digest ?? "") ||
    manifest.digest !== manifestDigest(manifest)
  )
    throw Error("Unsupported or damaged platform manifest");
  const paths = new Set();
  let size = 0;
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      !/^(?:admin\.js|runtime\.js|(?:dashboard|migrations)\/[a-zA-Z0-9_./-]+)$/.test(
        file.path,
      ) ||
      file.path
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.startsWith(".")) ||
      paths.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 10 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
    )
      throw Error("Unsafe platform payload inventory");
    paths.add(file.path);
    size += file.bytes;
    const stat = await lstat(join(directory, file.path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Unsafe platform payload file");
    const bytes = await readFile(join(directory, file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw Error("Platform payload checksum mismatch: " + file.path);
  }
  if (size > 100 * 1024 * 1024) throw Error("Oversized platform payload");
  for (const path of [
    "admin.js",
    "runtime.js",
    "dashboard/index.html",
    "dashboard/bootstrap/release.json",
    "migrations/0006_platform_installation.sql",
  ])
    if (!paths.has(path)) throw Error("Incomplete platform payload: " + path);
  const actual = (await payloadFiles(directory)).filter(
    (p) => p !== "manifest.json",
  );
  if (actual.length !== paths.size || actual.some((p) => !paths.has(p)))
    throw Error("Unlisted platform payload files");
  return { directory, manifest };
}

export function assertUpgrade(installed, target) {
  if (
    !installed ||
    installed.runtimeAbi !== target.runtimeAbi ||
    installed.protocol !== target.protocol ||
    !/^\d+\.\d+\.\d+$/.test(installed.version ?? "") ||
    !(
      installed.version === target.version ||
      target.upgradeFrom?.includes(installed.version)
    ) ||
    Bun.semver.order(installed.version, target.version) > 0
  )
    throw Error(
      "Unsupported platform upgrade. Downgrades, legacy installs and ABI/protocol changes require a separate migration.",
    );
  if (
    installed.version === target.version &&
    installed.digest !== target.digest
  )
    throw Error(
      "Same platform version has different bytes. Publish a new version; refusing an in-place replacement.",
    );
}

export function configurationDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    return item;
  };
  return sha256(JSON.stringify(canonical(value)));
}
