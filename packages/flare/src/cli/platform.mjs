import { readFile, mkdir, mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { CloudflareAccount, cloudflareToken } from "./cloudflare-account.mjs";
import {
  InstallationStore,
  newInstallation,
  validName,
  settingsDigest,
  configurationDigest,
  validateState,
} from "./platform-state.mjs";
import {
  validatePlatformConfig,
  readPlatformConfig,
  accessSnapshot,
} from "./platform-config.mjs";
import { platformHealth } from "./platform-health.mjs";
import { loadPlatformRelease, assertUpgrade } from "./platform-release.mjs";

const steps = [
  "resources",
  "access",
  "migrations",
  "owner",
  "bootstrap",
  "signing-key",
  "admin",
  "runtime",
  "verify",
];
const publicState = (state, target, row) => ({
  account: state.account,
  installation: state.name,
  id: state.id,
  status: state.operation
    ? "incomplete"
    : state.installed
      ? "installed"
      : "provisioning",
  installed: state.installed,
  target: { version: target.version, digest: target.digest },
  dashboard: "https://" + state.addresses.adminHost,
  runtime: "https://" + state.addresses.runtimeHost,
  operation: state.operation
    ? {
        id: state.operation.id,
        kind: state.operation.kind,
        phase: state.operation.phase,
        completed: state.operation.completed,
      }
    : null,
  lockedUntil: row?.lock_owner ? row.lock_expires : null,
  ownerLogin:
    "Verify owner sign-in in the Access-protected dashboard; the CLI does not impersonate the owner.",
  source: "Installation checkpoint, not a live health check",
});

async function domainSnapshot(cf, name) {
  const domains = (await cf.list("workers/domains"))
    .filter((domain) => domain.service === name)
    .map((domain) => ({
      hostname: domain.hostname,
      enabled: domain.enabled,
      previews: domain.previews_enabled,
      zone: domain.zone_id,
    }));
  domains.sort((a, b) => a.hostname.localeCompare(b.hostname));
  return configurationDigest(domains);
}
async function question(label) {
  if (!process.stdin.isTTY)
    throw Error(
      label + " Supply the corresponding named option in non-interactive mode.",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await prompt.question(label + " ")).trim();
  } finally {
    prompt.close();
  }
}
async function buckets(cf) {
  const result = [];
  let cursor;
  for (let count = 0; count < 100; count++) {
    const response = await cf.request(
      "r2/buckets?per_page=1000" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    const page = response.result;
    if (!Array.isArray(page?.buckets)) throw Error("Unexpected R2 inventory");
    result.push(...page.buckets);
    const next = response.result_info?.cursor;
    if (!next) return result;
    if (typeof next !== "string" || next === cursor)
      throw Error("Invalid R2 pagination");
    cursor = next;
  }
  throw Error("R2 inventory exceeds supported pagination");
}
async function preflight(cf) {
  // These reads verify service activation/read permissions. Cloudflare enforces
  // Paid/Loader and write entitlements at deployment; no subscription is purchased.
  const [
    organization,
    subdomain,
    databases,
    queues,
    r2,
    apps,
    workers,
    domains,
  ] = await Promise.all([
    cf.api("access/organizations"),
    cf.api("workers/subdomain"),
    cf.list("d1/database"),
    cf.list("queues"),
    buckets(cf),
    cf.list("access/apps"),
    cf.list("workers/scripts"),
    cf.list("workers/domains"),
  ]);
  const domain = organization?.auth_domain;
  if (
    typeof domain !== "string" ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)
  )
    throw Error(
      "Configure a Cloudflare Zero Trust organization before installing Flare",
    );
  return {
    issuer: "https://" + domain,
    subdomain: subdomain.subdomain,
    databases,
    queues,
    r2,
    apps,
    workers,
    domains,
  };
}

export function workerConfiguration(state, release, role, bootstrap = false) {
  const { manifest, directory } = release;
  const common = {
    name: state.workers[role].name,
    account_id: state.account,
    main: join(directory, `${role}.js`),
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: !state.addresses.custom,
    preview_urls: false,
    ...(state.addresses.custom
      ? {
          routes: [
            {
              pattern:
                state.addresses[role === "admin" ? "adminHost" : "runtimeHost"],
              custom_domain: true,
            },
          ],
        }
      : {}),
    observability: { enabled: true, head_sampling_rate: 1 },
    limits: { cpu_ms: 1000 },
    vars: {
      RUNTIME_URL: "https://" + state.addresses.runtimeHost,
      DASHBOARD_URL: "https://" + state.addresses.adminHost,
      FLARE_INSTALLATION_ID: state.id,
      FLARE_PLATFORM_PAYLOAD: manifest.digest,
    },
  };
  if (role === "admin")
    return {
      ...common,
      assets: {
        directory: join(directory, "dashboard"),
        binding: "ASSETS",
        run_worker_first: ["/*", "!/_astro/*"],
      },
      d1_databases: [
        {
          binding: "CATALOG",
          database_name: state.resources.catalog.name,
          database_id: state.resources.catalog.id,
          migrations_dir: join(directory, "migrations"),
        },
      ],
      services: [
        {
          binding: "RUNTIME",
          service: state.workers.runtime.name,
          entrypoint: "RuntimeControl",
        },
      ],
      vars: {
        ...common.vars,
        ACCESS_ISSUER: state.access?.issuer ?? "",
        ACCESS_AUD: state.access?.aud ?? "",
      },
    };
  return {
    ...common,
    worker_loaders: [{ binding: "LOADER" }],
    ...(state.config
      ? { secrets_store_secrets: validatePlatformConfig(state.config).secrets }
      : {}),
    durable_objects: {
      bindings: [{ name: "SUPERVISORS", class_name: "EnvironmentSupervisor" }],
    },
    exports: {
      EnvironmentSupervisor: { type: "durable-object", storage: "sqlite" },
    },
    r2_buckets: [
      { binding: "BUNDLES", bucket_name: state.resources.bundles.name },
      { binding: "FILES", bucket_name: state.resources.files.name },
    ],
    queues: {
      producers: [{ binding: "JOBS", queue: state.resources.jobs.name }],
      consumers: [
        {
          queue: state.resources.jobs.name,
          max_batch_size: 10,
          max_concurrency: 4,
          max_batch_timeout: 1,
          max_retries: 3,
          dead_letter_queue: state.resources.dlq.name,
        },
      ],
    },
    ratelimits: [
      {
        name: "RATE_LIMITER",
        namespace_id:
          state.rateLimitNamespace ??
          String(parseInt(state.id.replaceAll("-", "").slice(0, 7), 16)),
        simple: { limit: 600, period: 60 },
      },
    ],
    services: bootstrap
      ? []
      : [
          {
            binding: "ADMIN_API",
            service: state.workers.admin.name,
            entrypoint: "AdminControl",
          },
        ],
    vars: {
      ...common.vars,
      DEV_TOKEN_ISSUER: "https://" + state.addresses.runtimeHost,
      ...(state.config
        ? {
            APP_CAPABILITIES: JSON.stringify(
              validatePlatformConfig(state.config).capabilities,
            ),
          }
        : {}),
    },
  };
}

async function confirm(options, state, plan, ask, log) {
  log(JSON.stringify(plan, null, 2));
  const confirmation =
    options.confirm ??
    (await ask(
      `Workers Paid and activated R2/Zero Trust are required; usage may incur charges. Type account ID ${state.account} to authorize ${options.operation}:`,
    ));
  if (confirmation !== state.account)
    throw Error("Account confirmation required; no cloud changes were made");
}
async function assertAccess(cf, state) {
  const { app, digest } = await accessSnapshot(cf, state.access.id);
  const coversHost =
    app.domain === state.addresses.adminHost ||
    app.destinations?.some(
      (d) => d.type === "public" && d.uri === state.addresses.adminHost,
    );
  if (!coversHost || app.aud !== state.access.aud)
    throw Error(
      "Access identity/host drift; explicit snapshot acceptance cannot change identities",
    );
  const expected = state.access.snapshot;
  if (
    expected &&
    (state.access.snapshotFormat === 2 ? digest : configurationDigest(app)) !==
      expected
  )
    throw Error(
      `Access application/policy drift. Review Cloudflare settings, then explicitly accept snapshot ${digest} using --accept-access; no policies were changed.`,
    );
  // Baseline old installations only after their exact legacy snapshot passes.
  state.access.snapshot = digest;
  state.access.snapshotFormat = 2;
}

async function remoteWorker(cf, name) {
  try {
    return await cf.api(`workers/scripts/${name}/settings`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}
async function supervisorNamespace(cf, state) {
  const settings = await cf.api(
    `workers/scripts/${state.workers.runtime.name}/settings`,
  );
  const binding = settings.bindings?.find(
    (b) => b.name === "SUPERVISORS" && b.type === "durable_object_namespace",
  );
  if (!binding?.namespace_id)
    throw Error("Supervisor namespace could not be verified");
  if (
    state.supervisorNamespace &&
    binding.namespace_id !== state.supervisorNamespace
  )
    throw Error(
      "Supervisor namespace changed; platform update must never replace application storage",
    );
  state.supervisorNamespace = binding.namespace_id;
}
async function assertResources(cf, state, inventory) {
  if (
    !inventory.databases.some(
      (db) =>
        db.uuid === state.resources.catalog.id &&
        db.name === state.resources.catalog.name,
    )
  )
    throw Error(
      "Catalogue was removed or renamed; refusing resource recreation",
    );
  for (const key of ["bundles", "files"])
    if (
      !inventory.r2.some((bucket) => bucket.name === state.resources[key].name)
    )
      throw Error("Missing R2 resource: " + key);
  for (const key of ["jobs", "dlq"])
    if (
      !inventory.queues.some(
        (q) =>
          q.queue_id === state.resources[key].id &&
          q.queue_name === state.resources[key].name,
      )
    )
      throw Error("Queue resource identity changed: " + key);
  if (state.access.issuer !== inventory.issuer)
    throw Error(
      "Zero Trust issuer changed; an explicit configuration migration is required",
    );
  await assertAccess(cf, state);
  if (state.supervisorNamespace) await supervisorNamespace(cf, state);
}
async function assertNoDrift(cf, state) {
  for (const role of ["runtime", "admin"]) {
    const actual = await cf.api(
      `workers/scripts/${state.workers[role].name}/settings`,
    );
    if (
      !state.snapshots[role] ||
      settingsDigest(actual) !== state.snapshots[role] ||
      (await cf.currentVersion(state.workers[role].name)) !==
        state.versions[role]
    )
      throw Error(
        `Remote ${role} configuration/deployment changed outside Flare. Refusing to overwrite it; explicit reconciliation is required.`,
      );
    if (
      (await domainSnapshot(cf, state.workers[role].name)) !==
      state.domainSnapshots?.[role]
    )
      throw Error(
        "Custom domains changed outside Flare; refusing to overwrite their configuration",
      );
    const subdomain = await cf.api(
      `workers/scripts/${state.workers[role].name}/subdomain`,
    );
    if (
      subdomain.enabled !== !state.addresses.custom ||
      subdomain.previews_enabled
    )
      throw Error("Worker endpoint configuration drift; refusing to reset it");
  }
}

async function assertCompletedWorkers(cf, state) {
  for (const role of ["runtime", "admin"]) {
    // The final Runtime replaces the bootstrap version during a fresh install.
    // Its write may have succeeded without an acknowledgement. Let deploy()
    // reconcile that pending step by operation tag instead of treating the
    // expected bootstrap -> final transition as an out-of-band deployment.
    if (
      state.operation.phase === role &&
      !state.operation.completed.includes(role)
    )
      continue;
    const completed =
      state.operation.completed.includes(role) ||
      (role === "runtime" && state.operation.completed.includes("signing-key"));
    if (!completed || !state.versions[role]) continue;
    const actual = await cf.api(
      `workers/scripts/${state.workers[role].name}/settings`,
    );
    if (
      settingsDigest(actual) !== state.snapshots[role] ||
      (await cf.currentVersion(state.workers[role].name)) !==
        state.versions[role]
    )
      throw Error(
        `Completed ${role} deployment changed outside the pending operation; explicit reconciliation is required.`,
      );
    if (
      (await domainSnapshot(cf, state.workers[role].name)) !==
      state.domainSnapshots?.[role]
    )
      throw Error(
        "Completed Worker domains changed outside the pending operation",
      );
  }
}
function migrationInventory(manifest) {
  return manifest.files
    .filter((f) => f.path.startsWith("migrations/"))
    .map((f) => ({
      name: f.path.slice("migrations/".length),
      sha256: f.sha256,
    }));
}
function assertMigrations(installed, target) {
  for (const old of installed.migrations ?? [])
    if (
      !target.some(
        (next) => next.name === old.name && next.sha256 === old.sha256,
      )
    )
      throw Error(
        "Previously applied migration removed or changed. Append a new backward-compatible migration instead.",
      );
}
async function migrationsApplied(cf, state, manifest) {
  const tables = await cf.sql(
    state.resources.catalog.id,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
  );
  if (!tables.results.length) return false;
  const rows = (
    await cf.sql(state.resources.catalog.id, "SELECT name FROM d1_migrations")
  ).results;
  return migrationInventory(manifest).every((f) =>
    rows.some((row) => row.name === f.name),
  );
}

async function ensureResources(cf, state, store, inventory) {
  if (!state.addresses.custom && !inventory.subdomain) {
    state.operation.pendingResource = "subdomain";
    await store.save(state);
    await cf.api(
      "workers/subdomain",
      { subdomain: state.addresses.subdomain },
      "PUT",
    );
    if (
      (await cf.api("workers/subdomain")).subdomain !==
      state.addresses.subdomain
    )
      throw Error("workers.dev subdomain setup was not confirmed");
  } else if (
    !state.addresses.custom &&
    inventory.subdomain !== state.addresses.subdomain
  )
    throw Error(
      "Account workers.dev subdomain changed; refusing to silently change installation URLs",
    );
  for (const key of ["bundles", "files", "dlq", "jobs"]) {
    const resource = state.resources[key];
    const isBucket = key === "bundles" || key === "files";
    const list = isBucket ? await buckets(cf) : await cf.list("queues");
    let actual = list.find(
      (r) => (isBucket ? r.name : r.queue_name) === resource.name,
    );
    if (actual && !resource.id && state.operation.pendingResource !== key)
      throw Error(
        "Resource already exists without a creation checkpoint; refusing implicit adoption: " +
          key,
      );
    if (!actual) {
      if (resource.id)
        throw Error("Previously created resource is missing: " + key);
      state.operation.pendingResource = key;
      await store.save(state);
      actual = await cf.api(
        isBucket ? "r2/buckets" : "queues",
        isBucket ? { name: resource.name } : { queue_name: resource.name },
      );
    }
    const id = isBucket ? actual.name : actual.queue_id;
    if (!id || (resource.id && resource.id !== id))
      throw Error("Resource identity mismatch: " + key);
    resource.id = id;
    state.operation.pendingResource = null;
    await store.save(state);
  }
}
async function ensureAccess(cf, state, store, inventory) {
  if (state.access) {
    await assertAccess(cf, state);
    return;
  }
  const name = `Flare ${state.id}`;
  let app = (await cf.list("access/apps")).find(
    (app) => app.name === name && app.domain === state.addresses.adminHost,
  );
  if (app && state.operation.pendingResource !== "access")
    throw Error("Access app exists without a creation checkpoint");
  if (!app) {
    state.operation.pendingResource = "access";
    await store.save(state);
    app = await cf.api("access/apps", {
      name,
      type: "self_hosted",
      domain: state.addresses.adminHost,
      session_duration: "8h",
      policies: [
        {
          name: "Flare owner",
          decision: "allow",
          include: [{ email: { email: state.owner } }],
        },
      ],
    });
  }
  if (
    !/^[a-f0-9-]{36}$/.test(app.id ?? "") ||
    !/^[a-f0-9]{64}$/.test(app.aud ?? "")
  )
    throw Error("Access app identity could not be verified");
  state.access = { id: app.id, aud: app.aud, issuer: inventory.issuer };
  state.operation.pendingResource = null;
  await store.save(state);
}
async function verify(cf, state, release, fetcher, wait) {
  await assertAccess(cf, state);
  await supervisorNamespace(cf, state);
  let healthy = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetcher(
        `https://${state.addresses.runtimeHost}/health?ready=1`,
        { redirect: "error", signal: AbortSignal.timeout(15000) },
      );
      const data = await response.json();
      healthy =
        response.ok &&
        data.readiness === "control-plane-ready" &&
        data.version === release.manifest.version &&
        data.installationId === state.id &&
        data.platformPayload === release.manifest.digest &&
        data.runtimeAbi === 4 &&
        data.protocol === 1;
    } catch {
      /* Eventual route propagation; no mutation retry. */
    }
    if (healthy) break;
    if (attempt < 4) await wait(2000);
  }
  if (!healthy)
    throw Error(
      "Runtime health does not match the installed platform payload; operation remains resumable",
    );
  for (const path of ["/", "/api/session"]) {
    const response = await fetcher(
      `https://${state.addresses.adminHost}${path}`,
      { redirect: "manual", signal: AbortSignal.timeout(15000) },
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = new URL(
        response.headers.get("location") ?? "",
        `https://${state.addresses.adminHost}`,
      );
      if (destination.origin !== state.access.issuer)
        throw Error(
          "Dashboard does not redirect to the expected Access issuer",
        );
    } else if (![401, 403].includes(response.status))
      throw Error("Unauthenticated dashboard is not verified closed");
  }
  for (const role of ["runtime", "admin"]) {
    const endpoint = await cf.api(
      `workers/scripts/${state.workers[role].name}/subdomain`,
    );
    if (
      endpoint.enabled !== !state.addresses.custom ||
      endpoint.previews_enabled
    )
      throw Error("Unexpected alternate Worker endpoints");
    if (state.addresses.custom) {
      const domains = await cf.list("workers/domains");
      const host =
        state.addresses[role === "runtime" ? "runtimeHost" : "adminHost"];
      if (
        !domains.some(
          (domain) =>
            domain.hostname === host &&
            domain.service === state.workers[role].name &&
            domain.enabled === true &&
            domain.previews_enabled === false,
        )
      )
        throw Error(
          "Custom-domain routing was not confirmed; operation remains incomplete",
        );
    }
  }
}

// A deliberately narrow migration for the original documented operator layout.
// No name guessing, resource creation, config import, policy edits or secret reads.
async function discoverOperator(cf, store, name) {
  if (name !== "default")
    throw Error("Operator adoption supports only --name default");
  const databases = await cf.list("d1/database");
  const matches = databases.filter((db) => db.name === "flare-catalog");
  if (
    matches.length !== 1 ||
    databases.some((db) => db.name === "flare-default-catalog")
  )
    throw Error(
      "Expected one legacy flare-catalog and no competing default catalogue",
    );
  const row = await store.row(matches[0].uuid);
  const state = row?.state ?? (await store.local());
  if (
    state &&
    (state.origin !== "operator" ||
      state.resources.catalog.id !== matches[0].uuid)
  )
    throw Error("Catalogue/cache is owned by a different installation");
  if (row) store.revision = row.revision;
  return { state, row };
}

async function prepareOperator(cf, inventory, release, options, dependencies) {
  const owner = options.owner?.toLowerCase();
  if (!owner || !/^\S+@\S+\.\S+$/.test(owner))
    throw Error("Explicit --owner is required for adoption");
  const database = inventory.databases.find(
    (db) => db.name === "flare-catalog",
  );
  const member = (
    await cf.sql(database.uuid, "SELECT role FROM members WHERE email=?", [
      owner,
    ])
  ).results[0];
  if (member?.role !== "owner")
    throw Error(
      "Existing owner membership does not match; roles are never rewritten",
    );
  const state = {
    format: 1,
    origin: "operator",
    id: randomUUID(),
    account: cf.account,
    name: "default",
    owner,
    resources: {
      catalog: { name: "flare-catalog", id: database.uuid },
      bundles: { name: "flare-builds", id: "flare-builds" },
      files: { name: "flare-files", id: "flare-files" },
      jobs: { name: "flare-jobs", id: null },
      dlq: { name: "flare-jobs-dlq", id: null },
    },
    workers: {
      runtime: { name: "flare-runtime" },
      admin: { name: "flare-admin" },
    },
    addresses: { custom: true, subdomain: inventory.subdomain },
    access: null,
    installed: null,
    operation: null,
    snapshots: {},
    versions: {},
    domainSnapshots: {},
    createdAt: Date.now(),
  };
  const remote = {};
  for (const role of ["runtime", "admin"]) {
    remote[role] = await cf.api(`workers/scripts/flare-${role}/settings`);
    state.versions[role] = await cf.currentVersion(`flare-${role}`);
    state.snapshots[role] = settingsDigest(remote[role]);
    state.domainSnapshots[role] = await domainSnapshot(cf, `flare-${role}`);
    const endpoint = await cf.api(`workers/scripts/flare-${role}/subdomain`);
    if (endpoint.enabled || endpoint.previews_enabled)
      throw Error(
        "Adoption requires custom domains with alternate endpoints disabled",
      );
    if (
      remote[role].logpush ||
      remote[role].tail_consumers?.length ||
      remote[role].tags?.length ||
      Object.keys(remote[role].placement ?? {}).length ||
      remote[role].limits?.cpu_ms !== 1000 ||
      Object.keys(remote[role].limits ?? {}).some((key) => key !== "cpu_ms") ||
      remote[role].observability?.enabled !== true ||
      remote[role].observability?.head_sampling_rate !== 1 ||
      remote[role].observability?.traces?.enabled === true ||
      remote[role].observability?.logs?.enabled === false ||
      remote[role].observability?.logs?.invocation_logs === false ||
      remote[role].observability?.logs?.persist === false ||
      remote[role].observability?.redact_query_string === true ||
      remote[role].compatibility_flags?.join() !== "nodejs_compat"
    )
      throw Error(
        "Unsupported operator Worker configuration; adoption does not silently reconcile custom settings",
      );
  }
  const binding = (role, name, type) => {
    const matches = remote[role].bindings?.filter(
      (b) => b.name === name && b.type === type,
    );
    if (matches?.length !== 1)
      throw Error(`Missing or ambiguous ${role} binding ${name}`);
    return matches[0];
  };
  const allowed = {
    runtime: [
      "ADMIN_API",
      "BUNDLES",
      "FILES",
      "JOBS",
      "LOADER",
      "RATE_LIMITER",
      "SUPERVISORS",
      "DEV_SIGNING_KEY",
      "RUNTIME_URL",
      "DASHBOARD_URL",
      "DEV_TOKEN_ISSUER",
    ],
    admin: [
      "RUNTIME",
      "CATALOG",
      "ASSETS",
      "RUNTIME_URL",
      "DASHBOARD_URL",
      "ACCESS_ISSUER",
      "ACCESS_AUD",
    ],
  };
  for (const role of ["runtime", "admin"])
    if (
      remote[role].bindings.length !== allowed[role].length ||
      remote[role].bindings.some((b) => !allowed[role].includes(b.name))
    )
      throw Error(
        "Unsupported extra bindings; adoption must not remove operator capabilities",
      );
  const runtimeUrl = binding("runtime", "RUNTIME_URL", "plain_text").text;
  const dashboardUrl = binding("admin", "DASHBOARD_URL", "plain_text").text;
  for (const value of [runtimeUrl, dashboardUrl]) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== "https:")
      throw Error("Operator URL must be a plain HTTPS origin");
  }
  state.addresses.runtimeHost = new URL(runtimeUrl).hostname;
  state.addresses.adminHost = new URL(dashboardUrl).hostname;
  if (
    binding("admin", "RUNTIME_URL", "plain_text").text !== runtimeUrl ||
    binding("runtime", "DASHBOARD_URL", "plain_text").text !== dashboardUrl ||
    binding("runtime", "DEV_TOKEN_ISSUER", "plain_text").text !== runtimeUrl
  )
    throw Error(
      "Operator URLs/identity issuer do not match; refusing identity migration",
    );
  for (const role of ["runtime", "admin"]) {
    const own = inventory.domains.filter((d) => d.service === `flare-${role}`);
    if (
      own.length !== 1 ||
      own[0].hostname !==
        state.addresses[role === "runtime" ? "runtimeHost" : "adminHost"] ||
      !own[0].enabled ||
      own[0].previews_enabled
    )
      throw Error("Operator custom domain does not match binding URL");
  }
  if (
    binding("admin", "CATALOG", "d1").id !== database.uuid &&
    binding("admin", "CATALOG", "d1").database_id !== database.uuid
  )
    throw Error("Admin catalogue binding mismatch");
  for (const [role, key, target, entrypoint] of [
    ["admin", "RUNTIME", "flare-runtime", "RuntimeControl"],
    ["runtime", "ADMIN_API", "flare-admin", "AdminControl"],
  ]) {
    const b = binding(role, key, "service");
    if (
      b.service !== target ||
      b.entrypoint !== entrypoint ||
      (b.environment && b.environment !== "production")
    )
      throw Error("Operator service binding mismatch");
  }
  for (const [key, bucket] of [
    ["BUNDLES", "flare-builds"],
    ["FILES", "flare-files"],
  ])
    if (binding("runtime", key, "r2_bucket").bucket_name !== bucket)
      throw Error("Operator R2 binding mismatch");
  if (binding("runtime", "JOBS", "queue").queue_name !== "flare-jobs")
    throw Error("Operator Queue binding mismatch");
  binding("runtime", "LOADER", "worker_loader");
  binding("runtime", "DEV_SIGNING_KEY", "secret_text");
  binding("admin", "ASSETS", "assets");
  const supervisor = binding(
    "runtime",
    "SUPERVISORS",
    "durable_object_namespace",
  );
  if (
    supervisor.class_name !== "EnvironmentSupervisor" ||
    supervisor.script_name
  )
    throw Error("Operator supervisor must be owned by Runtime");
  state.supervisorNamespace = supervisor.namespace_id;
  const rate = binding("runtime", "RATE_LIMITER", "ratelimit");
  if (rate.simple?.limit !== 600 || rate.simple?.period !== 60)
    throw Error("Unsupported operator rate-limit configuration");
  state.rateLimitNamespace = String(rate.namespace_id);
  const aud = binding("admin", "ACCESS_AUD", "plain_text").text;
  const app = inventory.apps.find((a) => a.aud === aud);
  if (
    !app ||
    binding("admin", "ACCESS_ISSUER", "plain_text").text !== inventory.issuer
  )
    throw Error("Access application/issuer mismatch");
  const access = await cf.api(`access/apps/${app.id}`);
  state.access = {
    id: app.id,
    aud,
    issuer: inventory.issuer,
    snapshot: configurationDigest(access),
  };
  for (const key of ["jobs", "dlq"]) {
    const q = inventory.queues.find(
      (q) => q.queue_name === state.resources[key].name,
    );
    if (!q) throw Error("Operator queue is missing");
    state.resources[key].id = q.queue_id;
  }
  validateState(state, cf.account, "default");
  await assertResources(cf, state, inventory);
  const migrations = (
    await cf.sql(database.uuid, "SELECT name FROM d1_migrations")
  ).results;
  if (
    migrations.some(
      (m) =>
        !migrationInventory(release.manifest).some((f) => f.name === m.name),
    )
  )
    throw Error(
      "Operator has unknown migrations; an explicit compatibility review is required",
    );
  const response = await (dependencies.fetch ?? globalThis.fetch)(
    runtimeUrl + "/health",
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  const health = await response.json();
  if (
    !response.ok ||
    health.protocol !== release.manifest.protocol ||
    health.runtimeAbi !== release.manifest.runtimeAbi ||
    ![release.manifest.version, ...release.manifest.upgradeFrom].includes(
      health.version,
    )
  )
    throw Error(
      "Operator runtime version/ABI is not an admitted adoption source",
    );
  state.adoptedFrom = { version: health.version, at: Date.now() };
  return state;
}

export async function platform(options, dependencies = {}) {
  const source = dependencies.release ?? (await loadPlatformRelease());
  const scratch = await mkdtemp(join(tmpdir(), "flare-platform-payload-"));
  try {
    for (const file of [...source.manifest.files, { path: "manifest.json" }]) {
      const destination = join(scratch, file.path);
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(join(source.directory, file.path), destination);
    }
    const release = await loadPlatformRelease(scratch);
    return await runPlatform(options, { ...dependencies, release });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runPlatform(options, dependencies = {}) {
  const operation = options.operation;
  if (!["install", "status", "update", "adopt"].includes(operation))
    throw Error(
      "Supported: flare platform install|status|update|adopt; no deployment has occurred.",
    );
  const name = options.name ?? "default";
  if (!validName(name))
    throw Error(
      "Installation --name must be 1–20 lowercase letters, digits or hyphens, starting with a letter",
    );
  const release = dependencies.release ?? (await loadPlatformRelease());
  const log = dependencies.log ?? ((message) => console.error(message));
  const ask = dependencies.question ?? question;
  let account = options.account;
  let cf = dependencies.cf;
  if (!cf) {
    const token = await cloudflareToken();
    if (!account) {
      const reader = new CloudflareAccount("0".repeat(32), token);
      // The Accounts API caps pages at 50 (other inventories permit 100).
      const accounts = await reader.list("accounts", {
        global: true,
        perPage: 50,
      });
      if (!Array.isArray(accounts) || !accounts.length)
        throw Error("No accessible Cloudflare accounts");
      if (accounts.length === 1) account = accounts[0].id;
      else {
        log(accounts.map((a) => `${a.id}: ${a.name}`).join("\n"));
        account = await ask("Cloudflare account ID:");
      }
    }
    cf = new CloudflareAccount(account, token);
  }
  account ??= cf.account;
  if (cf.account !== account) throw Error("Cloudflare account mismatch");
  const store = new InstallationStore(cf, name, dependencies.storeOptions);
  const adoption = operation === "adopt";
  const discovered = adoption
    ? await discoverOperator(cf, store, name)
    : await store.discover();
  let state = discovered.state;
  if (operation === "status")
    return state
      ? {
          ...publicState(state, release.manifest, discovered.row),
          health: await platformHealth(
            cf,
            state,
            dependencies.fetch ?? globalThis.fetch,
          ),
        }
      : {
          account,
          installation: name,
          status: "not-installed",
          target: release.manifest.version,
        };
  const requestedConfig = options.config
    ? await readPlatformConfig(options.config)
    : null;
  const inventory = await preflight(cf);
  if (adoption && !state)
    state = await prepareOperator(
      cf,
      inventory,
      release,
      options,
      dependencies,
    );
  if (state) {
    if (
      (options.owner && options.owner.toLowerCase() !== state.owner) ||
      (options["dashboard-host"] &&
        options["dashboard-host"] !== state.addresses.adminHost) ||
      (options["runtime-host"] &&
        options["runtime-host"] !== state.addresses.runtimeHost) ||
      (options.subdomain && options.subdomain !== state.addresses.subdomain)
    )
      throw Error(
        "Existing installation identity cannot be changed by install/update",
      );
  } else {
    if (operation !== "install")
      throw Error("No managed installation; run flare platform install first");
    state = newInstallation({
      account,
      name,
      owner: options.owner ?? (await ask("Dashboard owner email:")),
      subdomain: options.subdomain ?? inventory.subdomain,
      adminHost: options["dashboard-host"],
      runtimeHost: options["runtime-host"],
    });
  }
  const configChanged =
    requestedConfig &&
    configurationDigest(requestedConfig) !==
      configurationDigest(validatePlatformConfig(state.config));
  if (
    state.operation &&
    requestedConfig &&
    configurationDigest(requestedConfig) !== state.operation.configDigest
  )
    throw Error(
      "Pending config differs; resume with the original config or omit --config",
    );
  let accessChanged = false;
  if (options["accept-access"]) {
    if (
      !/^[a-f0-9]{64}$/.test(options["accept-access"]) ||
      operation !== "update" ||
      state.operation
    )
      throw Error(
        "Access snapshot acceptance requires an idle managed update and exact SHA256",
      );
    const actual = await accessSnapshot(cf, state.access.id);
    if (actual.digest !== options["accept-access"])
      throw Error(
        "Access changed since review; read platform status and review the new snapshot",
      );
    accessChanged =
      state.access.snapshotFormat !== 2 ||
      state.access.snapshot !== actual.digest;
    state.access.snapshot = actual.digest;
    state.access.snapshotFormat = 2;
  }
  if (
    state.operation &&
    (state.operation.kind !== operation ||
      state.operation.targetDigest !== release.manifest.digest)
  )
    throw Error(
      "A different platform operation is incomplete. Resume it with the original CLI release before changing versions.",
    );
  if (state.installed) {
    assertUpgrade(state.installed, release.manifest);
    assertMigrations(state.installed, migrationInventory(release.manifest));
    if (!state.operation) {
      await assertResources(cf, state, inventory);
      await assertNoDrift(cf, state);
      if (
        state.installed.digest === release.manifest.digest &&
        !configChanged &&
        !accessChanged
      )
        return { ...publicState(state, release.manifest), unchanged: true };
      if (operation === "install" || adoption)
        throw Error(
          "Already installed. Use flare platform update to change the platform version",
        );
    }
  } else if (operation !== "install" && !adoption)
    throw Error(
      "Installation is incomplete; resume platform install with the original release",
    );
  const plan = {
    account,
    installation: name,
    operation,
    from: state.installed?.version ?? state.adoptedFrom?.version ?? null,
    to: release.manifest.version,
    digest: release.manifest.digest,
    configuration: requestedConfig ?? state.config ?? null,
    acceptedAccessSnapshot: accessChanged ? state.access.snapshot : null,
    dashboard: "https://" + state.addresses.adminHost,
    runtime: "https://" + state.addresses.runtimeHost,
    steps:
      state.installed || adoption
        ? ["migrations", "runtime", "admin", "verify"]
        : steps,
    preserve: [
      "Workers and DO namespace identities",
      "projects/dev/prod",
      "application releases/data/files/auth",
      "signing secrets",
      "existing Access policies",
    ],
    requiredPlan:
      "Workers Paid; billing and write entitlements are not auto-enabled",
    rollback:
      "No automatic data rollback or downgrade. Interrupted operations resume from checkpoints.",
  };
  if (state.addresses.custom)
    for (const role of ["admin", "runtime"]) {
      const host =
        state.addresses[role === "admin" ? "adminHost" : "runtimeHost"];
      if (
        inventory.domains.some(
          (domain) =>
            domain.hostname === host &&
            domain.service !== state.workers[role].name,
        )
      )
        throw Error(
          "Custom domain is owned by another Worker; refusing to replace its route",
        );
    }
  if (options["dry-run"]) return plan;
  await confirm(options, state, plan, ask, log);
  if (!state.operation && requestedConfig) state.config = requestedConfig;
  state.operation ??= {
    id: randomUUID(),
    kind: operation,
    targetDigest: release.manifest.digest,
    configDigest: configurationDigest(validatePlatformConfig(state.config)),
    completed: [],
    phase: "catalog",
    previousVersions: { ...state.versions },
    startedAt: Date.now(),
  };
  if (!state.resources.catalog.id) {
    const existing = inventory.databases.find(
      (db) => db.name === state.resources.catalog.name,
    );
    if (existing && !discovered.state)
      throw Error(
        "Catalogue name is already in use; refusing implicit adoption",
      );
    await store.cache(state);
    const database =
      existing ??
      (await cf.api("d1/database", { name: state.resources.catalog.name }));
    state.resources.catalog.id = database.uuid;
    await store.cache(state);
  }
  if (!discovered.row) {
    if (!adoption) {
      const tables = (
        await cf.sql(
          state.resources.catalog.id,
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('flare_installation','d1_migrations')",
        )
      ).results;
      if (tables.length)
        throw Error(
          "Unmanaged catalogue contains tables; refusing to claim existing data",
        );
    } else {
      await assertResources(cf, state, inventory);
      await assertNoDrift(cf, state);
    }
    await store.initialize(
      state,
      await readFile(
        join(release.directory, "migrations/0006_platform_installation.sql"),
        "utf8",
      ),
    );
  }
  await store.acquire(state, options.resume === true);
  const scratch = await mkdtemp(join(tmpdir(), "flare-platform-"));
  const configuration = async (role, bootstrap = false) => {
    const path = join(scratch, `${role}${bootstrap ? "-bootstrap" : ""}.json`);
    await writeFile(
      path,
      JSON.stringify(
        workerConfiguration(state, release, role, bootstrap),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return path;
  };
  const checkpoint = async (phase, work) => {
    if (state.operation.completed.includes(phase)) return;
    state.operation.phase = phase;
    await store.save(state);
    log(`Flare platform: ${phase}`);
    await work();
    state.operation.completed.push(phase);
    await store.save(state);
  };
  const deploy = async (role, bootstrap = false) => {
    const worker = state.workers[role].name;
    const tag = `flare-${state.id.slice(0, 8)}-${state.operation.id.slice(0, 8)}-${bootstrap ? "boot" : role}-${release.manifest.digest.slice(0, 12)}`;
    const existing = await remoteWorker(cf, worker);
    if (existing) {
      const current = await cf.currentVersion(worker);
      if ((await cf.versionTag(worker, current)) === tag) {
        state.versions[role] = current;
        state.snapshots[role] = settingsDigest(existing);
        state.domainSnapshots ??= {};
        state.domainSnapshots[role] = await domainSnapshot(cf, worker);
        if (role === "runtime") await supervisorNamespace(cf, state);
        return;
      }
      if (
        !state.versions[role] ||
        current !== state.versions[role] ||
        (state.snapshots[role] &&
          settingsDigest(existing) !== state.snapshots[role]) ||
        (state.domainSnapshots?.[role] &&
          (await domainSnapshot(cf, worker)) !== state.domainSnapshots[role])
      )
        throw Error(
          "Worker changed outside the pending operation; refusing deployment: " +
            role,
        );
    } else if (state.versions[role])
      throw Error("Previously deployed Worker is missing; refusing recreation");
    let secretsFile;
    if (bootstrap && !existing) {
      secretsFile = join(scratch, "bootstrap-secrets.json");
      await writeFile(
        secretsFile,
        JSON.stringify({ DEV_SIGNING_KEY: randomBytes(48).toString("hex") }),
        { mode: 0o600 },
      );
    }
    await cf.deploy(await configuration(role, bootstrap), {
      tag,
      message: `Flare ${state.id} ${state.operation.id} ${release.manifest.digest}`,
      cwd: scratch,
      secretsFile,
    });
    const id = await cf.currentVersion(worker);
    if ((await cf.versionTag(worker, id)) !== tag)
      throw Error(
        "Deployment version could not be attributed to this operation",
      );
    state.versions[role] = id;
    state.snapshots[role] = settingsDigest(
      await cf.api(`workers/scripts/${worker}/settings`),
    );
    state.domainSnapshots ??= {};
    state.domainSnapshots[role] = await domainSnapshot(cf, worker);
    if (role === "runtime") await supervisorNamespace(cf, state);
  };
  try {
    if (!state.installed && !adoption) {
      await checkpoint("resources", () =>
        ensureResources(cf, state, store, inventory),
      );
      await checkpoint("access", () =>
        ensureAccess(cf, state, store, inventory),
      );
    }
    await assertResources(cf, state, await preflight(cf));
    await assertCompletedWorkers(cf, state);
    await checkpoint("migrations", async () => {
      if (!(await migrationsApplied(cf, state, release.manifest)))
        await cf.migrations(
          await configuration("admin"),
          state.resources.catalog.name,
          scratch,
        );
      if (!(await migrationsApplied(cf, state, release.manifest)))
        throw Error("D1 migrations did not finish");
    });
    if (!state.installed && !adoption) {
      await checkpoint("owner", async () => {
        await cf.sql(
          state.resources.catalog.id,
          "INSERT OR IGNORE INTO members(email,role) VALUES(?,?)",
          [state.owner, "owner"],
        );
        const row = (
          await cf.sql(
            state.resources.catalog.id,
            "SELECT role FROM members WHERE email=?",
            [state.owner],
          )
        ).results[0];
        if (row?.role !== "owner")
          throw Error(
            "Owner membership was not verified; existing member roles were not overwritten",
          );
      });
      await checkpoint("bootstrap", () => deploy("runtime", true));
      await checkpoint("signing-key", async () => {
        const secrets = await cf.api(
          `workers/scripts/${state.workers.runtime.name}/secrets`,
        );
        if (!secrets.some((s) => s.name === "DEV_SIGNING_KEY"))
          throw Error(
            "Bootstrap signing secret is missing; refusing to rotate or recreate credentials implicitly",
          );
        if (
          !(
            await cf.api(
              `workers/scripts/${state.workers.runtime.name}/secrets`,
            )
          ).some((s) => s.name === "DEV_SIGNING_KEY")
        )
          throw Error("Signing secret was not confirmed");
        state.versions.runtime = await cf.currentVersion(
          state.workers.runtime.name,
        );
        state.snapshots.runtime = settingsDigest(
          await cf.api(
            `workers/scripts/${state.workers.runtime.name}/settings`,
          ),
        );
      });
      // Bootstrap breaks the initial circular service dependency. Admin can now bind Runtime.
      await checkpoint("admin", () => deploy("admin"));
      await checkpoint("runtime", () => deploy("runtime"));
    } else {
      await checkpoint("runtime", () => deploy("runtime"));
      await checkpoint("admin", () => deploy("admin"));
    }
    // Verify even when a prior process stopped after the verify checkpoint.
    state.operation.phase = "verify";
    await store.save(state);
    log("Flare platform: verify");
    await verify(
      cf,
      state,
      release,
      dependencies.fetch ?? globalThis.fetch,
      dependencies.sleep ?? sleep,
    );
    for (const role of ["runtime", "admin"]) {
      const current = await cf.currentVersion(state.workers[role].name);
      if (current !== state.versions[role])
        throw Error("Deployment changed during platform verification");
      const snapshot = settingsDigest(
        await cf.api(`workers/scripts/${state.workers[role].name}/settings`),
      );
      if (snapshot !== state.snapshots[role])
        throw Error(
          "Worker configuration changed during platform verification",
        );
      if (
        (await domainSnapshot(cf, state.workers[role].name)) !==
        state.domainSnapshots?.[role]
      )
        throw Error("Worker domains changed during platform verification");
    }
    state.previousVersions = state.operation.previousVersions;
    state.installed = {
      version: release.manifest.version,
      digest: release.manifest.digest,
      protocol: release.manifest.protocol,
      runtimeAbi: release.manifest.runtimeAbi,
      migrations: migrationInventory(release.manifest),
      verifiedAt: Date.now(),
    };
    state.operation = null;
    await store.save(state);
    return publicState(state, release.manifest);
  } finally {
    await store.release(state).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}
