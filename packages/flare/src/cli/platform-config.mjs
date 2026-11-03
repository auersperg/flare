import { readFile } from "node:fs/promises";
import { configurationDigest } from "./platform-release.mjs";

// Operator metadata only. Values remain in native Secrets Store, never the journal.
export function validatePlatformConfig(value = {}) {
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        !["capabilities", "secrets", "search", "codex", "mcpAuth"].includes(k),
    )
  )
    throw Error(
      "Platform config accepts only capabilities, secrets, search, codex and mcpAuth references",
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
  const search = value.search ?? [];
  if (!Array.isArray(search) || search.length > 64)
    throw Error("Invalid search references");
  const searchNames = new Set(),
    instances = new Set();
  const searchReferences = search
    .map((r) => {
      if (
        !object(r) ||
        Object.keys(r).sort().join() !== "binding,instance_name,scope" ||
        !/^APP_SEARCH_[A-Z0-9_]{1,64}$/.test(r.binding) ||
        typeof r.instance_name !== "string" ||
        r.instance_name.length > 64 ||
        !/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(r.instance_name) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(dev|prod)$/.test(
          r.scope,
        ) ||
        searchNames.has(r.binding) ||
        instances.has(r.instance_name)
      )
        throw Error("Invalid or duplicate native search reference");
      searchNames.add(r.binding);
      instances.add(r.instance_name);
      return {
        binding: r.binding,
        instance_name: r.instance_name,
        scope: r.scope,
      };
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
  const codex = value.codex ?? [];
  if (!Array.isArray(codex) || codex.length > 16)
    throw Error("Invalid Codex references");
  const codexBindings = new Set(),
    codexServices = new Set();
  const codexReferences = codex
    .map((r) => {
      if (
        !object(r) ||
        Object.keys(r).sort().join() !== "binding,scope,service" ||
        !/^APP_CODEX_[A-Z0-9_]{1,64}$/.test(r.binding) ||
        typeof r.service !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.service) ||
        typeof r.scope !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(dev|prod)$/.test(
          r.scope,
        ) ||
        codexBindings.has(r.binding) ||
        codexServices.has(r.service)
      )
        throw Error("Invalid or duplicate Codex runner reference");
      codexBindings.add(r.binding);
      codexServices.add(r.service);
      return { binding: r.binding, service: r.service, scope: r.scope };
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
  const mcpAuth = value.mcpAuth ?? [];
  if (!Array.isArray(mcpAuth) || mcpAuth.length > 16)
    throw Error("Invalid MCP auth references");
  const authNames = new Set(),
    authServices = new Set(),
    authIssuers = new Set();
  const authReferences = mcpAuth
    .map((r) => {
      if (
        !object(r) ||
        Object.keys(r).sort().join() !== "binding,issuer,scope,service" ||
        !/^APP_MCP_AUTH_[A-Z0-9_]{1,64}$/.test(r.binding) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(r.service) ||
        !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(
          r.issuer,
        ) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(dev|prod)$/.test(
          r.scope,
        ) ||
        authNames.has(r.binding) ||
        authServices.has(r.service) ||
        authIssuers.has(r.issuer)
      )
        throw Error("Invalid or duplicate MCP authorization reference");
      authNames.add(r.binding);
      authServices.add(r.service);
      authIssuers.add(r.issuer);
      return {
        binding: r.binding,
        service: r.service,
        issuer: r.issuer,
        scope: r.scope,
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
      Object.keys(p).some(
        (k) =>
          !["outbound", "secrets", "search", "codex", "mcpAuth"].includes(k),
      )
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
    if (
      p.search !== undefined &&
      !searchReferences.some((r) => r.binding === p.search && r.scope === scope)
    )
      throw Error(
        "Search grant must reference an instance owned by this environment",
      );
    if (
      p.codex !== undefined &&
      !codexReferences.some((r) => r.binding === p.codex && r.scope === scope)
    )
      throw Error(
        "Codex grant must reference a runner owned by this environment",
      );
    if (
      p.mcpAuth !== undefined &&
      (!object(p.mcpAuth) ||
        Object.keys(p.mcpAuth).sort().join() !== "binding,issuer" ||
        !authReferences.some(
          (r) =>
            r.binding === p.mcpAuth.binding &&
            r.issuer === p.mcpAuth.issuer &&
            r.scope === scope,
        ))
    )
      throw Error(
        "MCP auth grant must reference its environment's authorization service",
      );
    result[scope] = {
      ...(p.mcpAuth === undefined ? {} : { mcpAuth: { ...p.mcpAuth } }),
      ...(p.codex === undefined ? {} : { codex: p.codex }),
      ...(p.search === undefined ? {} : { search: p.search }),
      outbound: [...new Set(hosts)].sort(),
      secrets: Object.fromEntries(Object.entries(mapping).sort()),
    };
  }
  if (references.some((r) => !used.has(r.binding)))
    throw Error("Unused secret binding; grant it explicitly or remove it");
  if (JSON.stringify(result).length > 16384)
    throw Error("Capabilities exceed 16 KiB");
  return {
    capabilities: result,
    ...(authReferences.length ? { mcpAuth: authReferences } : {}),
    secrets: references,
    ...(codexReferences.length ? { codex: codexReferences } : {}),
    ...(searchReferences.length ? { search: searchReferences } : {}),
  };
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

/** Disable a grant first while retaining its binding for cleanup. Drop the binding only after drain. */
export async function validateSearchTransition(previous, next, inspect) {
  const old = validatePlatformConfig(previous),
    desired = validatePlatformConfig(next);
  for (const ref of old.search ?? []) {
    const retained = desired.search?.find((r) => r.binding === ref.binding);
    if (retained && JSON.stringify(retained) === JSON.stringify(ref)) continue;
    if (old.capabilities[ref.scope]?.search === ref.binding)
      throw Error(
        "Disable the search grant first, keeping its reference for durable cleanup",
      );
    const state = await inspect(ref.scope);
    if (state?.search?.remaining !== 0)
      throw Error(
        "Search cleanup is pending; keep the old binding and retry after cleanup",
      );
  }
}
