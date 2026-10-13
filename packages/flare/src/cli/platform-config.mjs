import { readFile } from "node:fs/promises";
import { configurationDigest } from "./platform-release.mjs";

// Operator metadata only. Values remain in native Secrets Store, never the journal.
export function validatePlatformConfig(value = {}) {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["capabilities", "secrets"].includes(k))
  )
    throw Error(
      "Platform config accepts only capabilities and secrets references",
    );
  const capabilities = value.capabilities ?? {},
    secrets = value.secrets ?? [];
  if (!object(capabilities) || !Array.isArray(secrets) || secrets.length > 64)
    throw Error("Invalid platform capabilities/secrets references");
  const bindings = new Set();
  const references = secrets
    .map((r) => {
      if (
        !object(r) ||
        Object.keys(r).sort().join() !== "binding,secret_name,store_id" ||
        !/^APP_SECRET_[A-Z0-9_]{1,64}$/.test(r.binding) ||
        !/^[a-f0-9]{32}$/.test(r.store_id) ||
        typeof r.secret_name !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(r.secret_name) ||
        bindings.has(r.binding)
      )
        throw Error("Invalid or duplicate native Secrets Store reference");
      bindings.add(r.binding);
      return {
        binding: r.binding,
        store_id: r.store_id,
        secret_name: r.secret_name,
      };
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
  const result = {};
  const used = new Set();
  for (const scope of Object.keys(capabilities).sort()) {
    const p = capabilities[scope];
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(dev|prod)$/.test(
        scope,
      ) ||
      !object(p) ||
      Object.keys(p).some((k) => !["outbound", "secrets"].includes(k))
    )
      throw Error("Invalid capability scope");
    const hosts = p.outbound ?? [],
      mapping = p.secrets ?? {};
    if (
      !Array.isArray(hosts) ||
      hosts.length > 20 ||
      !object(mapping) ||
      Object.keys(mapping).length > 16
    )
      throw Error("Capability limits exceeded");
    for (const host of hosts)
      if (
        typeof host !== "string" ||
        host.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
        /\.(localhost|local|internal)$/.test(host)
      )
        throw Error("Only exact public HTTPS hostnames are allowed");
    for (const [name, binding] of Object.entries(mapping)) {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || !bindings.has(binding))
        throw Error(
          "Secret grant must reference an explicit APP_SECRET binding",
        );
      used.add(binding);
    }
    result[scope] = {
      outbound: [...new Set(hosts)].sort(),
      secrets: Object.fromEntries(Object.entries(mapping).sort()),
    };
  }
  if (references.some((r) => !used.has(r.binding)))
    throw Error("Unused secret binding; grant it explicitly or remove it");
  if (JSON.stringify(result).length > 16384)
    throw Error("Capabilities exceed 16 KiB");
  return { capabilities: result, secrets: references };
}
export async function readPlatformConfig(path) {
  const bytes = await readFile(path);
  if (bytes.length > 32768) throw Error("Platform config exceeds 32 KiB");
  return validatePlatformConfig(JSON.parse(bytes));
}

// Keep unknown fields guarded. Only known response metadata is removed; rules
// and ordered arrays are never reordered. No silent acceptance of policy drift.
export function accessConfiguration(app, policies) {
  const {
    created_at: _created,
    updated_at: _updated,
    policies: _embedded,
    ...config
  } = app;
  const clean = policies
    .map(({ created_at: _c, updated_at: _u, ...p }) => p)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { app: config, policies: clean };
}
export async function accessSnapshot(cf, id) {
  const app = await cf.api(`access/apps/${id}`);
  const policies = await cf.list(`access/apps/${id}/policies`);
  return {
    app,
    digest: configurationDigest(accessConfiguration(app, policies)),
  };
}
