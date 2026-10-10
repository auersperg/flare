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
  compatibleMigration,
  type ReleaseUpload,
} from "./release.js";
import { AliasRegistry, applicationRoute, projectAlias } from "./routing.js";
import { scopeForDeletion, eraseEnvironment } from "./maintenance.js";
export type ScopeConfig = {
  scope: string;
  origins: string[];
  oidc: Oidc | null;
};
interface Env {
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace;
  BUNDLES: R2Bucket;
  JOBS: Queue;
  DEV_SIGNING_KEY: string;
  RUNTIME_URL: string;
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
  AppSupervisor,
  | "application"
  | "socketIdentity"
  | "configuration"
  | "configure"
  | "activate"
  | "admin"
  | "authenticate"
  | "consumeTicket"
  | "ticket"
  | "call"
  | "job"
  | "destroy"
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
  expires: number;
  windowAt?: number;
  messages?: number;
};
type Job = { scope: string; job: OutboxJob };
export class DynamicTail extends WorkerEntrypoint<Env, { scope: string }> {
  tail(events: TraceItem[]) {
    for (const e of events)
      console.log({
        source: "flared-dynamic",
        scope: this.ctx.props.scope,
        outcome: e.outcome,
        exceptions: e.exceptions.map((x) => ({
          name: x.name,
          message: x.message,
        })),
        logs: e.logs,
      });
  }
}
export class AppSupervisor extends DurableObject<Env> {
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
          "admin",
          "authenticate",
          "consumeTicket",
          "ticket",
          "call",
          "job",
          "destroy",
        ].includes(op)
      )
        fail("INVALID_OPERATION");
      return (this as any)[op](...args);
    });
  }

  private removed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly bootId = crypto.randomUUID();
  private activeActions = 0;
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
        await this.lifecycle.jobs.push({
          id: "expire",
          fn: "expire",
          time: Math.min(
            ...[...this.sockets.getConnections()].map(
              (c) =>
                (c.state as ConnectionAuth | null)?.expires ?? state.expires,
            ),
          ),
          singleflight: true,
        });
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
      onClose: (connection) => {
        if (this.removed) return;
        this.ctx.storage.sql.exec(
          "DELETE FROM subscriptions WHERE connection=?",
          connection.id,
        );
      },
      onError: (connection) => {
        if (this.removed) return;
        this.ctx.storage.sql.exec(
          "DELETE FROM subscriptions WHERE connection=?",
          connection.id,
        );
      },
    },
  });
  readonly scheduler = new Scheduler({ callbacks: {} });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sockets)
    .use(this.scheduler);
  onStart() {
    this.removed =
      this.ctx.storage.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_flared_deleted'",
        )
        .toArray().length > 0;
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS releases (hash TEXT PRIMARY KEY,metadata TEXT NOT NULL,at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS activation (id INTEGER PRIMARY KEY,active TEXT,candidate TEXT)",
      "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY,auth TEXT NOT NULL,expires INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS subscriptions (connection TEXT,id TEXT,path TEXT,args TEXT,sent INTEGER NOT NULL DEFAULT -1,acked INTEGER NOT NULL DEFAULT -1,hash TEXT,pending INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(connection,id))",
      "CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY,at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,path TEXT,kind TEXT,status TEXT,ms INTEGER)",
    ])
      this.ctx.storage.sql.exec(sql);
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
        !this.ctx.id.equals(
          this.env.SUPERVISORS.idFromName(scopeForDeletion(scope)),
        )
      )
        fail("FORBIDDEN");
      for (const connection of this.sockets.getConnections())
        connection.close(1008, "Project deleted");
      await eraseEnvironment(this.ctx);
      this.removed = true;
      return { deleted: true, scope };
    });
  }
  private config(): ScopeConfig {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM config WHERE id=1")
      .toArray()[0];
    if (!row) fail("NOT_FOUND");
    return JSON.parse(String(row.value));
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
  private current() {
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM activation WHERE id=1")
      .toArray()[0];
    if (!row?.active && !row?.candidate) fail("NOT_READY");
    return String(row.candidate ?? row.active);
  }
  private metadata(
    hash = this.current(),
  ): Omit<ReleaseUpload, "facet" | "action"> {
    return JSON.parse(
      String(
        this.ctx.storage.sql
          .exec("SELECT metadata FROM releases WHERE hash=?", hash)
          .one().metadata,
      ),
    );
  }
  private loader(hash: string, role: "facet" | "action") {
    const meta = this.metadata(hash),
      scope = this.config().scope;
    return this.env.LOADER.get(
      `${scope}:${hash}:config1:${meta.release.compatibilityDate}:${role}`,
      async () => {
        const blob = await this.env.BUNDLES.get(`releases/${hash}/${role}.js`);
        if (!blob) fail("NOT_READY");
        const code = await blob.text();
        if ((await digest(code)) !== meta.release.checksums[role])
          fail("INVALID_RELEASE");
        return {
          compatibilityDate: meta.release.compatibilityDate,
          mainModule: "app.js",
          modules: { "app.js": code },
          globalOutbound: null,
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
    // Old private releases did not provide error envelopes. Do not invalidate their ABI.
    if ((this.metadata(hash).manifest.runtimeAbi ?? 1) < 2)
      return stub.execute(call);
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
    const row = this.ctx.storage.sql
      .exec("SELECT * FROM activation WHERE id=1")
      .toArray()[0];
    if (!row?.candidate) return;
    try {
      await this.facet().snapshot();
      this.ctx.storage.sql.exec(
        "UPDATE activation SET active=candidate,candidate=NULL WHERE id=1",
      );
      await this.ctx.storage.sync();
    } catch (e) {
      this.ctx.facets.abort("app", e);
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
      if (this.activeActions || this.runningJobs.size) fail("CONFLICT");
      await this.finishActivation();
      const row = this.ctx.storage.sql
        .exec("SELECT active FROM activation WHERE id=1")
        .toArray()[0];
      const old = row?.active ? this.metadata(String(row.active)) : null;
      if (old?.release.hash === metadata.release.hash)
        return { hash: metadata.release.hash, unchanged: true };
      compatibleMigration(
        old as ReleaseUpload | null,
        metadata as ReleaseUpload,
        this.config().scope.endsWith("/prod"),
      );
      if (old) {
        for (const job of await this.facet().pendingJobs())
          if (
            !metadata.manifest.functions[job.path] ||
            metadata.manifest.functions[job.path].kind !== "action"
          )
            fail("INVALID_RELEASE");
      }
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO releases VALUES (?,?,?)",
        metadata.release.hash,
        stableJson(metadata),
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO activation (id,candidate) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET candidate=excluded.candidate",
        metadata.release.hash,
      );
      await this.ctx.storage.sync();
      this.ctx.facets.abort("app", new Error("Release activation"));
      await this.finishActivation();
      await this.arm();
      await this.recover();
      return { hash: metadata.release.hash, unchanged: false };
    });
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
      s.expires <= Date.now() ||
      (s.auth && s.auth.expiresAt <= Date.now())
    )
      fail("AUTH_EXPIRED");
    return s.auth;
  }
  private async snapshot(
    c: Connection,
    row: any,
    cache: Map<string, any> = new Map(),
  ) {
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
      let result = cache.get(key);
      if (!result) {
        result = await this.invoke({
          path: row.path,
          kind: "live",
          args: JSON.parse(row.args),
          auth,
        });
        cache.set(key, result);
      }
      const hash = await digest(stableJson(result.result));
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
          { type: "snapshot", id: row.id, ...result },
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
  private async broadcast() {
    const cache = new Map();
    for (const c of this.sockets.getConnections()) {
      try {
        this.connectionAuth(c);
      } catch {
        c.close(1008, "Expired");
        continue;
      }
      for (const row of this.ctx.storage.sql
        .exec("SELECT * FROM subscriptions WHERE connection=?", c.id)
        .toArray())
        await this.snapshot(c, row, cache);
    }
  }
  private async recover() {
    await this.finishActivation();
    const jobs = await this.facet().pendingJobs();
    let due = Infinity,
      sent = 0;
    for (const job of jobs) {
      if (job.dueAt > Date.now()) {
        due = Math.min(due, job.dueAt);
        continue;
      }
      await this.env.JOBS.send({ scope: this.config().scope, job });
      await this.facet().markJobSent(job.id);
      sent++;
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
  }
  async onJob({ job }: LifecycleJobContext) {
    await this.serial(async () => {
      if (job.fn === "recover") await this.recover();
      if (job.fn === "expire") {
        let next = Infinity;
        for (const c of this.sockets.getConnections()) {
          const state = c.state as ConnectionAuth | null;
          if (!state || state.expires <= Date.now()) c.close(1008, "Expired");
          else next = Math.min(next, state.expires);
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
    if (this.metadata().manifest.functions[frame.path]?.kind !== "live")
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
      const expires = auth?.expiresAt ?? Date.now() + 900000;
      if (expires <= Date.now()) fail("UNAUTHORIZED");
      return { auth, expires };
    });
  }
  async call(call: Invocation): Promise<{ result: Json; revision?: number }> {
    await this.lifecycle.start();
    const definition = await this.serial(async () => {
      await this.finishActivation();
      return this.metadata().manifest.functions[call.path];
    });
    if (!definition || definition.kind !== call.kind)
      fail("FUNCTION_NOT_FOUND");
    if (definition.auth === "required" && !call.auth) fail("UNAUTHORIZED");
    if (call.auth && call.auth.expiresAt <= Date.now()) fail("AUTH_EXPIRED");
    if (call.kind === "action") {
      const hash = await this.serial(async () => {
        await this.finishActivation();
        this.activeActions++;
        return this.current();
      });
      const started = Date.now();
      try {
        const result = await this.action(hash, call);
        await this.event(call.path, "action", "ok", Date.now() - started);
        return { result };
      } catch (e) {
        await this.event(call.path, "action", "error", Date.now() - started);
        throw e;
      } finally {
        this.activeActions--;
      }
    }
    return this.serial(async () => {
      await this.finishActivation();
      assertPath(call.path);
      if (!["query", "mutation"].includes(call.kind)) fail("INVALID_KIND");
      const started = Date.now();
      try {
        if (call.kind === "mutation") await this.arm();
        const result = await this.invoke(call);
        if (call.kind === "mutation") await this.recover();
        this.record(call.path, call.kind, "ok", Date.now() - started);
        return result;
      } catch (e) {
        this.record(call.path, call.kind, "error", Date.now() - started);
        throw e;
      }
    });
  }
  private record(path: string, kind: string, outcome: string, ms: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at,path,kind,status,ms) VALUES (?,?,?,?,?)",
      Date.now(),
      path,
      kind,
      outcome,
      ms,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0)-200 FROM events)",
    );
  }
  private async event(path: string, kind: string, outcome: string, ms: number) {
    await this.serial(async () => this.record(path, kind, outcome, ms));
  }
  async admin(op: string, input: any): Promise<any> {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (op === "health") {
        const active = this.ctx.storage.sql
          .exec("SELECT active,candidate FROM activation WHERE id=1")
          .toArray()[0];
        return {
          bootId: this.bootId,
          status: active?.active ? "ready" : "not-deployed",
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
      await this.finishActivation();
      if (op === "schema" || op === "data") return this.inspect(input);
      if (op === "edit") {
        await this.arm();
        const result = await this.edit(input);
        await this.recover();
        return result;
      }
      if (op === "functions") return this.metadata().manifest;
      if (op === "logs")
        return this.ctx.storage.sql
          .exec("SELECT * FROM events ORDER BY id DESC LIMIT 100")
          .toArray();
      if (op === "history")
        return this.ctx.storage.sql
          .exec("SELECT hash,at FROM releases ORDER BY at DESC LIMIT 50")
          .toArray();
      if (op === "jobs")
        return {
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
    const result = await this.action(job.release, {
      path: job.path,
      kind: "action",
      args: job.args,
      auth: job.auth,
    });
    await this.serial(async () => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO receipts VALUES (?,?)",
        job.id,
        Date.now(),
      );
    });
    return result;
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
      })
    ).result;
  }
  secret() {
    fail("UNSUPPORTED");
  }
  upload() {
    fail("UNSUPPORTED");
  }
  download() {
    fail("UNSUPPORTED");
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
  async deploy(scope: string, bundle: ReleaseUpload) {
    await validateRelease(bundle);
    for (const role of ["facet", "action"] as const)
      await this.env.BUNDLES.put(
        `releases/${bundle.release.hash}/${role}.js`,
        bundle[role],
        { onlyIf: { etagDoesNotMatch: "*" } },
      );
    const { facet, action, ...metadata } = bundle;
    return getSupervisor(this.env, scope).activate(metadata);
  }
  admin(scope: string, op: string, input: any): Promise<any> {
    return getSupervisor(this.env, scope).admin(op, input);
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
        version: "0.2.0",
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
    for (const m of batch.messages) {
      try {
        await getSupervisor(env, m.body.scope).job(m.body.job);
        m.ack();
      } catch (e) {
        console.error({
          source: "flared-job",
          scope: m.body.scope,
          id: m.body.job.id,
          code: status(e).code,
        });
        m.retry();
      }
    }
  },
};
