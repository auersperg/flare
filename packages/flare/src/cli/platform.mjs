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
} from "./platform-state.mjs";
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
        namespace_id: String(
          parseInt(state.id.replaceAll("-", "").slice(0, 7), 16),
        ),
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
  const app = await cf.api(`access/apps/${state.access.id}`);
  if (app.domain !== state.addresses.adminHost || app.aud !== state.access.aud)
    throw Error(
      "Access application drift; refusing to change policies or audiences",
    );
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
  if (!["install", "status", "update"].includes(operation))
    throw Error(
      "Supported: flare platform install|status|update; no deployment has occurred.",
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
  const discovered = await store.discover();
  let state = discovered.state;
  if (operation === "status")
    return state
      ? publicState(state, release.manifest, discovered.row)
      : {
          account,
          installation: name,
          status: "not-installed",
          target: release.manifest.version,
        };
  const inventory = await preflight(cf);
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
      if (state.installed.digest === release.manifest.digest)
        return { ...publicState(state, release.manifest), unchanged: true };
      if (operation === "install")
        throw Error(
          "Already installed. Use flare platform update to change the platform version",
        );
    }
  } else if (operation !== "install")
    throw Error(
      "Installation is incomplete; resume platform install with the original release",
    );
  const plan = {
    account,
    installation: name,
    operation,
    from: state.installed?.version ?? null,
    to: release.manifest.version,
    digest: release.manifest.digest,
    dashboard: "https://" + state.addresses.adminHost,
    runtime: "https://" + state.addresses.runtimeHost,
    steps: state.installed
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
  state.operation ??= {
    id: randomUUID(),
    kind: operation,
    targetDigest: release.manifest.digest,
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
    if (!state.installed) {
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
    if (!state.installed) {
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
