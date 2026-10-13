import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { platform } from "../packages/flare/src/cli/platform.mjs";
import canary from "./fixtures/platform-canary.ts";
import {
  cleanupDisposableInstallation,
  runLifecycleCloudAcceptance,
} from "../scripts/platform-lifecycle-cloud-acceptance.mjs";
import {
  CloudflareAccount,
  CloudflareError,
  cloudflareToken,
} from "../packages/flare/src/cli/cloudflare-account.mjs";
import {
  InstallationStore,
  newInstallation,
  settingsDigest,
} from "../packages/flare/src/cli/platform-state.mjs";
import {
  WRANGLER_VERSION,
  payloadFiles,
  sha256,
  manifestDigest,
  loadPlatformRelease,
  assertUpgrade,
} from "../packages/flare/src/cli/platform-release.mjs";

const account = "a".repeat(32);
const owner = "owner@example.test";
const ddl = await readFile(
  "packages/core/migrations/0006_platform_installation.sql",
  "utf8",
);
async function fixture(version = "0.3.3", extraMigration = false) {
  const directory = await mkdtemp(join(tmpdir(), "flare-lifecycle-test-"));
  const payload = join(directory, "payload");
  await mkdir(join(payload, "dashboard/bootstrap"), { recursive: true });
  await mkdir(join(payload, "migrations"));
  for (const [path, bytes] of Object.entries({
    "admin.js": "export default {}",
    "runtime.js": "export default {}",
    "dashboard/index.html": "<p>Protected dashboard</p>",
    "dashboard/bootstrap/release.json": "{}",
    "migrations/0001.sql":
      "CREATE TABLE IF NOT EXISTS members(email TEXT PRIMARY KEY,role TEXT);",
    "migrations/0006_platform_installation.sql": ddl,
  }))
    await writeFile(join(payload, path), bytes);
  if (extraMigration)
    await writeFile(
      join(payload, "migrations/0007_additive.sql"),
      "CREATE TABLE IF NOT EXISTS platform_addition(id TEXT);",
    );
  const manifest = {
    format: 1,
    version,
    stateFormat: 1,
    protocol: 1,
    runtimeAbi: 4,
    compatibilityDate: "2026-10-10",
    wranglerVersion: WRANGLER_VERSION,
    upgradeFrom: version === "0.3.3" ? [] : ["0.3.3"],
    files: [],
  };
  for (const path of await payloadFiles(payload)) {
    const bytes = await readFile(join(payload, path));
    manifest.files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  manifest.digest = manifestDigest(manifest);
  await writeFile(join(payload, "manifest.json"), JSON.stringify(manifest));
  return { directory, release: await loadPlatformRelease(payload) };
}

class Cloud {
  databases = new Map();
  buckets = new Map();
  queues = new Map();
  apps = new Map();
  workers = new Map();
  calls = [];
  deployments = [];
  domains = [];
  subdomain = "account";
  secretWrites = 0;
  afterWriteFailure = null;
  deploymentFailure = null;
  deny = null;
  dashboardOpen = false;
  paginateBuckets = false;
  api = new CloudflareAccount(account, "synthetic-account-token", {
    fetch: (...args) => this.fetch(...args),
    run: (...args) => this.run(...args),
  });
  ok(result, extra = {}) {
    return Response.json({ success: true, result, ...extra });
  }
  error(status = 404, code = 10007) {
    return Response.json(
      {
        success: false,
        errors: [{ code, message: "Private diagnostic never printed" }],
      },
      { status },
    );
  }
  async fetch(url, init) {
    expect(
      String(url).startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${account}/`,
      ),
    ).toBe(true);
    expect(init.headers.authorization).toBe("Bearer synthetic-account-token");
    const path = new URL(url).pathname.split(`/accounts/${account}/`)[1];
    const body = init.body ? JSON.parse(init.body) : null;
    this.calls.push({ path, method: init.method, body });
    if (this.deny === path) return this.error(403, 9109);
    if (path === "d1/database" && init.method === "GET")
      return this.ok(
        [...this.databases].map(([uuid, value]) => ({
          uuid,
          name: value.name,
        })),
      );
    if (path === "d1/database" && init.method === "POST") {
      if ([...this.databases.values()].some((db) => db.name === body.name))
        return this.error(409, 7502);
      const uuid = randomUUID();
      this.databases.set(uuid, {
        name: body.name,
        db: new Database(":memory:"),
      });
      if (this.afterWriteFailure === "d1/database") {
        this.afterWriteFailure = null;
        throw Error("Lost catalogue acknowledgement");
      }
      return this.ok({ uuid, name: body.name });
    }
    const query = path.match(/^d1\/database\/([^/]+)\/query$/);
    if (query) {
      const database = this.databases.get(query[1]);
      if (!database) return this.error();
      const results = database.db.query(body.sql).all(...body.params);
      return this.ok([
        {
          success: true,
          results,
          meta: {
            changes: database.db.query("SELECT changes() AS changes").get()
              .changes,
          },
        },
      ]);
    }
    if (
      path === "r2/buckets" &&
      init.method === "GET" &&
      this.paginateBuckets
    ) {
      const all = [...this.buckets.values()];
      if (new URL(url).searchParams.has("cursor"))
        return this.ok({ buckets: all.slice(1) });
      return this.ok(
        { buckets: all.slice(0, 1) },
        all.length > 1
          ? { result_info: { cursor: "after-first", per_page: 1 } }
          : {},
      );
    }
    if (path === "r2/buckets" && init.method === "GET")
      return this.ok({ buckets: [...this.buckets.values()], truncated: false });
    if (path === "r2/buckets") {
      this.buckets.set(body.name, { name: body.name });
      if (this.afterWriteFailure === "r2/buckets") {
        this.afterWriteFailure = null;
        throw Error("Lost acknowledgement with private details");
      }
      return this.ok({ name: body.name });
    }
    if (path === "queues" && init.method === "GET")
      return this.ok([...this.queues.values()]);
    if (path === "queues") {
      const queue = {
        queue_id: randomUUID().replaceAll("-", ""),
        queue_name: body.queue_name,
      };
      this.queues.set(queue.queue_id, queue);
      return this.ok(queue);
    }
    if (path === "access/organizations")
      return this.ok({ auth_domain: "team.cloudflareaccess.com" });
    if (path === "access/apps" && init.method === "GET")
      return this.ok([...this.apps.values()]);
    if (path === "access/apps") {
      const app = { ...body, id: randomUUID(), aud: "b".repeat(64) };
      this.apps.set(app.id, app);
      if (this.afterWriteFailure === "access/apps") {
        this.afterWriteFailure = null;
        throw Error("Lost Access acknowledgement");
      }
      return this.ok(app);
    }
    if (/^access\/apps\/[^/]+\/policies$/.test(path))
      return this.ok(this.apps.get(path.split("/")[2])?.policies ?? []);
    if (path.startsWith("access/apps/"))
      return this.apps.has(path.slice(12))
        ? this.ok(this.apps.get(path.slice(12)))
        : this.error();
    if (path === "workers/subdomain") {
      if (body) this.subdomain = body.subdomain;
      return this.ok({ subdomain: this.subdomain });
    }
    if (path === "workers/domains") return this.ok(this.domains);
    if (path === "workers/scripts")
      return this.ok([...this.workers].map(([id]) => ({ id })));
    const workerPath = path.match(
      /^workers\/scripts\/([^/]+)\/(settings|deployments|versions\/[^/]+|secrets|subdomain)$/,
    );
    if (workerPath) {
      const worker = this.workers.get(workerPath[1]);
      if (!worker) return this.error();
      const operation = workerPath[2];
      if (operation === "settings") return this.ok(worker.settings);
      if (operation === "subdomain")
        return this.ok({
          enabled: worker.config.workers_dev,
          previews_enabled: worker.config.preview_urls,
        });
      if (operation === "deployments")
        return this.ok({
          deployments: [
            {
              created_on: new Date().toISOString(),
              versions: [{ version_id: worker.version, percentage: 100 }],
            },
          ],
        });
      if (operation.startsWith("versions/"))
        return this.ok({
          annotations: { "workers/tag": worker.tags.get(operation.slice(9)) },
        });
      if (operation === "secrets" && init.method === "GET")
        return this.ok(
          [...worker.secrets].map(([name]) => ({ name, type: "secret_text" })),
        );
      if (operation === "secrets") {
        worker.secrets.set(body.name, body.text);
        this.secretWrites++;
        worker.settings.bindings.push({ name: body.name, type: "secret_text" });
        return this.ok({ name: body.name, type: "secret_text" });
      }
    }
    throw Error("Unhandled synthetic Cloudflare path: " + path);
  }
  async run(args, context) {
    expect(context.token).toBe("synthetic-account-token");
    const config = JSON.parse(
      await readFile(args[args.indexOf("--config") + 1], "utf8"),
    );
    if (args[0] === "d1") {
      const db = this.databases.get(config.d1_databases[0].database_id).db;
      db.exec(
        "CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)",
      );
      for (const file of await payloadFiles(
        config.d1_databases[0].migrations_dir,
      )) {
        if (db.query("SELECT name FROM d1_migrations WHERE name=?").get(file))
          continue;
        db.exec(
          await readFile(
            join(config.d1_databases[0].migrations_dir, file),
            "utf8",
          ),
        );
        db.query("INSERT INTO d1_migrations(name) VALUES(?)").run(file);
      }
      return "Applied migrations";
    }
    expect(args[0]).toBe("deploy");
    expect(args).toContain("--no-bundle");
    expect(args).toContain("--strict");
    const tag = args[args.indexOf("--tag") + 1];
    const previous = this.workers.get(config.name);
    const release = JSON.parse(
      await readFile(join(dirname(config.main), "manifest.json"), "utf8"),
    );
    const worker = {
      ...previous,
      config,
      version: randomUUID(),
      tags: previous?.tags ?? new Map(),
      secrets: previous?.secrets ?? new Map(),
      release,
    };
    if (args.includes("--secrets-file")) {
      const secrets = JSON.parse(
        await readFile(args[args.indexOf("--secrets-file") + 1], "utf8"),
      );
      expect(previous).toBeUndefined();
      for (const [name, text] of Object.entries(secrets))
        worker.secrets.set(name, text);
      this.secretWrites++;
    }
    worker.tags.set(worker.version, tag);
    worker.namespace = previous?.namespace ?? randomUUID().replaceAll("-", "");
    worker.settings = {
      compatibility_date: config.compatibility_date,
      compatibility_flags: config.compatibility_flags,
      limits: config.limits,
      observability: config.observability,
      bindings: [
        ...Object.entries(config.vars).map(([name, text]) => ({
          name,
          type: "plain_text",
          text,
        })),
        ...[...worker.secrets].map(([name]) => ({ name, type: "secret_text" })),
        ...(config.services ?? []).map((b) => ({
          name: b.binding,
          service: b.service,
          entrypoint: b.entrypoint,
          type: "service",
        })),
        ...(config.r2_buckets ?? []).map((b) => ({
          name: b.binding,
          type: "r2_bucket",
          bucket_name: b.bucket_name,
        })),
        ...(config.d1_databases ?? []).map((b) => ({
          name: b.binding,
          type: "d1",
          id: b.database_id,
        })),
        ...(config.queues?.producers ?? []).map((b) => ({
          name: b.binding,
          type: "queue",
          queue_name: b.queue,
        })),
        ...(config.worker_loaders ?? []).map((b) => ({
          name: b.binding,
          type: "worker_loader",
        })),
        ...(config.ratelimits ?? []).map((b) => ({ ...b, type: "ratelimit" })),
        ...(config.assets
          ? [{ name: config.assets.binding, type: "assets" }]
          : []),
        ...(config.durable_objects
          ? [
              {
                name: "SUPERVISORS",
                type: "durable_object_namespace",
                namespace_id: worker.namespace,
                class_name: "EnvironmentSupervisor",
              },
            ]
          : []),
      ],
    };
    this.workers.set(config.name, worker);
    for (const route of config.routes ?? [])
      if (route.custom_domain) {
        this.domains = this.domains.filter(
          (domain) => domain.hostname !== route.pattern,
        );
        this.domains.push({
          hostname: route.pattern,
          service: config.name,
          enabled: true,
          previews_enabled: false,
          zone_id: account,
        });
      }
    this.deployments.push({ name: config.name, tag, config });
    if (this.deploymentFailure && tag.includes(this.deploymentFailure)) {
      this.deploymentFailure = null;
      throw Error("Deployment acknowledgement lost");
    }
    return "Deployed";
  }
  publicFetch = async (url, init) => {
    expect(init.headers?.authorization).toBeUndefined();
    const health = new URL(url).pathname === "/health";
    const worker = [...this.workers.values()].find(
      (w) =>
        new URL(w.config.vars[health ? "RUNTIME_URL" : "DASHBOARD_URL"])
          .host === new URL(url).host &&
        (health
          ? w.config.name.endsWith("-runtime")
          : w.config.name.endsWith("-admin")),
    );
    if (!worker) return new Response(null, { status: 404 });
    if (health)
      return Response.json({
        version: worker.release.version,
        installationId: worker.config.vars.FLARE_INSTALLATION_ID,
        platformPayload: worker.config.vars.FLARE_PLATFORM_PAYLOAD,
        runtimeAbi: 4,
        protocol: 1,
        readiness: "control-plane-ready",
      });
    return this.dashboardOpen
      ? new Response("Unprotected dashboard")
      : new Response(null, {
          status: 302,
          headers: {
            location:
              worker.config.vars.ACCESS_ISSUER + "/cdn-cgi/access/login",
          },
        });
  };
  mutationCount() {
    return (
      this.calls.filter(
        (c) =>
          c.method !== "GET" &&
          !(c.path.endsWith("/query") && /^SELECT\b/i.test(c.body.sql)),
      ).length + this.deployments.length
    );
  }
  state() {
    return JSON.parse(
      [...this.databases.values()][0].db
        .query("SELECT state FROM flare_installation")
        .get().state,
    );
  }
  close() {
    for (const { db } of this.databases.values()) db.close();
  }
}
async function testContext(fn) {
  const f = await fixture();
  const cloud = new Cloud();
  const deps = {
    release: f.release,
    cf: cloud.api,
    storeOptions: { directory: join(f.directory, "config") },
    fetch: cloud.publicFetch,
    sleep: async () => {},
    log: () => {},
    question: async () => {
      throw Error("Confirmation required");
    },
  };
  const install = (options = {}) =>
    platform(
      { operation: "install", account, owner, confirm: account, ...options },
      deps,
    );
  try {
    await fn({ ...f, cloud, deps, install });
  } finally {
    cloud.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}

describe("Platform lifecycle", () => {
  it("reports only failed readiness fields and resumes without redeploying", async () =>
    testContext(async ({ cloud, install, deps }) => {
      const goodFetch = deps.fetch;
      deps.fetch = async (url, init) => {
        const response = await goodFetch(url, init);
        if (!url.includes("/health")) return response;
        return Response.json({
          ...(await response.json()),
          protocol: "private-response-must-not-be-printed",
        });
      };
      let failure;
      try {
        await install();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain("Last probe: HTTP 200; mismatches: protocol");
      expect(failure).not.toContain("private-response-must-not-be-printed");
      expect(cloud.state().operation.phase).toBe("verify");
      const deployments = cloud.deployments.length;
      deps.fetch = goodFetch;
      expect((await install({ resume: true })).status).toBe("installed");
      expect(cloud.deployments.length).toBe(deployments);
    }));
  it("journals same-release config updates, preserves them without --config and resumes lost acknowledgements", async () =>
    testContext(async ({ cloud, install, deps, directory }) => {
      await install();
      const before = cloud.state();
      const path = join(directory, "operator.json");
      const config = {
        capabilities: {
          ["00000000-0000-4000-8000-000000000001/dev"]: {
            outbound: ["api.example.com"],
          },
        },
      };
      await writeFile(path, JSON.stringify(config));
      const count = cloud.mutationCount();
      await platform(
        { operation: "update", account, config: path, "dry-run": true },
        deps,
      );
      expect(cloud.mutationCount()).toBe(count);
      expect(cloud.state().config).toBeUndefined();
      cloud.deploymentFailure = "-runtime-";
      await expect(
        platform(
          { operation: "update", account, config: path, confirm: account },
          deps,
        ),
      ).rejects.toThrow();
      const pending = cloud.state();
      expect(pending.operation.configDigest).toBeDefined();
      await platform(
        { operation: "update", account, confirm: account, resume: true },
        deps,
      );
      const after = cloud.state();
      expect(
        after.config.capabilities["00000000-0000-4000-8000-000000000001/dev"]
          .outbound,
      ).toEqual(["api.example.com"]);
      expect(after.supervisorNamespace).toBe(before.supervisorNamespace);
      expect(
        (await platform({ operation: "update", account }, deps)).unchanged,
      ).toBe(true);
    }));
  it("ignores Access timestamps, refuses policy drift and accepts only an explicitly reviewed exact snapshot", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const state = cloud.state(),
        app = cloud.apps.get(state.access.id);
      app.updated_at = "metadata-only";
      expect(
        (await platform({ operation: "update", account }, deps)).unchanged,
      ).toBe(true);
      app.policies[0].decision = "deny";
      const count = cloud.mutationCount();
      await expect(
        platform({ operation: "update", account, confirm: account }, deps),
      ).rejects.toThrow("drift");
      expect(cloud.mutationCount()).toBe(count);
      const status = await platform({ operation: "status", account }, deps);
      expect(status.health.access.status).toBe("drift");
      const snapshot = status.health.access.snapshot;
      await expect(
        platform(
          {
            operation: "update",
            account,
            "accept-access": "0".repeat(64),
            confirm: account,
          },
          deps,
        ),
      ).rejects.toThrow("changed");
      await platform(
        {
          operation: "update",
          account,
          "accept-access": snapshot,
          "dry-run": true,
        },
        deps,
      );
      expect(cloud.mutationCount()).toBe(count);
      await platform(
        {
          operation: "update",
          account,
          "accept-access": snapshot,
          confirm: account,
        },
        deps,
      );
      expect(cloud.state().access.snapshot).toBe(snapshot);
      expect(app.policies[0].decision).toBe("deny"); // CLI never writes policies.
    }));
  it("packages immutable payload files and detects corruption, unsafe paths and extras", async () => {
    const f = await fixture();
    try {
      expect(
        (await loadPlatformRelease(f.release.directory)).manifest.version,
      ).toBe("0.3.3");
      await writeFile(join(f.release.directory, "unexpected"), "no");
      await expect(loadPlatformRelease(f.release.directory)).rejects.toThrow(
        "Unlisted",
      );
      await rm(join(f.release.directory, "unexpected"));
      await writeFile(join(f.release.directory, "runtime.js"), "tampered");
      await expect(loadPlatformRelease(f.release.directory)).rejects.toThrow(
        "checksum",
      );
      await rm(join(f.release.directory, "runtime.js"));
      await symlink("admin.js", join(f.release.directory, "runtime.js"));
      await expect(loadPlatformRelease(f.release.directory)).rejects.toThrow(
        "Unsafe",
      );
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("rejects downgraded, legacy, ABI-changed and same-version replacement payloads", () => {
    const target = {
      version: "0.3.4",
      digest: "a".repeat(64),
      protocol: 1,
      runtimeAbi: 4,
      upgradeFrom: ["0.3.3"],
    };
    expect(() =>
      assertUpgrade({ ...target, version: "0.3.3" }, target),
    ).not.toThrow();
    for (const installed of [
      { ...target, version: "0.2.0" },
      { ...target, version: "0.3.5" },
      { ...target, runtimeAbi: 3 },
      { ...target, digest: "b".repeat(64) },
    ])
      expect(() => assertUpgrade(installed, target)).toThrow();
  });
  it("dry-run and missing confirmation never provision or create local state", async () =>
    testContext(async ({ cloud, deps, install, directory }) => {
      const plan = await install({ "dry-run": true });
      expect(plan.to).toBe("0.3.3");
      expect(cloud.mutationCount()).toBe(0);
      await expect(install({ confirm: undefined })).rejects.toThrow(
        "Confirmation",
      );
      expect(cloud.mutationCount()).toBe(0);
      await expect(stat(join(directory, "config"))).rejects.toThrow();
      expect(
        await platform({ operation: "status", account }, deps),
      ).toMatchObject({ status: "not-installed" });
    }));
  it("permission failures occur before resource creation and hide private diagnostics", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.deny = "access/apps";
      await expect(install()).rejects.toThrow("403");
      expect(cloud.mutationCount()).toBe(0);
      try {
        await install();
      } catch (error) {
        expect(error.message).not.toContain("Private diagnostic");
      }
    }));
  it("installs both Workers and catalogue/resources, keeps account secrets out of state, and is idempotent", async () =>
    testContext(async ({ cloud, install, directory }) => {
      const result = await install();
      expect(result.status).toBe("installed");
      expect(result.ownerLogin).toContain("Verify owner sign-in");
      expect(cloud.workers.size).toBe(2);
      expect(cloud.buckets.size).toBe(2);
      expect(cloud.queues.size).toBe(2);
      expect(cloud.apps.size).toBe(1);
      expect(
        cloud.deployments.map((d) =>
          d.tag.includes("-boot-")
            ? "bootstrap"
            : d.config.name.endsWith("-admin")
              ? "admin"
              : "runtime",
        ),
      ).toEqual(["bootstrap", "admin", "runtime"]);
      const state = cloud.state();
      expect(state.supervisorNamespace).toHaveLength(32);
      const secret = [...cloud.workers.values()]
        .find((w) => w.config.name.endsWith("-runtime"))
        .secrets.get("DEV_SIGNING_KEY");
      const local = await readFile(
        join(directory, "config", `${account}-default.json`),
        "utf8",
      );
      expect(local).not.toContain(secret);
      expect(local).not.toContain("synthetic-account-token");
      expect(
        (await stat(join(directory, "config", `${account}-default.json`)))
          .mode & 0o777,
      ).toBe(0o600);
      const count = cloud.mutationCount();
      expect((await install()).unchanged).toBe(true);
      expect(cloud.mutationCount()).toBe(count);
    }));
  it("recovers from cloud state when local configuration is lost", async () =>
    testContext(async ({ cloud, install, directory, deps }) => {
      const result = await install();
      await rm(join(directory, "config"), { recursive: true });
      expect(
        await platform({ operation: "status", account }, deps),
      ).toMatchObject({ id: result.id, status: "installed" });
      expect(cloud.state().id).toBe(result.id);
    }));
  it("recovers an ambiguous resource write without duplicating resources", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.afterWriteFailure = "r2/buckets";
      await expect(install()).rejects.toBeInstanceOf(CloudflareError);
      expect(cloud.buckets.size).toBe(1);
      expect((await install()).status).toBe("installed");
      expect(cloud.buckets.size).toBe(2);
      expect(
        cloud.calls.filter(
          (c) => c.path === "r2/buckets" && c.method === "POST",
        ),
      ).toHaveLength(2);
    }));
  for (const [phase, writes] of [
    ["boot", 1],
    ["admin", 2],
    ["runtime", 3],
  ])
    it(`reconciles the ${phase} deployment after a lost acknowledgement without deploying twice`, async () =>
      testContext(async ({ cloud, install }) => {
        cloud.deploymentFailure = `-${phase}-`;
        await expect(install()).rejects.toThrow("acknowledgement");
        expect(cloud.deployments).toHaveLength(writes);
        expect((await install()).status).toBe("installed");
        expect(cloud.deployments).toHaveLength(3);
        expect(cloud.secretWrites).toBe(1);
      }));
  it("updates a compatible release while preserving namespace, signing secret, app state and policies", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const before = cloud.state();
      const runtime = cloud.workers.get(before.workers.runtime.name);
      runtime.applicationState = {
        documents: [{ id: "canary" }],
        activeRelease: "d".repeat(64),
        jobs: ["queued"],
        auth: "session",
      };
      const secret = runtime.secrets.get("DEV_SIGNING_KEY");
      const policy = JSON.stringify(cloud.apps.get(before.access.id));
      const f = await fixture("0.3.4", true);
      try {
        const updatedDeps = { ...deps, release: f.release };
        const count = cloud.mutationCount();
        const plan = await platform(
          { operation: "update", account, "dry-run": true },
          updatedDeps,
        );
        expect(plan.from).toBe("0.3.3");
        expect(plan.to).toBe("0.3.4");
        expect(cloud.mutationCount()).toBe(count);
        const result = await platform(
          { operation: "update", account, confirm: account },
          updatedDeps,
        );
        expect(result.installed.version).toBe("0.3.4");
        const after = cloud.state();
        expect(after.id).toBe(before.id);
        expect(after.resources).toEqual(before.resources);
        expect(after.supervisorNamespace).toBe(before.supervisorNamespace);
        const next = cloud.workers.get(after.workers.runtime.name);
        expect(next.secrets.get("DEV_SIGNING_KEY")).toBe(secret);
        expect(next.applicationState).toEqual(runtime.applicationState);
        expect(JSON.stringify(cloud.apps.get(before.access.id))).toBe(policy);
        expect(cloud.secretWrites).toBe(1);
        expect(after.previousVersions).toEqual(before.versions);
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    }));
  it("resumes a partial update with the original release only", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const f = await fixture("0.3.4");
      try {
        const updatedDeps = { ...deps, release: f.release };
        cloud.deploymentFailure = "-runtime-";
        await expect(
          platform(
            { operation: "update", account, confirm: account },
            updatedDeps,
          ),
        ).rejects.toThrow("acknowledgement");
        expect(cloud.state().operation.kind).toBe("update");
        await expect(
          platform({ operation: "update", account, confirm: account }, deps),
        ).rejects.toThrow("original CLI release");
        const count = cloud.deployments.length;
        await platform(
          { operation: "update", account, confirm: account },
          updatedDeps,
        );
        expect(cloud.deployments.length).toBe(count + 1);
        expect(cloud.state().installed.version).toBe("0.3.4");
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    }));
  it("rejects out-of-band configuration changes without overwriting them", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const state = cloud.state();
      cloud.workers.get(state.workers.runtime.name).settings.bindings.push({
        name: "EXTRA",
        type: "plain_text",
        text: "operator-value",
      });
      const f = await fixture("0.3.4");
      try {
        const count = cloud.mutationCount();
        await expect(
          platform(
            { operation: "update", account, confirm: account },
            { ...deps, release: f.release },
          ),
        ).rejects.toThrow("outside Flare");
        expect(cloud.mutationCount()).toBe(count);
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    }));
  it("does not declare an installation verified when the dashboard is open", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.dashboardOpen = true;
      await expect(install()).rejects.toThrow("not verified closed");
      expect(cloud.state().installed).toBeNull();
      expect(cloud.state().operation.phase).toBe("verify");
      cloud.dashboardOpen = false;
      expect((await install()).status).toBe("installed");
      expect(cloud.deployments).toHaveLength(3);
    }));
  it("creates a workers.dev subdomain only when missing and preserves custom-domain isolation", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.subdomain = null;
      await install({
        subdomain: "chosen-account",
        "dashboard-host": "dashboard.example.test",
        "runtime-host": "api.example.test",
      });
      expect(cloud.subdomain).toBeNull();
      for (const d of cloud.deployments) {
        expect(d.config.workers_dev).toBe(false);
        expect(d.config.preview_urls).toBe(false);
        expect(d.config.routes[0].custom_domain).toBe(true);
      }
    }));
  it("never takes over another Worker's custom domain", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.domains.push({
        hostname: "dashboard.example.test",
        service: "unrelated",
      });
      await expect(
        install({
          "dashboard-host": "dashboard.example.test",
          "runtime-host": "api.example.test",
        }),
      ).rejects.toThrow("another Worker");
      expect(cloud.mutationCount()).toBe(0);
    }));
  it("uses compare-and-swap leases and requires explicit recovery of expired locks", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const state = cloud.state();
      const first = new InstallationStore(
        cloud.api,
        "default",
        deps.storeOptions,
      );
      const second = new InstallationStore(
        cloud.api,
        "default",
        deps.storeOptions,
      );
      await first.discover();
      await second.discover();
      await first.acquire(state);
      await expect(second.acquire(state)).rejects.toThrow("locked");
      const db = [...cloud.databases.values()][0].db;
      db.exec("UPDATE flare_installation SET lock_expires=0");
      await expect(second.acquire(state)).rejects.toThrow("locked");
      await second.acquire(state, true);
      await expect(first.save(state)).rejects.toThrow("lost its lease");
      await second.release(state);
    }));
  it("refuses unmanaged catalogues and does not bootstrap over existing data", async () =>
    testContext(async ({ cloud, install }) => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE valuable_data(id TEXT)");
      cloud.databases.set(randomUUID(), { name: "flare-default-catalog", db });
      await expect(install()).rejects.toThrow("Unmanaged");
      expect(cloud.mutationCount()).toBe(0);
    }));
});

it("Cloudflare errors preserve unknown-write status without leaking credentials or retrying", async () => {
  let calls = 0;
  const cf = new CloudflareAccount(account, "private-token", {
    fetch: async () => {
      calls++;
      return new Response("private response", { status: 502 });
    },
  });
  try {
    await cf.api("queues", { queue_name: "test" });
  } catch (error) {
    expect(error.ambiguous).toBe(true);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("private");
  }
  expect(calls).toBe(1);
  await expect(cf.api("../another-account")).rejects.toThrow("Invalid");
  expect(calls).toBe(1);
});
it("platform help and invalid options remain lazy and never call account authorization", () => {
  const cli = resolve("packages/flare/src/cli/main.mjs");
  const help = spawnSync(process.execPath, [cli, "platform", "--help"], {
    encoding: "utf8",
  });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("install|status|update");
  for (const args of [
    ["platform", "init"],
    ["platform", "install", "--force"],
    ["platform", "update", "--owner", owner],
    ["platform", "install", "--account"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no deployment has occurred");
  }
});

describe("Platform failure recovery regressions", () => {
  it("uses explicitly public canary functions without weakening the application authentication default", () => {
    expect(canary.functions.tasks.list.auth).toBe("public");
    expect(canary.functions.tasks.create.auth).toBe("public");
    expect(canary.functions.tasks.privateList.auth).toBe("required");
  });
  it("retries only transient GET failures, with a strict bound and no authorization/write retries", async () => {
    let calls = 0;
    const delays = [];
    const cf = new CloudflareAccount(account, "synthetic", {
      wait: async (ms) => delays.push(ms),
      fetch: async () => {
        calls++;
        if (calls === 1) throw Error("Private network failure");
        if (calls === 2)
          return Response.json({ success: false }, { status: 503 });
        return Response.json({ success: true, result: [] });
      },
    });
    expect(await cf.list("queues")).toEqual([]);
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    calls = 0;
    cf.fetcher = async () => {
      calls++;
      return Response.json({ success: false }, { status: 403 });
    };
    await expect(cf.api("queues")).rejects.toBeInstanceOf(CloudflareError);
    expect(calls).toBe(1);
    calls = 0;
    cf.fetcher = async () => {
      calls++;
      throw Error("Private network failure");
    };
    await expect(
      cf.api("queues", { queue_name: "example" }),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(calls).toBe(1);
    calls = 0;
    await expect(cf.api("queues")).rejects.toBeInstanceOf(CloudflareError);
    expect(calls).toBe(3);
  });
  it("requires explicit cloud proof confirmation and refuses cleanup of normal installations before requests", async () =>
    testContext(async ({ cloud }) => {
      await expect(
        runLifecycleCloudAcceptance(
          { account, owner, confirm: "wrong" },
          { cf: cloud.api },
        ),
      ).rejects.toThrow("--confirm");
      await expect(
        cleanupDisposableInstallation(
          cloud.api,
          newInstallation({
            account,
            name: "default",
            owner,
            subdomain: "account",
          }),
          {},
        ),
      ).rejects.toThrow();
      expect(cloud.calls).toHaveLength(0);
    }));
  it("accepts documented empty DELETE acknowledgements but not malformed success bodies", async () => {
    const cf = new CloudflareAccount(account, "synthetic", {
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(
      await cf.api("workers/scripts/disposable", undefined, "DELETE"),
    ).toBeNull();
    await expect(
      cf.api("workers/scripts/disposable/settings"),
    ).rejects.toBeInstanceOf(CloudflareError);
  });
  it("paginates global account discovery using its documented 50-account limit", async () => {
    const urls = [];
    const cf = new CloudflareAccount(account, "synthetic", {
      fetch: async (url) => {
        urls.push(String(url));
        const page = Number(new URL(url).searchParams.get("page"));
        return Response.json({
          success: true,
          result: Array.from({ length: page === 1 ? 50 : 1 }, (_, i) => ({
            id: String((page - 1) * 50 + i).padStart(32, "0"),
          })),
          result_info: { per_page: 50, total_count: 51 },
        });
      },
    });
    expect(
      await cf.list("accounts", { global: true, perPage: 50 }),
    ).toHaveLength(51);
    expect(urls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50",
      "https://api.cloudflare.com/client/v4/accounts?page=2&per_page=50",
    ]);
  });
  it.each(["d1/database", "access/apps"])(
    "reconciles a lost %s creation acknowledgement",
    async (path) =>
      testContext(async ({ cloud, install }) => {
        cloud.afterWriteFailure = path;
        await expect(install()).rejects.toBeInstanceOf(CloudflareError);
        expect((await install()).status).toBe("installed");
        expect(cloud.databases.size).toBe(1);
        expect(cloud.apps.size).toBe(1);
        expect(
          cloud.calls.filter(
            (call) => call.path === path && call.method === "POST",
          ),
        ).toHaveLength(1);
      }),
  );
  it("uses R2's envelope cursor instead of silently missing later buckets", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.paginateBuckets = true;
      cloud.buckets.set("other-first", { name: "other-first" });
      cloud.buckets.set("other-second", { name: "other-second" });
      await install();
      expect(cloud.buckets.size).toBe(4);
      expect((await install()).unchanged).toBe(true);
    }));
  it("will not accept a modified completed Worker on recovery", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.dashboardOpen = true;
      await expect(install()).rejects.toThrow("not verified closed");
      const state = cloud.state();
      const admin = cloud.workers.get(state.workers.admin.name);
      admin.settings.bindings.push({
        name: "EXTERNAL",
        type: "plain_text",
        text: "operator-setting",
      });
      const deployments = cloud.deployments.length;
      cloud.dashboardOpen = false;
      await expect(install()).rejects.toThrow("Completed admin");
      expect(cloud.deployments.length).toBe(deployments);
      expect(admin.settings.bindings.at(-1).name).toBe("EXTERNAL");
    }));
  it("refuses extra attached domains instead of removing them during update", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const state = cloud.state();
      cloud.domains.push({
        hostname: "added.example.test",
        service: state.workers.runtime.name,
        enabled: true,
        previews_enabled: false,
        zone_id: account,
      });
      const next = await fixture("0.3.4");
      try {
        const count = cloud.mutationCount();
        await expect(
          platform(
            { operation: "update", account, confirm: account },
            { ...deps, release: next.release },
          ),
        ).rejects.toThrow("Custom domains changed");
        expect(cloud.mutationCount()).toBe(count);
      } finally {
        await rm(next.directory, { recursive: true, force: true });
      }
    }));
  it("rejects a stale plan even after another writer releases its lock", async () =>
    testContext(async ({ cloud, install, deps }) => {
      await install();
      const first = new InstallationStore(
        cloud.api,
        "default",
        deps.storeOptions,
      );
      const second = new InstallationStore(
        cloud.api,
        "default",
        deps.storeOptions,
      );
      const a = await first.discover(),
        b = await second.discover();
      await first.acquire(a.state);
      a.state.lastOperatorCheck = 1;
      await first.save(a.state);
      await first.release(a.state);
      await expect(second.acquire(b.state)).rejects.toThrow(
        "changed while preparing",
      );
    }));
  it("creates a missing workers.dev subdomain without renaming an existing one", async () =>
    testContext(async ({ cloud, install }) => {
      cloud.subdomain = null;
      await install({ subdomain: "chosen-account" });
      expect(cloud.subdomain).toBe("chosen-account");
      expect(
        cloud.calls.filter(
          (call) => call.path === "workers/subdomain" && call.method === "PUT",
        ),
      ).toHaveLength(1);
      await install();
      expect(
        cloud.calls.filter(
          (call) => call.path === "workers/subdomain" && call.method === "PUT",
        ),
      ).toHaveLength(1);
    }));
  it("preserves unknown fields by stopping on settings drift, with canonical object-key hashing", () => {
    const a = {
      compatibility_date: "2026-10-10",
      bindings: [{ name: "X", type: "plain_text", text: "value" }],
      assets: { run_worker_first: ["/*"] },
    };
    const b = {
      assets: { run_worker_first: ["/*"] },
      bindings: [{ text: "value", type: "plain_text", name: "X" }],
      compatibility_date: "2026-10-10",
    };
    expect(settingsDigest(a)).toBe(settingsDigest(b));
    expect(settingsDigest({ ...a, assets: { run_worker_first: [] } })).not.toBe(
      settingsDigest(a),
    );
  });
  it("uses the documented auth token interface and rejects global API keys", async () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      const token = await cloudflareToken(async (args, options) => {
        expect(args).toEqual(["auth", "token", "--json"]);
        expect(options.capture).toBe(true);
        return JSON.stringify({ type: "oauth", token: "synthetic-oauth" });
      });
      expect(token).toBe("synthetic-oauth");
      await expect(
        cloudflareToken(async () =>
          JSON.stringify({ type: "api_key", key: "synthetic", email: owner }),
        ),
      ).rejects.toThrow("not a global API key");
      await expect(
        cloudflareToken(async () => {
          throw Error("private auth output");
        }),
      ).rejects.toThrow("authentication required");
    } finally {
      if (original === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = original;
    }
  });
});

async function operatorContext(work) {
  await testContext(async (ctx) => {
    const { cloud, install, deps, directory } = ctx;
    await install({
      "dashboard-host": "dashboard.example.test",
      "runtime-host": "api.example.test",
    });
    const state = cloud.state();
    const legacy = {
      catalog: "flare-catalog",
      bundles: "flare-builds",
      files: "flare-files",
      jobs: "flare-jobs",
      dlq: "flare-jobs-dlq",
    };
    cloud.databases.get(state.resources.catalog.id).name = legacy.catalog;
    cloud.databases
      .get(state.resources.catalog.id)
      .db.exec("DELETE FROM flare_installation");
    for (const key of ["bundles", "files"]) {
      cloud.buckets.delete(state.resources[key].name);
      cloud.buckets.set(legacy[key], { name: legacy[key] });
    }
    for (const key of ["jobs", "dlq"])
      cloud.queues.get(state.resources[key].id).queue_name = legacy[key];
    for (const role of ["runtime", "admin"]) {
      const w = cloud.workers.get(state.workers[role].name);
      cloud.workers.delete(state.workers[role].name);
      w.config.name = "flare-" + role;
      delete w.config.vars.FLARE_INSTALLATION_ID;
      delete w.config.vars.FLARE_PLATFORM_PAYLOAD;
      w.settings.bindings = w.settings.bindings.filter(
        (b) =>
          !["FLARE_INSTALLATION_ID", "FLARE_PLATFORM_PAYLOAD"].includes(b.name),
      );
      for (const b of w.settings.bindings) {
        if (b.type === "service")
          b.service = b.service.endsWith("admin")
            ? "flare-admin"
            : "flare-runtime";
        if (b.type === "r2_bucket")
          b.bucket_name = b.name === "BUNDLES" ? legacy.bundles : legacy.files;
        if (b.type === "queue") b.queue_name = legacy.jobs;
      }
      cloud.workers.set(w.config.name, w);
    }
    for (const domain of cloud.domains)
      domain.service = domain.service.endsWith("admin")
        ? "flare-admin"
        : "flare-runtime";
    await rm(join(directory, "config"), { recursive: true, force: true });
    const adopt = (options = {}) =>
      platform(
        { operation: "adopt", account, owner, confirm: account, ...options },
        deps,
      );
    await work({ ...ctx, state, adopt });
  });
}

describe("Explicit operator adoption", () => {
  it("plans without writes, retains identities/secrets, adopts with the existing engine and discovers without cache", async () =>
    operatorContext(async ({ cloud, adopt, deps, directory, state }) => {
      const namespace = cloud.workers.get("flare-runtime").namespace,
        secretWrites = cloud.secretWrites,
        writes = cloud.mutationCount();
      const plan = await adopt({ "dry-run": true });
      expect(plan.steps).toEqual(["migrations", "runtime", "admin", "verify"]);
      expect(cloud.mutationCount()).toBe(writes);
      expect(
        await new InstallationStore(
          cloud.api,
          "default",
          deps.storeOptions,
        ).local(),
      ).toBeNull();
      const result = await adopt();
      expect(result.status).toBe("installed");
      expect(cloud.secretWrites).toBe(secretWrites);
      expect(cloud.workers.size).toBe(2);
      expect(cloud.databases.size).toBe(1);
      expect(cloud.buckets.size).toBe(2);
      expect(cloud.queues.size).toBe(2);
      expect(cloud.workers.get("flare-runtime").namespace).toBe(namespace);
      expect(cloud.state().resources.catalog.id).toBe(
        state.resources.catalog.id,
      );
      expect(cloud.state().origin).toBe("operator");
      const after = cloud.mutationCount();
      expect(
        (await platform({ operation: "update", account }, deps)).unchanged,
      ).toBe(true);
      expect(cloud.mutationCount()).toBe(after);
      await rm(join(directory, "config"), { recursive: true, force: true });
      expect((await platform({ operation: "status", account }, deps)).id).toBe(
        result.id,
      );
    }));
  it.each([
    "owner",
    "secret",
    "binding",
    "issuer",
    "namespace",
    "endpoint",
    "domain",
    "rate",
  ])("rejects incompatible %s without writes", async (which) =>
    operatorContext(async ({ cloud, adopt }) => {
      const w = cloud.workers.get("flare-runtime");
      let options = {};
      if (which === "owner") options.owner = "other@example.test";
      if (which === "secret")
        w.settings.bindings = w.settings.bindings.filter(
          (b) => b.name !== "DEV_SIGNING_KEY",
        );
      if (which === "binding")
        w.settings.bindings.push({
          name: "EXTRA",
          type: "service",
          service: "other",
        });
      if (which === "issuer")
        w.settings.bindings.find((b) => b.name === "DEV_TOKEN_ISSUER").text =
          "https://different.example.test";
      if (which === "namespace")
        w.settings.bindings.find((b) => b.name === "SUPERVISORS").class_name =
          "Different";
      if (which === "endpoint") w.config.workers_dev = true;
      if (which === "domain")
        cloud.domains.find((d) => d.service === "flare-runtime").hostname =
          "different.example.test";
      if (which === "rate")
        w.settings.bindings.find(
          (b) => b.name === "RATE_LIMITER",
        ).simple.limit = 1;
      const writes = cloud.mutationCount();
      await expect(adopt(options)).rejects.toThrow();
      expect(cloud.mutationCount()).toBe(writes);
    }),
  );
  it("resumes a lost Runtime deploy acknowledgement without another Runtime deployment", async () =>
    operatorContext(async ({ cloud, adopt }) => {
      cloud.deploymentFailure = "runtime";
      await expect(adopt()).rejects.toThrow("acknowledgement");
      const count = cloud.deployments.length,
        version = cloud.workers.get("flare-runtime").version;
      await adopt();
      expect(cloud.deployments.length).toBe(count + 1);
      expect(cloud.workers.get("flare-runtime").version).toBe(version);
      expect(cloud.state().operation).toBeNull();
    }));
  it("upgrades an adopted layout without replacing identities or rate-limit namespace", async () =>
    operatorContext(async ({ cloud, adopt, deps }) => {
      await adopt();
      const target = await fixture("0.3.4", true);
      try {
        const before = cloud.state();
        await platform(
          { operation: "update", account, confirm: account },
          { ...deps, release: target.release },
        );
        expect(cloud.state().resources).toEqual(before.resources);
        expect(cloud.state().supervisorNamespace).toBe(
          before.supervisorNamespace,
        );
        expect(cloud.state().rateLimitNamespace).toBe(
          before.rateLimitNamespace,
        );
        expect(cloud.state().installed.version).toBe("0.3.4");
      } finally {
        await rm(target.directory, { recursive: true, force: true });
      }
    }));
});
