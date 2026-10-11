import { BackupStore, backupPrefix } from "./backups.js";
import { InvocationSummaries } from "./observability.js";
import { queueBatches, consumeBatch } from "./queue.js";
import { appPolicy, appSecret, outbound } from "./capabilities.js";
import {
  collectJobHistory,
  jobRetentionMs,
  releaseRetentionQuery,
} from "./retention.js";
import { needsSnapshot, SnapshotCache } from "./reactivity.js";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  Lifecycle,
  type Connection,
  type LifecycleJobContext,
} from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Scheduler } from "agents/schedules";
import {
  FlaredError,
  LIMITS,
  boundedJson,
  stableJson,
  assertPath,
  type Auth,
  type Json,
} from "../../sdk/src/protocol.js";
import type {
  FacetRpc,
  Invocation,
  OutboxJob,
} from "../../sdk/src/cloudflare.js";
import {
  digest,
  devToken,
  verifyDevToken,
  verifyJwt,
  validateOidc,
  origins,
  fail,
  jsonBody,
  status,
  capture,
  unwrap,
  type RpcResult,
  type Oidc,
} from "./security.js";
import {
  validateRelease,
  compatibleSchema,
  buildKey,
  buildPrefix,
  type ReleaseUpload,
} from "./release.js";
import { AliasRegistry, applicationRoute, projectAlias } from "./routing.js";
import {
  FileStore,
  fileInput,
  fileKey,
  fileOriginAllowed,
  receiveUpload,
} from "./files.js";
import { scopeForDeletion, eraseEnvironment } from "./maintenance.js";
export type ScopeConfig = {
  scope: string;
  origins: string[];
  oidc: Oidc | null;
};
interface Env {
  APP_CAPABILITIES?: string;
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace;
  BUNDLES: R2Bucket;
  FILES?: R2Bucket;
  JOBS: Queue;
  DEV_SIGNING_KEY: string;
  RUNTIME_URL: string;
  DASHBOARD_URL?: string;
  DEV_TOKEN_ISSUER?: string;
  RATE_LIMITER: RateLimit;
  ADMIN_API: { request(request: Request): Promise<Response> };
}
// A bounded per-isolate cache; cold aliases need one R2 read, not a catalog call.
const registries = new WeakMap<R2Bucket, AliasRegistry>();
function aliases(env: Env) {
  let registry = registries.get(env.BUNDLES);
  if (!registry) {
    registry = new AliasRegistry(env.BUNDLES);
    registries.set(env.BUNDLES, registry);
  }
  return registry;
}
type SupervisorApi = Pick<
  EnvironmentSupervisor,
  | "application"
  | "socketIdentity"
  | "configuration"
  | "configure"
  | "publish"
  | "activate"
  | "admin"
  | "authenticate"
  | "consumeTicket"
  | "ticket"
  | "call"
  | "job"
  | "destroy"
  | "fileCommand"
  | "scheduleCommand"
>;
function getSupervisor(
  env: Env,
  scope: string,
): SupervisorApi & { fetch(request: Request): Promise<Response> } {
  const stub = env.SUPERVISORS.getByName(scope) as unknown as {
    dispatch(op: string, args: any[]): Promise<RpcResult<any>>;
    fetch(request: Request): Promise<Response>;
  };
  return new Proxy(
    {} as SupervisorApi & { fetch(request: Request): Promise<Response> },
    {
      get: (_target, key) =>
        key === "fetch"
          ? (request: Request) => stub.fetch(request)
          : (...args: any[]) => stub.dispatch(String(key), args).then(unwrap),
    },
  );
}
type ConnectionAuth = {
  auth: Auth | null;
  expires: number | null;
  windowAt?: number;
  messages?: number;
};
type Job = { scope: string; job: OutboxJob };
export class AppOutbound extends WorkerEntrypoint<Env, { scope: string }> {
  fetch(request: Request) {
    return outbound(request, appPolicy(this.env, this.ctx.props.scope));
  }
}
export class DynamicTail extends WorkerEntrypoint<Env, { scope: string }> {
  tail(events: TraceItem[]) {
    for (const e of events.slice(0, 10)) {
      if (e.outcome === "ok" && !e.exceptions.length && !e.logs.length)
        continue;
      console.log({
        source: "flared-dynamic",
        scope: this.ctx.props.scope,
        outcome: e.outcome,
        exceptions: e.exceptions.slice(0, 5).map((x) => ({
          name: x.name.slice(0, 64),
          message: x.message.slice(0, 1024),
        })),
        logs: e.logs.slice(0, 20).map((x) => ({
          level: x.level,
          message: JSON.stringify(x.message).slice(0, 1024),
        })),
        truncated: e.logs.length > 20 || e.exceptions.length > 5,
      });
    }
  }
}
export class EnvironmentSupervisor extends DurableObject<Env> {
  async dispatch(op: string, args: any[]): Promise<RpcResult<any>> {
    return capture(async () => {
      await this.lifecycle.start();
      if (this.removed && op !== "destroy") {
        if (op === "job") return null; // Acknowledge stale queue deliveries.
        fail("NOT_FOUND");
      }
      if (
        ![
          "application",
          "socketIdentity",
          "configuration",
          "configure",
          "activate",
          "publish",
          "admin",
          "authenticate",
          "consumeTicket",
          "ticket",
          "call",
          "job",
          "destroy",
          "fileCommand",
          "scheduleCommand",
        ].includes(op)
      )
        fail("INVALID_OPERATION");
      return (this as any)[op](...args);
    });
  }

  private removed = false;
  private restoring = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly bootId = crypto.randomUUID();
  private activeActions = 0;
  private policyHash = "";
  private nextRetention = 0;
  private scopeConfig?: ScopeConfig;
  private activationState?: { active: string | null; candidate: string | null };
  private summaries = new InvocationSummaries(this.ctx.storage.sql);
  private releaseCache = new Map<
    string,
    { value: Omit<ReleaseUpload, "facet" | "action">; bytes: number }
  >();
  private releaseCacheBytes = 0;
  private runningJobs = new Map<string, Promise<unknown>>();
  readonly sockets = new WebSockets({
    protocol: false,
    handlers: {
      onConnect: async (connection, context) => {
        const state = JSON.parse(
          context.request.headers.get("x-flared-identity") ?? "null",
        ) as ConnectionAuth | null;
        if (!state || [...this.sockets.getConnections()].length > 100) {
          connection.close(1008, "Unauthorized");
          return;
        }
        connection.setState(state);
        await this.scheduleExpiry();
        connection.send('{"type":"ready"}');
      },
      onMessage: async (connection, message) => {
        await this.serial(async () => {
          try {
            const auth = this.connectionAuth(connection),
              state = connection.state as ConnectionAuth;
            const now = Date.now();
            if (!state.windowAt || now - state.windowAt >= 60000) {
              state.windowAt = now;
              state.messages = 0;
            }
            if ((state.messages ?? 0) >= 240) fail("TOO_LARGE");
            state.messages = (state.messages ?? 0) + 1;
            connection.setState(state);
            if (
              typeof message !== "string" ||
              new TextEncoder().encode(message).length > LIMITS.frameBytes
            )
              fail("TOO_LARGE");
            await this.message(connection, JSON.parse(message), auth);
          } catch (e) {
            const code = status(e).code;
            if (code === "UNAUTHORIZED" || code === "AUTH_EXPIRED") {
              connection.close(1008, "Expired");
              return;
            }
            connection.close(1002, "Invalid frame");
          }
        });
      },
      onClose: async (connection) => {
        if (this.removed) return;
        this.ctx.storage.sql.exec(
          "DELETE FROM subscriptions WHERE connection=?",
          connection.id,
        );
        await this.scheduleExpiry(connection.id);
      },
      onError: async (connection) => {
        if (this.removed) return;
        this.ctx.storage.sql.exec(
          "DELETE FROM subscriptions WHERE connection=?",
          connection.id,
        );
        await this.scheduleExpiry(connection.id);
      },
    },
  });
  readonly scheduler = new Scheduler({
    callbacks: {
      cron: async (payload: { id: string }, schedule: { time: number }) =>
        this.serial(async () => {
          this.assertAvailable();
          const row = this.ctx.storage.sql
            .exec("SELECT * FROM crons WHERE id=? AND enabled=1", payload.id)
            .toArray()[0];
          if (!row) return;
          await this.arm();
          await this.facet().enqueueJob({
            id: `cron-${payload.id}-${schedule.time}`,
            release: this.current(),
            path: String(row.path),
            args: JSON.parse(String(row.args)),
            auth: null,
            internal: true,
            dueAt: Date.now(),
          });
          await this.recover();
        }),
    },
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sockets)
    .use(this.scheduler);
  async onStart() {
    this.policyHash = await digest(
      stableJson(appPolicy(this.env, this.ctx.id.name!)),
    );
    this.removed =
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_flared_deleted'",
        )
        .toArray().length > 0;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS releases (hash TEXT PRIMARY KEY,metadata TEXT NOT NULL,at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS release_history (hash TEXT PRIMARY KEY,at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS activation (id INTEGER PRIMARY KEY,active TEXT,candidate TEXT)",
      "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY,auth TEXT NOT NULL,expires INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS subscriptions (connection TEXT,id TEXT,path TEXT,args TEXT,sent INTEGER NOT NULL DEFAULT -1,acked INTEGER NOT NULL DEFAULT -1,hash TEXT,pending INTEGER NOT NULL DEFAULT 0,dependencies TEXT,checked INTEGER NOT NULL DEFAULT -1,release TEXT,PRIMARY KEY(connection,id))",
      "CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS restore_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS backup_pins (id TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(id,target))",
      "CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,path TEXT,kind TEXT,status TEXT,ms INTEGER)",
    ])
      this.ctx.storage.sql.exec(sql);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO release_history SELECT releases.hash,releases.at FROM releases JOIN activation ON releases.hash=activation.active",
    );
    this.restoring = this.restoreState()?.status === "restoring";
    FileStore.initialize(this.ctx.storage);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS crons (name TEXT PRIMARY KEY,id TEXT NOT NULL,path TEXT NOT NULL,args TEXT NOT NULL,cron TEXT NOT NULL,enabled INTEGER NOT NULL,schedulerId TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS job_events (id TEXT PRIMARY KEY,path TEXT NOT NULL,release TEXT NOT NULL,dueAt INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS retention (id INTEGER PRIMARY KEY,next INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS receipts_at ON receipts(at)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS job_events_retention ON job_events(state,at)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS job_events_release ON job_events(release,state)",
    );
    this.nextRetention = Number(
      this.ctx.storage.sql
        .exec("SELECT next FROM retention WHERE id=1")
        .toArray()[0]?.next ?? 0,
    );
    const alive = new Set([...this.sockets.getConnections()].map((c) => c.id));
    for (const r of this.ctx.storage.sql.exec(
      "SELECT DISTINCT connection FROM subscriptions",
    ))
      if (!alive.has(String(r.connection)))
        this.ctx.storage.sql.exec(
          "DELETE FROM subscriptions WHERE connection=?",
          r.connection,
        );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  // Trusted control-plane RPC only: never routed from the public API.
  async destroy(scope: string) {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (this.activeActions || this.runningJobs.size) fail("CONFLICT");
      if (
        this.ctx.storage.sql.exec("SELECT 1 FROM backup_pins LIMIT 1").toArray()
          .length
      )
        fail("BACKUP_BUSY");
      if (
        !this.ctx.id.equals(
          this.env.SUPERVISORS.idFromName(scopeForDeletion(scope)),
        )
      )
        fail("FORBIDDEN");
      for (const connection of this.sockets.getConnections())
        connection.close(1008, "Project deleted");
      if (this.env.FILES) {
        const prefix = `files/${scopeForDeletion(scope)}/`;
        let cursor: string | undefined;
        do {
          const page = await this.env.FILES.list({ prefix, cursor });
          if (page.objects.length)
            await this.env.FILES.delete(page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      let buildCursor: string | undefined;
      do {
        const page = await this.env.BUNDLES.list({
          prefix: buildPrefix(scope),
          cursor: buildCursor,
        });
        if (page.objects.length)
          await this.env.BUNDLES.delete(
            page.objects.map((object) => object.key),
          );
        buildCursor = page.truncated ? page.cursor : undefined;
      } while (buildCursor);
      let backupCursor: string | undefined;
      do {
        const page = await this.env.BUNDLES.list({
          prefix: backupPrefix(scope),
          cursor: backupCursor,
        });
        if (page.objects.length)
          await this.env.BUNDLES.delete(page.objects.map((o) => o.key));
        backupCursor = page.truncated ? page.cursor : undefined;
      } while (backupCursor);
      await eraseEnvironment(this.ctx);
      this.removed = true;
      return { deleted: true, scope };
    });
  }
  private config(): ScopeConfig {
    if (this.scopeConfig) return this.scopeConfig;
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE id=1")
      .toArray()[0];
    if (!row) fail("NOT_FOUND");
    return (this.scopeConfig = JSON.parse(String(row.value)));
  }
  async configuration() {
    await this.lifecycle.start();
    return this.config();
  }
  async configure(config: ScopeConfig) {
    await this.lifecycle.start();
    origins(config.origins);
    if (config.oidc) validateOidc(config.oidc);
    return this.serial(async () => {
      this.scopeConfig = undefined;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO config VALUES (1,?)",
        stableJson(config),
      );
      for (const c of this.sockets.getConnections())
        c.close(1008, "Configuration changed");
      this.ctx.storage.sql.exec("DELETE FROM tickets");
      await this.ctx.storage.sync();
    });
  }
  private activation() {
    if (!this.activationState) {
      const row = this.ctx.storage.sql
        .exec("SELECT active,candidate FROM activation WHERE id=1")
        .toArray()[0];
      this.activationState = {
        active: row?.active == null ? null : String(row.active),
        candidate: row?.candidate == null ? null : String(row.candidate),
      };
    }
    return this.activationState;
  }
  private current() {
    const row = this.activation();
    if (!row.active && !row.candidate) fail("NOT_READY");
    return row.candidate ?? row.active!;
  }
  private metadata(
    hash = this.current(),
  ): Omit<ReleaseUpload, "facet" | "action"> {
    const cached = this.releaseCache.get(hash);
    if (cached) return cached.value;
    const encoded = String(
      this.ctx.storage.sql
        .exec("SELECT metadata FROM releases WHERE hash=?", hash)
        .one().metadata,
    );
    const value = JSON.parse(encoded),
      bytes = new TextEncoder().encode(encoded).length;
    while (
      this.releaseCache.size &&
      (this.releaseCache.size >= 4 || this.releaseCacheBytes + bytes > 4194304)
    ) {
      const key = this.releaseCache.keys().next().value!;
      this.releaseCacheBytes -= this.releaseCache.get(key)!.bytes;
      this.releaseCache.delete(key);
    }
    if (bytes <= 4194304) {
      this.releaseCache.set(hash, { value, bytes });
      this.releaseCacheBytes += bytes;
    }
    return value;
  }

  private loader(hash: string, role: "facet" | "action") {
    const meta = this.metadata(hash),
      scope = this.config().scope;
    return this.env.LOADER.get(
      `${scope}:${hash}:abi4:${this.policyHash}:${meta.release.compatibilityDate}:${role}`,
      async () => {
        const blob = await this.env.BUNDLES.get(buildKey(scope, hash, role));
        if (!blob) fail("NOT_READY");
        const code = await blob.text();
        if ((await digest(code)) !== meta.release.checksums[role])
          fail("INVALID_RELEASE");
        return {
          compatibilityDate: meta.release.compatibilityDate,
          mainModule: "app.js",
          modules: { "app.js": code },
          globalOutbound:
            role === "action" && appPolicy(this.env, scope).outbound.length
              ? (this.ctx.exports as any).AppOutbound({ props: { scope } })
              : null,
          limits: { cpuMs: 1000, subRequests: role === "facet" ? 0 : 100 },
          env: {
            RELEASE_ID: hash,
            ...(role === "action"
              ? {
                  CAPABILITY: (this.ctx.exports as any).AppCapability({
                    props: { scope },
                  }),
                }
              : {}),
          },
          tails: [(this.ctx.exports as any).DynamicTail({ props: { scope } })],
        };
      },
    );
  }
  private async action(hash: string, call: Invocation) {
    const stub = this.loader(hash, "action").getEntrypoint(
      "Action",
    ) as unknown as {
      invoke(call: Invocation): Promise<RpcResult<Json>>;
      execute(call: Invocation): Promise<Json>;
    };
    return unwrap(await stub.invoke(call));
  }
  private facet(): FacetRpc {
    return this.ctx.facets.get("app", () => ({
      class: this.loader(this.current(), "facet").getDurableObjectClass(
        "AppFacet",
      ),
    })) as unknown as FacetRpc;
  }

  private async invoke(call: Invocation) {
    const out = await this.facet().invoke(call);
    if (!out.ok) fail(out.code);
    return out.value;
  }
  private async inspect(input: any) {
    const out = await this.facet().administrative("inspect", input);
    if (!out.ok) fail(out.code);
    return out.value;
  }
  private async edit(input: any) {
    const out = await this.facet().administrative("edit", input);
    if (!out.ok) fail(out.code);
    return out.value;
  }
  private async finishActivation() {
    const row = this.activation();
    if (!row.candidate) return;
    try {
      await this.facet().snapshot();
      this.activationState = undefined;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO release_history VALUES (?,?)",
          row.candidate,
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "UPDATE activation SET active=candidate,candidate=NULL WHERE id=1",
        );
      });
      await this.ctx.storage.sync();
    } catch (e) {
      this.ctx.facets.abort("app", e);
      this.activationState = undefined;
      this.ctx.storage.sql.exec(
        "UPDATE activation SET candidate=NULL WHERE id=1",
      );
      await this.ctx.storage.sync();
      throw e;
    }
  }
  async activate(metadata: Omit<ReleaseUpload, "facet" | "action">) {
    await this.lifecycle.start();
    return this.serial(async () => {
      this.assertAvailable();
      return this.activateLocked(metadata);
    });
  }
  async publish(bundle: ReleaseUpload, expected: string) {
    await this.lifecycle.start();
    await validateRelease(bundle);
    return this.serial(async () => {
      this.assertAvailable();
      await this.finishActivation();
      if (expected !== this.current()) fail("CONFLICT");
      for (const role of ["facet", "action"] as const)
        await this.env.BUNDLES.put(
          buildKey(this.config().scope, bundle.release.hash, role),
          bundle[role],
          { onlyIf: { etagDoesNotMatch: "*" } },
        );
      const { facet, action, ...metadata } = bundle;
      return this.activateLocked(metadata);
    });
  }
  private async activateLocked(
    metadata: Omit<ReleaseUpload, "facet" | "action">,
  ) {
    if (this.activeActions || this.runningJobs.size) fail("CONFLICT");
    await this.finishActivation();
    const row = this.ctx.storage.sql
      .exec("SELECT active FROM activation WHERE id=1")
      .toArray()[0];
    const old = row?.active ? this.metadata(String(row.active)) : null;
    if (old?.release.hash === metadata.release.hash)
      return { hash: metadata.release.hash, unchanged: true };
    compatibleSchema(old as ReleaseUpload | null, metadata as ReleaseUpload);
    for (const cron of this.ctx.storage.sql.exec(
      "SELECT path FROM crons WHERE enabled=1",
    ))
      if (
        metadata.manifest.runtimeAbi !== 4 ||
        metadata.manifest.functions[String(cron.path)]?.kind !== "action" ||
        metadata.manifest.functions[String(cron.path)]?.auth === "required"
      )
        fail("INVALID_RELEASE");
    if (old) {
      const references = await this.facet().pendingJobReferences();
      if (references.truncated) fail("LIMIT_EXCEEDED");
      for (const path of references.paths)
        if (metadata.manifest.functions[path]?.kind !== "action")
          fail("INVALID_RELEASE");
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO releases VALUES (?,?,?)",
      metadata.release.hash,
      stableJson(metadata),
      Date.now(),
    );
    this.activationState = undefined;
    this.ctx.storage.sql.exec(
      "INSERT INTO activation (id,candidate) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET candidate=excluded.candidate",
      metadata.release.hash,
    );
    await this.ctx.storage.sync();
    this.ctx.facets.abort("app", new Error("Release activation"));
    await this.finishActivation();
    if (!this.restoring) {
      await this.arm();
      await this.recover();
    }
    return { hash: metadata.release.hash, unchanged: false };
  }
  private async arm() {
    await this.lifecycle.jobs.push({
      id: "recover",
      fn: "recover",
      time: Date.now() + 2000,
      singleflight: true,
    });
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO recovery VALUES (1)");
    await this.ctx.storage.sync();
  }
  private connectionAuth(c: Connection): Auth | null {
    const s = c.state as ConnectionAuth | null;
    if (
      !s ||
      (s.auth &&
        (s.expires === null ||
          s.expires <= Date.now() ||
          s.auth.expiresAt <= Date.now()))
    )
      fail("AUTH_EXPIRED");
    return s.auth;
  }
  private async snapshot(c: Connection, row: any, cache = new SnapshotCache()) {
    const auth = this.connectionAuth(c),
      key = stableJson({ path: row.path, args: JSON.parse(row.args), auth });
    if (Number(row.sent) > Number(row.acked)) {
      this.ctx.storage.sql.exec(
        "UPDATE subscriptions SET pending=1 WHERE connection=? AND id=?",
        c.id,
        row.id,
      );
      return;
    }
    try {
      const { value: result, hash } = await cache.get(key, () =>
        this.invoke({
          path: row.path,
          kind: "query",
          args: JSON.parse(row.args),
          auth,
        }),
      );
      this.ctx.storage.sql.exec(
        "UPDATE subscriptions SET dependencies=?,checked=?,release=? WHERE connection=? AND id=?",
        JSON.stringify(result.tables),
        result.revision,
        this.current(),
        c.id,
        row.id,
      );
      if (row.hash === hash) {
        this.ctx.storage.sql.exec(
          "UPDATE subscriptions SET pending=0 WHERE connection=? AND id=?",
          c.id,
          row.id,
        );
        return;
      }
      c.send(
        boundedJson(
          {
            type: "snapshot",
            id: row.id,
            result: result.result,
            revision: result.revision,
          },
          LIMITS.outputBytes + 1024,
        ),
      );
      this.ctx.storage.sql.exec(
        "UPDATE subscriptions SET sent=?,hash=?,pending=0 WHERE connection=? AND id=?",
        result.revision,
        hash,
        c.id,
        row.id,
      );
    } catch (e) {
      c.send(
        JSON.stringify({ type: "error", id: row.id, code: status(e).code }),
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM subscriptions WHERE connection=? AND id=?",
        c.id,
        row.id,
      );
    }
  }
  private async scheduleExpiry(exclude?: string) {
    const times = [...this.sockets.getConnections()]
      .filter(
        (c) =>
          c.id !== exclude && (c.state as ConnectionAuth | null)?.auth != null,
      )
      .map((c) => (c.state as ConnectionAuth | null)?.expires ?? Date.now());
    if (!times.length) await this.lifecycle.jobs.cancel("expire");
    else
      await this.lifecycle.jobs.push({
        id: "expire",
        fn: "expire",
        time: Math.min(...times),
        singleflight: true,
      });
  }
  private async broadcast() {
    const connections = [...this.sockets.getConnections()];
    // New subscribers receive their own current snapshot; no work is owed to absent clients.
    if (!connections.length) return;
    const cache = new SnapshotCache();
    const { changes } = await this.facet().snapshot();
    const release = this.current();
    for (const c of connections) {
      try {
        this.connectionAuth(c);
      } catch {
        c.close(1008, "Expired");
        continue;
      }
      for (const row of this.ctx.storage.sql
        .exec("SELECT * FROM subscriptions WHERE connection=?", c.id)
        .toArray())
        if (
          needsSnapshot(
            {
              dependencies:
                row.dependencies == null ? null : String(row.dependencies),
              checked: Number(row.checked),
              release: row.release == null ? null : String(row.release),
            },
            release,
            changes,
          )
        )
          await this.snapshot(c, row, cache);
    }
  }
  private async recover() {
    this.assertAvailable();
    await this.finishActivation();
    const jobs = await this.facet().pendingJobs();
    let due = Infinity,
      sent = 0;
    const ready: OutboxJob[] = [];
    for (const job of jobs) {
      if (job.dueAt > Date.now()) {
        due = Math.min(due, job.dueAt);
        continue;
      }
      ready.push(job);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO job_events (id,path,release,dueAt,state,at) VALUES (?,?,?,?,?,?)",
        job.id,
        job.path,
        job.release,
        job.dueAt,
        "queued",
        Date.now(),
      );
    }
    const scope = this.config().scope;
    for (const batch of queueBatches(ready.map((job) => ({ scope, job })))) {
      // Delete the transactional outbox only after confirmed native delivery.
      // A crash/uncertain acknowledgement leaves entries for at-least-once retry.
      await this.env.JOBS.sendBatch(batch);
      await this.facet().markJobsSent(
        batch.map((message) => message.body.job.id),
      );
      sent += batch.length;
    }
    await this.broadcast();
    this.ctx.storage.sql.exec("DELETE FROM recovery");
    if (jobs.length === 100 && sent > 0) due = Math.min(due, Date.now() + 2000);
    if (Number.isFinite(due))
      await this.lifecycle.jobs.push({
        id: "recover",
        fn: "recover",
        time: due,
        singleflight: true,
      });
    else await this.lifecycle.jobs.cancel("recover");
  }
  async onJob({ job }: LifecycleJobContext) {
    await this.serial(async () => {
      if (job.fn === "recover") await this.recover();
      if (job.fn === "files-cleanup") await this.files().sweep();
      if (job.fn === "cron-reconcile") await this.reconcileCrons();
      if (job.fn === "expire") {
        let next = Infinity;
        for (const c of this.sockets.getConnections()) {
          const state = c.state as ConnectionAuth | null;
          if (!state) c.close(1008, "Expired");
          else if (state.auth) {
            if (state.expires === null || state.expires <= Date.now())
              c.close(1008, "Expired");
            else next = Math.min(next, state.expires);
          }
        }
        if (Number.isFinite(next))
          await this.lifecycle.jobs.push({
            id: "expire",
            fn: "expire",
            time: next,
            singleflight: true,
          });
      }
    });
  }
  private async message(c: Connection, frame: any, auth: Auth | null) {
    this.assertAvailable();
    if (
      !frame ||
      typeof frame.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(frame.id)
    )
      fail("INVALID_INPUT");
    if (frame.type === "unsubscribe") {
      this.ctx.storage.sql.exec(
        "DELETE FROM subscriptions WHERE connection=? AND id=?",
        c.id,
        frame.id,
      );
      return;
    }
    if (frame.type === "ack") {
      const row = this.ctx.storage.sql
        .exec(
          "SELECT * FROM subscriptions WHERE connection=? AND id=?",
          c.id,
          frame.id,
        )
        .toArray()[0];
      if (
        !row ||
        !Number.isSafeInteger(frame.revision) ||
        frame.revision !== Number(row.sent)
      )
        return;
      this.ctx.storage.sql.exec(
        "UPDATE subscriptions SET acked=? WHERE connection=? AND id=?",
        frame.revision,
        c.id,
        frame.id,
      );
      if (row.pending)
        await this.snapshot(c, { ...row, acked: frame.revision });
      return;
    }
    if (frame.type !== "subscribe") fail("INVALID_INPUT");
    assertPath(frame.path);
    if (this.metadata().manifest.functions[frame.path]?.auth === "internal")
      fail("UNAUTHORIZED");
    if (this.metadata().manifest.functions[frame.path]?.kind !== "query")
      fail("FUNCTION_NOT_FOUND");
    if (
      Number(
        this.ctx.storage.sql
          .exec("SELECT COUNT(*) n FROM subscriptions WHERE connection=?", c.id)
          .one().n,
      ) >= LIMITS.subscriptions
    )
      fail("TOO_LARGE");
    if (
      this.ctx.storage.sql
        .exec(
          "SELECT id FROM subscriptions WHERE connection=? AND id=?",
          c.id,
          frame.id,
        )
        .toArray().length
    )
      fail("INVALID_INPUT");
    const args = boundedJson(frame.args, LIMITS.frameBytes);
    this.ctx.storage.sql.exec(
      "INSERT INTO subscriptions (connection,id,path,args) VALUES (?,?,?,?)",
      c.id,
      frame.id,
      frame.path,
      args,
    );
    await this.snapshot(c, {
      id: frame.id,
      path: frame.path,
      args,
      sent: -1,
      acked: -1,
      hash: null,
    });
  }
  /** One native RPC per HTTP call/ticket/preflight: no D1 or repeated DO hops. */
  async application(input: {
    origin: string | null;
    authorization: string | null;
    operation: "call" | "ticket" | "preflight";
    body: any;
  }) {
    await this.lifecycle.start();
    let allowedOrigin: string | null = null;
    const response = await capture(async () => {
      const config = this.config();
      if (input.origin && !config.origins.includes(input.origin))
        fail("FORBIDDEN");
      allowedOrigin = input.origin;
      if (input.operation === "preflight") return null;
      if (input.authorization && !input.authorization.startsWith("Bearer "))
        fail("UNAUTHORIZED");
      const auth = await this.authenticate(
        input.authorization?.slice(7) ?? null,
      );
      if (input.operation === "ticket")
        return { result: await this.ticket(auth) };
      if (
        !input.body ||
        typeof input.body !== "object" ||
        Array.isArray(input.body)
      )
        fail("INVALID_INPUT");
      assertPath(input.body.path);
      if (!["query", "mutation", "action"].includes(input.body.kind))
        fail("INVALID_KIND");
      return this.call({
        path: input.body.path,
        kind: input.body.kind,
        args: input.body.args,
        auth,
      });
    });
    return { origin: allowedOrigin as string | null, response };
  }
  async socketIdentity(input: { origin: string | null; ticket: string }) {
    await this.lifecycle.start();
    const config = this.config();
    if (input.origin && !config.origins.includes(input.origin))
      fail("FORBIDDEN");
    return this.consumeTicket(input.ticket);
  }
  async authenticate(token: string | null): Promise<Auth | null> {
    await this.lifecycle.start();
    const config = this.config();
    if (!token) return null;
    try {
      return await verifyDevToken(
        token,
        this.env.DEV_SIGNING_KEY,
        this.env.DEV_TOKEN_ISSUER ?? this.env.RUNTIME_URL,
        config.scope,
      );
    } catch {
      if (!config.oidc) fail("UNAUTHORIZED");
      return verifyJwt(token, config.oidc);
    }
  }
  async ticket(auth: Auth | null) {
    await this.lifecycle.start();
    return this.serial(async () => {
      if ([...this.sockets.getConnections()].length >= 100) fail("TOO_LARGE");
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "DELETE FROM tickets WHERE expires<?",
        Date.now(),
      );
      if (
        Number(
          this.ctx.storage.sql.exec("SELECT COUNT(*) n FROM tickets").one().n,
        ) > 200
      )
        fail("TOO_LARGE");
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets VALUES (?,?,?)",
        id,
        stableJson(auth),
        Date.now() + 60000,
      );
      return { ticket: id };
    });
  }
  async consumeTicket(id: string) {
    await this.lifecycle.start();
    return this.serial(async () => {
      if ([...this.sockets.getConnections()].length >= 100) fail("TOO_LARGE");
      const row = this.ctx.storage.sql
        .exec("DELETE FROM tickets WHERE id=? RETURNING *", id)
        .toArray()[0];
      if (!row || Number(row.expires) <= Date.now()) fail("UNAUTHORIZED");
      const auth = JSON.parse(String(row.auth)) as Auth | null;
      // Public subscriptions have no authorization to expire. Native hibernation
      // keeps idle sockets without a forced reconnect or a recurring wake-up.
      const expires = auth?.expiresAt ?? null;
      if (expires !== null && expires <= Date.now()) fail("UNAUTHORIZED");
      return { auth, expires };
    });
  }
  async call(call: Invocation): Promise<{ result: Json; revision?: number }> {
    await this.lifecycle.start();
    // Admission and release pinning share one gate. Actions run outside it:
    // their runMutation/runQuery capabilities must be able to re-enter this DO.
    const admitted = await this.serial(async () => {
      this.assertAvailable();
      await this.finishActivation();
      assertPath(call.path);
      const definition = this.metadata().manifest.functions[call.path];
      if (!definition || definition.kind !== call.kind)
        fail("FUNCTION_NOT_FOUND");
      if (definition.auth === "internal" && !call.internal)
        fail("UNAUTHORIZED");
      if (definition.auth === "required" && !call.auth) fail("UNAUTHORIZED");
      if (call.auth && call.auth.expiresAt <= Date.now()) fail("AUTH_EXPIRED");
      if (call.kind === "action") {
        const hash = this.current();
        this.activeActions++;
        return { hash };
      }
      const started = Date.now();
      try {
        if (call.kind === "mutation") await this.arm();
        const result = await this.invoke(call);
        if (call.kind === "mutation") await this.recover();
        await this.record(call.path, call.kind, "ok", Date.now() - started);
        return { result: result.result, revision: result.revision };
      } catch (e) {
        await this.record(call.path, call.kind, "error", Date.now() - started);
        throw e;
      }
    });
    if (!("hash" in admitted)) return admitted;
    const started = Date.now();
    try {
      const result = await this.action(admitted.hash!, call);
      await this.event(call.path, "action", "ok", Date.now() - started);
      return { result };
    } catch (e) {
      await this.event(call.path, "action", "error", Date.now() - started);
      throw e;
    } finally {
      this.activeActions--;
    }
  }
  private async prune() {
    const now = Date.now();
    if (now < this.nextRetention) return;
    this.nextRetention = now + 86400000;
    try {
      const deleted = collectJobHistory(this.ctx.storage.sql, now);
      if (deleted >= 1000) this.nextRetention = now + 60000;
      const references = await this.facet().pendingJobReferences();
      if (!references.truncated) {
        const pending = new Set(references.releases);
        const candidates = this.ctx.storage.sql
          .exec(releaseRetentionQuery, now - jobRetentionMs)
          .toArray();
        for (const row of candidates)
          if (!pending.has(String(row.hash))) {
            const hash = String(row.hash),
              scope = this.config().scope;
            await this.env.BUNDLES.delete([
              buildKey(scope, hash, "facet"),
              buildKey(scope, hash, "action"),
            ]);
            this.ctx.storage.sql.exec(
              "DELETE FROM releases WHERE hash=?",
              row.hash,
            );
            this.ctx.storage.sql.exec(
              "DELETE FROM release_history WHERE hash=?",
              row.hash,
            );
            const cached = this.releaseCache.get(String(row.hash));
            if (cached) this.releaseCacheBytes -= cached.bytes;
            this.releaseCache.delete(String(row.hash));
          }
        if (candidates.length === 100)
          this.nextRetention = Math.min(this.nextRetention, now + 60000);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO retention VALUES (1,?) ON CONFLICT(id) DO UPDATE SET next=excluded.next",
        this.nextRetention,
      );
    } catch (error) {
      this.nextRetention = now + 60000;
      console.warn({ source: "flared-retention", code: status(error).code });
    }
  }
  private async record(
    path: string,
    kind: string,
    outcome: string,
    ms: number,
  ) {
    if (kind !== "query" || outcome !== "ok") await this.prune();
    this.summaries.record({ at: Date.now(), path, kind, status: outcome, ms });
  }
  private async event(path: string, kind: string, outcome: string, ms: number) {
    await this.serial(async () => this.record(path, kind, outcome, ms));
  }
  private assertAvailable() {
    if (this.restoring) fail("RESTORE_IN_PROGRESS");
  }
  private restoreState(): {
    id: string;
    source: string;
    status: "restoring" | "completed";
    hash: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM restore_state WHERE id=1")
      .toArray()[0];
    return row ? JSON.parse(String(row.value)) : null;
  }
  private async facetAdmin(op: string, input: any = {}) {
    return unwrap(await this.facet().administrative(op, input));
  }
  private assertQuiet() {
    if (
      this.activeActions ||
      this.runningJobs.size ||
      this.ctx.storage.sql
        .exec("SELECT 1 FROM job_events WHERE state!='completed' LIMIT 1")
        .toArray().length ||
      this.ctx.storage.sql
        .exec("SELECT 1 FROM crons WHERE enabled=1 LIMIT 1")
        .toArray().length ||
      this.ctx.storage.sql
        .exec("SELECT 1 FROM files WHERE state!='ready' LIMIT 1")
        .toArray().length
    )
      fail("BACKUP_BUSY");
  }
  private async createBackup(id: string) {
    this.assertAvailable();
    const store = new BackupStore(this.env.BUNDLES, this.env.FILES),
      scope = this.config().scope;
    const existing = await store.read(scope, id);
    if (existing) return store.summary(existing);
    this.assertQuiet();
    await this.finishActivation();
    const data = await this.facetAdmin("backup-export");
    const meta = this.metadata(),
      blobs = await Promise.all(
        ["facet", "action"].map(async (role) => {
          const object = await this.env.BUNDLES.get(
            buildKey(scope, meta.release.hash, role as "facet" | "action"),
          );
          if (!object) fail("INVALID_RELEASE");
          return object.text();
        }),
      );
    const bundle = { ...meta, facet: blobs[0], action: blobs[1] };
    await validateRelease(bundle);
    const files = this.ctx.storage.sql
      .exec(
        "SELECT id,name,type,size,createdAt FROM files WHERE state='ready' ORDER BY id LIMIT 101",
      )
      .toArray()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        type: String(row.type),
        size: Number(row.size),
        createdAt: Number(row.createdAt),
      }));
    return store.create(
      { format: 1, id, scope, at: Date.now(), bundle, data },
      files,
    );
  }
  private async restoreBackup(input: { id: string; source: string }) {
    const scope = this.config().scope,
      source = scopeForDeletion(input.source);
    if (source === scope || source.split("/")[0] !== scope.split("/")[0])
      fail("FORBIDDEN");
    const store = new BackupStore(this.env.BUNDLES, this.env.FILES),
      backup = await store.read(source, input.id);
    if (!backup) fail("NOT_FOUND");
    const state = this.restoreState();
    if (
      state?.id === input.id &&
      state.source === source &&
      state.status === "completed"
    ) {
      await this.ctx.storage.sync();
      this.restoring = false;
      return { ...state, unchanged: true };
    }
    if (
      state &&
      (state.status === "completed" ||
        state.id !== input.id ||
        state.source !== source)
    )
      fail("RESTORE_NOT_EMPTY");
    if (!state) {
      this.assertQuiet();
      await this.finishActivation();
      if (
        this.ctx.storage.sql.exec("SELECT 1 FROM files LIMIT 1").toArray()
          .length ||
        this.ctx.storage.sql.exec("SELECT 1 FROM crons LIMIT 1").toArray()
          .length ||
        !(await this.facetAdmin("backup-empty"))
      )
        fail("RESTORE_NOT_EMPTY");
      // Persist the fence before any copied bytes/code/data. A restart fails closed;
      // retry the same ID, never expose a half-restored environment.
      this.ctx.storage.sql.exec(
        "INSERT INTO restore_state VALUES (1,?)",
        stableJson({
          id: input.id,
          source,
          status: "restoring",
          hash: backup.bundle.release.hash,
        }),
      );
      this.restoring = true;
      await this.ctx.storage.sync();
      for (const c of this.sockets.getConnections())
        c.close(1012, "Restore in progress");
      this.ctx.storage.sql.exec("DELETE FROM tickets");
      this.ctx.storage.sql.exec("DELETE FROM subscriptions");
    }
    await store.copyFiles(backup, scope);
    for (const role of ["facet", "action"] as const) {
      const encoded = backup.bundle[role];
      await this.env.BUNDLES.put(
        buildKey(scope, backup.bundle.release.hash, role),
        encoded,
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
    }
    const { facet, action, ...metadata } = backup.bundle;
    await this.activateLocked(metadata);
    await this.facetAdmin("backup-restore", {
      id: input.id,
      snapshot: backup.data,
    });
    const complete = {
      id: input.id,
      source,
      status: "completed",
      hash: backup.bundle.release.hash,
    };
    this.ctx.storage.transactionSync(() => {
      for (const file of backup.files)
        this.ctx.storage.sql.exec(
          "INSERT INTO files VALUES (?,?,?,?,?,?,0)",
          file.id,
          file.name,
          file.type,
          file.size,
          "ready",
          file.createdAt,
        );
      this.ctx.storage.sql.exec(
        "UPDATE restore_state SET value=? WHERE id=1",
        stableJson(complete),
      );
    });
    await this.ctx.storage.sync();
    this.restoring = false;
    return { ...complete, unchanged: false };
  }
  async admin(op: string, input: any): Promise<any> {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (op === "release-export") {
        if (
          !this.ctx.storage.sql
            .exec(
              "SELECT 1 FROM release_history WHERE hash=?",
              input.hash ?? this.current(),
            )
            .toArray().length
        )
          fail("NOT_FOUND");
        this.assertAvailable();
        await this.finishActivation();
        const meta = this.metadata(input.hash ?? this.current());
        const bundle: ReleaseUpload = { ...meta, facet: "", action: "" };
        for (const role of ["facet", "action"] as const) {
          const blob = await this.env.BUNDLES.get(
            buildKey(this.config().scope, meta.release.hash, role),
          );
          if (!blob) fail("NOT_FOUND");
          bundle[role] = await blob.text();
        }
        await validateRelease(bundle);
        return JSON.parse(stableJson(bundle));
      }
      if (op === "release-details") {
        if (
          !this.ctx.storage.sql
            .exec("SELECT 1 FROM release_history WHERE hash=?", input.hash)
            .toArray().length
        )
          fail("NOT_FOUND");
        const meta = this.metadata(input.hash);
        return JSON.parse(stableJson(meta));
      }
      if (op === "release-rollback") {
        this.assertAvailable();
        await this.finishActivation();
        if (
          !this.ctx.storage.sql
            .exec("SELECT 1 FROM release_history WHERE hash=?", input.hash)
            .toArray().length
        )
          fail("NOT_FOUND");
        if (input.expected !== this.current()) fail("CONFLICT");
        // Historical code still passes the same native schema/job checks as a new deploy.
        for (const role of ["facet", "action"] as const)
          if (
            !(await this.env.BUNDLES.head(
              buildKey(this.config().scope, input.hash, role),
            ))
          )
            fail("NOT_FOUND");
        return this.activateLocked(this.metadata(input.hash));
      }
      if (op === "backup-create") return this.createBackup(input.id);
      if (op === "backup-list")
        return new BackupStore(this.env.BUNDLES, this.env.FILES).list(
          this.config().scope,
          input.cursor,
        );
      if (op === "backup-pin") {
        const target = scopeForDeletion(input.target),
          scope = this.config().scope;
        if (target === scope || target.split("/")[0] !== scope.split("/")[0])
          fail("FORBIDDEN");
        if (
          !(await new BackupStore(this.env.BUNDLES, this.env.FILES).read(
            scope,
            input.id,
          ))
        )
          fail("NOT_FOUND");
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO backup_pins VALUES (?,?)",
          input.id,
          target,
        );
        await this.ctx.storage.sync();
        return { pinned: true };
      }
      if (op === "backup-unpin") {
        this.ctx.storage.sql.exec(
          "DELETE FROM backup_pins WHERE id=? AND target=?",
          input.id,
          input.target,
        );
        await this.ctx.storage.sync();
        return { pinned: false };
      }
      if (op === "backup-delete") {
        if (
          this.ctx.storage.sql
            .exec("SELECT 1 FROM backup_pins WHERE id=? LIMIT 1", input.id)
            .toArray().length
        )
          fail("BACKUP_BUSY");
        return new BackupStore(this.env.BUNDLES, this.env.FILES).remove(
          this.config().scope,
          input.id,
        );
      }
      if (op === "backup-restore") return this.restoreBackup(input);
      if (op === "backup-status") return this.restoreState();
      if (op === "health") {
        const active = this.ctx.storage.sql
          .exec("SELECT active,candidate FROM activation WHERE id=1")
          .toArray()[0];
        return {
          bootId: this.bootId,
          status: this.restoring
            ? "restoring"
            : active?.candidate
              ? "activating"
              : active?.active
                ? "ready"
                : "not-deployed",
          active: active?.active ?? null,
          candidate: active?.candidate ?? null,
          connections: [...this.sockets.getConnections()].length,
          subscriptions: Number(
            this.ctx.storage.sql
              .exec("SELECT COUNT(*) n FROM subscriptions")
              .one().n,
          ),
          telemetry: "bounded-recent-invocations; not billing analytics",
        };
      }
      this.assertAvailable();
      await this.finishActivation();
      if (op === "schema" || op === "data") return this.inspect(input);
      if (op === "edit") {
        await this.arm();
        const result = await this.edit(input);
        await this.recover();
        return result;
      }
      if (op === "job-cancel") {
        if (
          typeof input.id !== "string" ||
          !/^[a-z0-9_-]{1,128}$/.test(input.id)
        )
          fail("INVALID_INPUT");
        await this.arm();
        const cancelled = await this.facet().cancelJob(input.id);
        await this.recover();
        return { cancelled };
      }
      if (op === "functions") return this.metadata().manifest;
      if (op === "logs") return this.summaries.list();
      if (op === "history")
        return this.ctx.storage.sql
          .exec(
            "SELECT hash,at FROM release_history ORDER BY at DESC,hash DESC LIMIT 5",
          )
          .toArray();
      if (op === "files") return this.files().list(input);
      if (op === "file-upload") return this.files().reserve(input);
      if (op === "file-download") return this.files().downloadUrl(input.id);
      if (op === "file-delete") return this.files().remove(input.id);
      if (op === "crons") return this.cronRows();
      if (op === "cron-set") return this.setCron(input);
      if (op === "cron-cancel") return this.cancelCron(input.name);
      if (op === "jobs")
        return {
          recent: this.ctx.storage.sql
            .exec("SELECT * FROM job_events ORDER BY at DESC LIMIT 100")
            .toArray(),
          crons: this.cronRows(),
          pending: await this.facet().pendingJobs(),
          receipts: this.ctx.storage.sql
            .exec("SELECT * FROM receipts ORDER BY at DESC LIMIT 50")
            .toArray(),
          delivery: "at-least-once",
        };
      fail("INVALID_OPERATION");
    });
  }
  async job(job: OutboxJob) {
    await this.lifecycle.start();
    this.assertAvailable();
    const running = this.runningJobs.get(job.id);
    if (running) return running;
    const promise = this.executeJob(job);
    this.runningJobs.set(job.id, promise);
    try {
      return await promise;
    } finally {
      this.runningJobs.delete(job.id);
    }
  }
  private async executeJob(job: OutboxJob) {
    if (
      this.ctx.storage.sql
        .exec("SELECT id FROM receipts WHERE id=?", job.id)
        .toArray().length
    )
      return;
    await this.serial(() => this.prune());
    this.ctx.storage.sql.exec(
      "INSERT INTO job_events (id,path,release,dueAt,state,attempts,at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET state='running',attempts=attempts+1,at=excluded.at",
      job.id,
      job.path,
      job.release,
      job.dueAt,
      "running",
      Date.now(),
    );
    let result: Json;
    try {
      result = await this.action(job.release, {
        path: job.path,
        kind: "action",
        args: job.args,
        auth: job.auth,
        internal: job.internal,
      });
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE job_events SET state='failed',error=?,at=? WHERE id=?",
        status(error).code,
        Date.now(),
        job.id,
      );
      throw error;
    }
    await this.serial(async () => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO receipts VALUES (?,?)",
        job.id,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE job_events SET state='completed',error=NULL,at=? WHERE id=?",
        Date.now(),
        job.id,
      );
    });
    return result;
  }
  private files() {
    return new FileStore(
      this.ctx.storage,
      this.env.FILES,
      this.config().scope,
      this.env.RUNTIME_URL,
      (time) =>
        this.lifecycle.jobs.push({
          id: "files-cleanup",
          fn: "files-cleanup",
          time: Math.max(
            Date.now() + 1000,
            Math.min(
              time,
              Number(
                this.ctx.storage.sql
                  .exec("SELECT MIN(expires) n FROM files WHERE state!='ready'")
                  .one().n ?? Infinity,
              ) + 30000,
            ),
          ),
          singleflight: true,
        }),
    );
  }
  async fileCommand(op: string, input: any): Promise<any> {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (
        input?.origin &&
        !fileOriginAllowed(
          input.origin,
          this.config().origins,
          this.env.DASHBOARD_URL,
        )
      )
        fail("FORBIDDEN");
      this.assertAvailable();
      if (op === "preflight") return null;
      if (op === "reserve") return this.files().reserve(input);
      if (op === "list") return this.files().list(input);
      if (op === "delete") return this.files().remove(input.id);
      if (op === "download") return this.files().downloadUrl(input.id);
      if (op === "claim")
        return this.files().grant(input.ticket, input.operation);
      if (op === "complete") return this.files().complete(input.id);
      fail("INVALID_OPERATION");
    });
  }
  private cronRows() {
    return this.ctx.storage.sql
      .exec(
        "SELECT name,id,path,cron,enabled,schedulerId FROM crons ORDER BY name LIMIT 20",
      )
      .toArray()
      .map((row) => ({ ...row, enabled: Number(row.enabled) === 1 }));
  }
  private async reconcileCrons() {
    const rows = this.ctx.storage.sql.exec("SELECT * FROM crons").toArray();
    const enabled = new Set(
      rows.filter((r) => Number(r.enabled) === 1).map((r) => String(r.id)),
    );
    for (const schedule of await this.scheduler.list()) {
      const payload = schedule.payload as { id?: string };
      if (schedule.callback === "cron" && !enabled.has(payload?.id ?? ""))
        await this.scheduler.cancel(schedule.id);
    }
    for (const row of rows.filter((r) => Number(r.enabled) === 1)) {
      const schedule = await this.scheduler.set(
        String(row.cron),
        "cron",
        { id: String(row.id) },
        { idempotent: true },
      );
      this.ctx.storage.sql.exec(
        "UPDATE crons SET schedulerId=? WHERE id=?",
        schedule.id,
        row.id,
      );
    }
  }
  private async setCron(input: any) {
    this.assertAvailable();
    await this.finishActivation();
    if (this.metadata().manifest.runtimeAbi !== 4) fail("INVALID_RELEASE");
    if (
      !input ||
      typeof input.name !== "string" ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(input.name) ||
      typeof input.cron !== "string" ||
      input.cron.length > 100 ||
      input.cron.trim().split(/\s+/).length !== 5 ||
      !/^[0-9*,/\- ]+$/.test(input.cron)
    )
      fail("INVALID_INPUT");
    assertPath(input.path);
    const target = this.metadata().manifest.functions[input.path];
    if (!target || target.kind !== "action" || target.auth === "required")
      fail("INVALID_KIND");
    boundedJson(input.args, LIMITS.inputBytes);
    await this.facet().validateJob(input.path, input.args);
    const old = this.ctx.storage.sql
      .exec("SELECT * FROM crons WHERE name=?", input.name)
      .toArray()[0];
    if (
      !old &&
      Number(
        this.ctx.storage.sql.exec("SELECT COUNT(*) n FROM crons").one().n,
      ) >= 20
    )
      fail("TOO_LARGE");
    await this.lifecycle.jobs.push({
      id: "cron-reconcile",
      fn: "cron-reconcile",
      time: Date.now() + 1000,
      singleflight: true,
    });
    const id = crypto.randomUUID();
    // Validate with the native Scheduler before accepting the configuration.
    const schedule = await this.scheduler.set(
      input.cron,
      "cron",
      { id },
      { idempotent: true },
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO crons VALUES (?,?,?,?,?,1,?) ON CONFLICT(name) DO UPDATE SET id=excluded.id,path=excluded.path,args=excluded.args,cron=excluded.cron,enabled=1,schedulerId=excluded.schedulerId",
      input.name,
      id,
      input.path,
      stableJson(input.args),
      input.cron,
      schedule.id,
    );
    await this.reconcileCrons();
    return { id };
  }
  private async cancelCron(name: string) {
    if (typeof name !== "string") fail("INVALID_INPUT");
    await this.lifecycle.jobs.push({
      id: "cron-reconcile",
      fn: "cron-reconcile",
      time: Date.now() + 1000,
      singleflight: true,
    });
    this.ctx.storage.sql.exec("UPDATE crons SET enabled=0 WHERE name=?", name);
    await this.reconcileCrons();
    return true;
  }
  async scheduleCommand(op: string, input: any) {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (op === "set") return this.setCron(input);
      if (op === "cancel") return this.cancelCron(input.name);
      if (op === "list") return this.cronRows();
      fail("INVALID_OPERATION");
    });
  }
}
export class AppCapability extends WorkerEntrypoint<Env, { scope: string }> {
  async runQuery(path: string, args: Json, auth: Auth | null = null) {
    return (
      await getSupervisor(this.env, this.ctx.props.scope).call({
        path,
        kind: "query",
        args,
        auth,
        internal: true,
      })
    ).result;
  }
  async runMutation(path: string, args: Json, auth: Auth | null = null) {
    return (
      await getSupervisor(this.env, this.ctx.props.scope).call({
        path,
        kind: "mutation",
        args,
        auth,
        internal: true,
      })
    ).result;
  }
  secret(name: string) {
    return appSecret(this.env, this.ctx.props.scope, name);
  }
  fileCommand(op: string, input: any) {
    return getSupervisor(this.env, this.ctx.props.scope).fileCommand(op, input);
  }
  scheduleCommand(op: string, input: any) {
    return getSupervisor(this.env, this.ctx.props.scope).scheduleCommand(
      op,
      input,
    );
  }
  async upload(
    body: ReadableStream<Uint8Array>,
    type: string,
    options: { name: string; size: number },
  ) {
    const input = fileInput({ ...options, type });
    if (!this.env.FILES) fail("UNSUPPORTED");
    const supervisor = getSupervisor(this.env, this.ctx.props.scope);
    const grant = await supervisor.fileCommand("reserve", input);
    const ticket = new URL(grant.url).searchParams.get("ticket");
    const file = await supervisor.fileCommand("claim", {
      ticket,
      operation: "upload",
    });
    const key = fileKey(this.ctx.props.scope, file.id);
    await receiveUpload(
      new Request("https://files.internal", {
        method: "POST",
        body,
        headers: { "content-length": String(input.size) },
      }),
      this.env.FILES,
      key,
      input,
      () => supervisor.fileCommand("complete", { id: file.id }),
      () => supervisor.fileCommand("delete", { id: file.id }),
    );
    return String(file.id);
  }
  async download(id: string) {
    if (!this.env.FILES) fail("UNSUPPORTED");
    const grant = await this.fileCommand("download", { id });
    const file = await this.fileCommand("claim", {
      operation: "download",
      ticket: new URL(grant.url).searchParams.get("ticket"),
    });
    const object = await this.env.FILES.get(fileKey(this.ctx.props.scope, id));
    if (!object) fail("NOT_FOUND");
    return new Response(object.body, {
      headers: {
        "content-type": file.type,
        "content-length": String(object.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
export class RuntimeControl extends WorkerEntrypoint<Env> {
  async command(op: string, args: any[]): Promise<RpcResult<any>> {
    return capture(async () => {
      if (
        ![
          "configure",
          "deploy",
          "admin",
          "devIdentity",
          "publishAlias",
          "destroy",
        ].includes(op)
      )
        fail("INVALID_OPERATION");
      return (this as any)[op](...args);
    });
  }

  destroy(scope: string) {
    return getSupervisor(this.env, scopeForDeletion(scope)).destroy(scope);
  }
  configure(config: ScopeConfig) {
    return getSupervisor(this.env, config.scope).configure(config);
  }
  async publishAlias(alias: string, projectId: string) {
    projectAlias(alias);
    const config = await getSupervisor(
      this.env,
      `${projectId}/dev`,
    ).configuration();
    if (config.scope !== `${projectId}/dev`) fail("NOT_READY");
    await aliases(this.env).publish(alias, projectId);
  }
  async deploy(scope: string, bundle: ReleaseUpload, expected?: string) {
    await validateRelease(bundle);
    if (expected !== undefined)
      return getSupervisor(this.env, scope).publish(bundle, expected);
    for (const role of ["facet", "action"] as const)
      await this.env.BUNDLES.put(
        buildKey(scope, bundle.release.hash, role),
        bundle[role],
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
    const { facet, action, ...metadata } = bundle;
    return getSupervisor(this.env, scope).activate(metadata);
  }
  async admin(scope: string, op: string, input: any): Promise<any> {
    if (op === "release-promote") {
      const project = scopeForDeletion(scope).split("/")[0];
      if (!scope.endsWith("/prod")) fail("FORBIDDEN");
      const target = getSupervisor(this.env, scope);
      // Source serial gate captures immutable bytes before the target switches.
      const bundle = await getSupervisor(this.env, project + "/dev").admin(
        "release-export",
        { hash: input.hash },
      );
      // expected-active is checked at the target serial gate, not in D1.
      return target.publish(bundle, input.expected);
    }
    if (op !== "backup-restore")
      return getSupervisor(this.env, scope).admin(op, input);
    scopeForDeletion(scope);
    const source = scopeForDeletion(input.source);
    if (source === scope || source.split("/")[0] !== scope.split("/")[0])
      fail("FORBIDDEN");
    const from = getSupervisor(this.env, source),
      target = getSupervisor(this.env, scope);
    // Pin through the source's serial gate before touching the target. No nested
    // cross-DO gates: concurrent restore requests cannot form an RPC cycle.
    await from.admin("backup-pin", { id: input.id, target: scope });
    try {
      const result = await target.admin(op, input);
      await from.admin("backup-unpin", { id: input.id, target: scope });
      return result;
    } catch (error) {
      const state = await target
        .admin("backup-status", {})
        .catch(() => ({ status: "unavailable" }));
      if (
        state &&
        state.status === "restoring" &&
        state.id === input.id &&
        state.source === source
      )
        throw error;
      // If status is unavailable, fail closed and keep the pin for an explicit retry.
      if (state?.status !== "unavailable")
        await from.admin("backup-unpin", { id: input.id, target: scope });
      throw error;
    }
  }
  devIdentity(scope: string, subject: string) {
    if (!scope.endsWith("/dev")) fail("FORBIDDEN");
    return devToken(
      this.env.DEV_SIGNING_KEY,
      this.env.DEV_TOKEN_ISSUER ?? this.env.RUNTIME_URL,
      scope,
      subject,
    );
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({
        service: "flared-runtime",
        version: "0.3.0",
        status: "service-reachable",
      });
    if (url.pathname.startsWith("/control/api/")) {
      if (!env.ADMIN_API) return new Response("Not ready", { status: 503 });
      if (
        !(await env.RATE_LIMITER.limit({
          key:
            "control:" + (request.headers.get("cf-connecting-ip") ?? "unknown"),
        }).then((x) => x.success))
      )
        return new Response("Rate limited", { status: 429 });
      const target = new URL(request.url);
      target.pathname = target.pathname.slice("/control".length);
      return env.ADMIN_API.request(new Request(target, request));
    }
    const route = applicationRoute(url.pathname);
    if (!route) return new Response("Not found", { status: 404 });
    if (
      !(await env.RATE_LIMITER.limit({
        key: request.headers.get("cf-connecting-ip") ?? "unknown",
      }).then((x) => x.success))
    )
      return new Response("Rate limited", { status: 429 });
    let scope = "";
    let origin: string | null = null;
    try {
      const projectId = route.id ?? (await aliases(env).resolve(route.alias!));
      if (!projectId) return new Response("Not found", { status: 404 });
      scope = `${projectId}/${route.env}`;
      const supervisor = getSupervisor(env, scope);
      const requestedOrigin = request.headers.get("origin");
      if (
        route.operation === "live" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        if (url.searchParams.has("__agents_transport")) fail("FORBIDDEN");
        const identity = await supervisor.socketIdentity({
          origin: requestedOrigin,
          ticket: url.searchParams.get("ticket") ?? "",
        });
        const headers = new Headers(request.headers);
        headers.set("x-flared-identity", stableJson(identity));
        return supervisor.fetch(new Request(request, { headers }));
      }
      if (route.operation.startsWith("files/")) {
        await supervisor.fileCommand("preflight", { origin: requestedOrigin });
        origin = requestedOrigin;
        const headers = new Headers({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          ...(origin
            ? { "access-control-allow-origin": origin, vary: "Origin" }
            : {}),
        });
        if (request.method === "OPTIONS") {
          headers.set("access-control-allow-methods", "POST, GET");
          headers.set("access-control-allow-headers", "Content-Type");
          return new Response(null, { status: 204, headers });
        }
        const operation = route.operation.slice(6);
        if (
          (operation === "upload" && request.method !== "POST") ||
          (operation === "download" && request.method !== "GET")
        )
          fail("INVALID_OPERATION");
        if (!env.FILES) fail("UNSUPPORTED");
        const file = await supervisor.fileCommand("claim", {
          operation,
          ticket: url.searchParams.get("ticket") ?? "",
          origin: requestedOrigin,
        });
        const key = fileKey(scope, file.id);
        if (operation === "upload") {
          const result = await receiveUpload(
            request,
            env.FILES,
            key,
            file,
            () => supervisor.fileCommand("complete", { id: file.id }),
            () => supervisor.fileCommand("delete", { id: file.id }),
          );
          return Response.json(result, { headers });
        }
        const object = await env.FILES.get(key);
        if (!object) fail("NOT_FOUND");
        headers.set("content-type", file.type);
        headers.set("content-length", String(object.size));
        headers.set(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        );
        headers.set("content-security-policy", "default-src 'none'; sandbox");
        return new Response(object.body, { headers });
      }
      if (!["POST", "OPTIONS"].includes(request.method))
        return new Response("Method not allowed", { status: 405 });
      const body =
        request.method === "OPTIONS" ? null : await jsonBody(request);
      const answer = await supervisor.application({
        origin: requestedOrigin,
        authorization: request.headers.get("authorization"),
        operation:
          request.method === "OPTIONS"
            ? "preflight"
            : route.operation === "live/ticket"
              ? "ticket"
              : "call",
        body,
      });
      origin = answer.origin;
      const result = unwrap(answer.response);
      const headers = new Headers({
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(origin
          ? { "access-control-allow-origin": origin, vary: "Origin" }
          : {}),
      });
      if (request.method === "OPTIONS") {
        headers.set("access-control-allow-methods", "POST");
        headers.set(
          "access-control-allow-headers",
          "Authorization, Content-Type",
        );
        headers.set("access-control-max-age", "600");
        return new Response(null, { status: 204, headers });
      }
      headers.set("content-type", "application/json");
      return new Response(boundedJson(result, LIMITS.outputBytes), { headers });
    } catch (e) {
      const out = status(e);
      if (out.status >= 500)
        console.error({ source: "flared-runtime", scope, code: out.code });
      return Response.json(
        { error: out.code },
        {
          status: out.status,
          headers: {
            "cache-control": "no-store",
            ...(origin
              ? { "access-control-allow-origin": origin, vary: "Origin" }
              : {}),
          },
        },
      );
    }
  },
  async queue(batch: MessageBatch<Job>, env: Env) {
    await consumeBatch(
      batch,
      (body) => getSupervisor(env, body.scope).job(body.job),
      (body, error) =>
        console.error({
          source: "flared-job",
          scope: body.scope,
          id: body.job.id,
          code: status(error).code,
        }),
    );
  },
};
