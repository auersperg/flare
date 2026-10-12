import coreRuntime, {
  EnvironmentSupervisor as NativeSupervisor,
  AppCapability as NativeCapability,
  RuntimeControl as NativeControl,
  DynamicTail,
  AppOutbound,
} from "../../packages/core/src/runtime.js";
export { DynamicTail, AppOutbound };
// Private test harness supplies native core bindings without changing the production implementation.
function coreEnv(env: any) {
  return {
    ...env,
    SUPERVISORS: env.APP_SUPERVISORS,
    DEV_SIGNING_KEY: env.KERNEL_TOKEN,
  };
}
export class AppSupervisor extends NativeSupervisor {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, coreEnv(env));
  }
  async admin(op: string, input: any) {
    try {
      return await super.admin(op, input);
    } catch (error) {
      console.error({
        source: "core-admin-test",
        op,
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
      });
      throw error;
    }
  }
  // Fault injection exists only in this private harness, never in core builds.
  async kernelCrashRelease(bundle: any, afterFacet: boolean) {
    await this.lifecycle.start();
    const { validateRelease, buildKey } =
      await import("../../packages/core/src/release.js");
    await validateRelease(bundle);
    const scope = (this as any).config().scope;
    for (const role of ["facet", "action"] as const)
      await this.env.BUNDLES.put(
        buildKey(scope, bundle.release.hash, role),
        bundle[role],
      );
    const original = (this as any).finishActivation.bind(this);
    (this as any).finishActivation = async () => {
      const candidate = this.ctx.storage.sql
        .exec("SELECT candidate FROM activation WHERE id=1")
        .toArray()[0]?.candidate;
      if (!candidate) return original();
      if (afterFacet) await (this as any).facet().snapshot();
      await this.ctx.storage.sync();
      this.ctx.abort("Controlled release activation crash");
    };
    const { facet, action, ...metadata } = bundle;
    return super.activate(metadata);
  }
  kernelAbort() {
    this.ctx.abort("Controlled restore crash proof");
  }
  async kernelState() {
    await this.lifecycle.start();
    return {
      alarm: await this.ctx.storage.getAlarm(),
      jobs: this.lifecycle.jobs.list(),
    };
  }
}
export class AppCapability extends NativeCapability {
  constructor(ctx: ExecutionContext, env: any) {
    super(ctx, coreEnv(env));
  }
}
export class RuntimeControl extends NativeControl {
  constructor(ctx: ExecutionContext, env: any) {
    super(ctx, coreEnv(env));
  }
}
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  Lifecycle,
  type Connection,
  type LifecycleJobContext,
} from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Scheduler } from "agents/schedules";
import { receiveUpload } from "../../packages/core/src/files.js";
import { fail } from "../../packages/core/src/security.js";
import type {
  FacetRpc,
  Invocation,
} from "../../packages/flare/src/sdk/cloudflare.js";

interface Env {
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace<KernelSupervisor>;
  APP_SUPERVISORS: DurableObjectNamespace;
  BUNDLES: R2Bucket;
  JOBS: Queue;
  KERNEL_TOKEN: string;
}
type Release = { hash: string; code: string; version: number };
type Job = { scope: string; id: string; release: number };
interface Facet {
  snapshot(): Promise<Record<string, unknown>>;
  mutate(options: {
    fail?: boolean;
    job?: string;
    appliedJob?: string;
  }): Promise<Record<string, unknown>>;
  pending(): Promise<{ id: string; release: number }[]>;
  markSent(id: string): Promise<void>;
  deniedFetch(): Promise<{ denied: boolean }>;
  parentIsolated(): Promise<boolean>;
}
export class KernelTail extends WorkerEntrypoint<Env, { scope: string }> {
  tail(events: TraceItem[]) {
    for (const event of events) {
      console.log({
        source: "flare-kernel-tail",
        scope: this.ctx.props.scope,
        outcome: event.outcome,
        exceptions: event.exceptions.map((e) => ({
          name: e.name,
          message: e.message,
        })),
        logs: event.logs.map((log) => ({
          level: log.level,
          message: log.message,
        })),
      });
    }
  }
}

export class KernelSupervisor extends DurableObject<Env> {
  readonly boot = crypto.randomUUID();
  private tail: Promise<unknown> = Promise.resolve();
  readonly sockets = new WebSockets({
    protocol: false,
    handlers: {
      onConnect: async (connection: Connection) => {
        connection.setState({ expires: Date.now() + 3600000 });
        connection.send(
          JSON.stringify({
            type: "ready",
            connection: connection.id,
            boot: this.boot,
          }),
        );
      },
      onMessage: async (
        connection: Connection,
        message: string | ArrayBuffer | ArrayBufferView,
      ) => {
        const state = connection.state as { expires: number } | null;
        if (!state || state.expires < Date.now()) {
          connection.close(1008, "Expired");
          return;
        }
        if (typeof message !== "string" || message.length > 8192) {
          connection.close(1009, "Too large");
          return;
        }
        await this.serial(async () => {
          const frame = JSON.parse(message);
          if (frame.type === "snapshot")
            connection.send(
              JSON.stringify({
                type: "snapshot",
                boot: this.boot,
                value: await this.facet().snapshot(),
              }),
            );
        });
      },
    },
  });
  readonly scheduler = new Scheduler({
    callbacks: {
      increment: async (payload: { id: string }) => {
        await this.serial(async () => {
          await this.armRecovery();
          await this.facet().mutate({ appliedJob: payload.id });
          await this.recover();
        });
      },
    },
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.sockets)
    .use(this.scheduler);

  onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS supervisor_secret (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO supervisor_secret VALUES (1,'not-for-facet')",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS releases (version INTEGER PRIMARY KEY, hash TEXT NOT NULL, code TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS job_receipts (id TEXT PRIMARY KEY, release INTEGER NOT NULL)",
    );
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private release(version?: number): Release {
    const row =
      version === undefined
        ? this.ctx.storage.sql
            .exec(
              "SELECT * FROM releases WHERE version=(SELECT CAST(value AS INTEGER) FROM platform_config WHERE key='active')",
            )
            .one()
        : this.ctx.storage.sql
            .exec("SELECT * FROM releases WHERE version=?", version)
            .one();
    return row as unknown as Release;
  }
  private loader(release: Release, role: string) {
    const id = `${this.ctx.id.name}:${release.hash}:config1:2026-10-10:${role}`;
    return this.env.LOADER.get(id, () => ({
      compatibilityDate: "2026-10-10",
      mainModule: "app.js",
      modules: { "app.js": release.code },
      globalOutbound: null,
      env: { RELEASE_ID: release.hash },
      tails: [
        this.ctx.exports.KernelTail({
          props: { scope: this.ctx.id.name ?? "unknown" },
        }),
      ],
    }));
  }
  private facet(): Facet {
    return this.ctx.facets.get("app", () => ({
      class: this.loader(this.release(), "facet").getDurableObjectClass(
        "AppFacet",
      ),
    })) as unknown as Facet;
  }
  private async armRecovery() {
    await this.lifecycle.jobs.push({
      id: "recover",
      fn: "recover",
      time: Date.now() + 2000,
      singleflight: true,
    });
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO recovery VALUES (1)");
    await this.ctx.storage.sync();
  }
  private async recover() {
    for (const job of await this.facet().pending()) {
      await this.env.JOBS.send({
        scope: this.ctx.id.name,
        id: job.id,
        release: job.release,
      });
      await this.facet().markSent(job.id);
    }
    const value = await this.facet().snapshot();
    for (const connection of this.sockets.getConnections<{
      expires: number;
    }>()) {
      if (connection.state && connection.state.expires > Date.now())
        connection.send(
          JSON.stringify({ type: "snapshot", boot: this.boot, value }),
        );
    }
    this.ctx.storage.sql.exec("DELETE FROM recovery");
  }
  async onJob({ job }: LifecycleJobContext) {
    if (job.fn === "recover") await this.serial(() => this.recover());
  }
  async consumeTicket(id: string) {
    await this.lifecycle.start();
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec("DELETE FROM tickets WHERE id=? RETURNING expires", id)
        .toArray()[0];
      return !!row && Number(row.expires) > Date.now();
    });
  }
  async executeJob(job: Job) {
    await this.lifecycle.start();
    return this.serial(async () => {
      if (
        this.ctx.storage.sql
          .exec("SELECT id FROM job_receipts WHERE id=?", job.id)
          .toArray().length
      )
        return;
      const action = this.loader(
        this.release(job.release),
        "action",
      ).getEntrypoint("Action") as unknown as {
        run(payload: { id: string }): Promise<{ id: string; release: number }>;
      };
      const result = await action.run({ id: job.id });
      await this.armRecovery();
      await this.facet().mutate({ appliedJob: result.id });
      this.ctx.storage.sql.exec(
        "INSERT INTO job_receipts VALUES (?,?)",
        result.id,
        result.release,
      );
      await this.recover();
    });
  }
  async onRequest(request: Request): Promise<Response> {
    return this.serial(async () => {
      const { op, ...input } = (await request.json()) as Record<string, any>;
      if (op === "release") {
        const blob = await this.env.BUNDLES.get(input.key);
        if (!blob)
          return Response.json({ error: "Missing bundle" }, { status: 404 });
        const code = await blob.text();
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(code),
            ),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (hash !== input.hash)
          return Response.json({ error: "Hash mismatch" }, { status: 400 });
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS platform_config (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO releases VALUES (?,?,?)",
          input.version,
          hash,
          code,
        );
        const old = this.ctx.storage.sql
          .exec("SELECT value FROM platform_config WHERE key='active'")
          .toArray()[0]?.value;
        this.ctx.facets.abort("app", new Error("Release activation"));
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO platform_config VALUES ('active',?)",
          String(input.version),
        );
        try {
          await this.facet().snapshot();
        } catch (error) {
          this.ctx.facets.abort("app", error);
          if (old)
            this.ctx.storage.sql.exec(
              "UPDATE platform_config SET value=? WHERE key='active'",
              old,
            );
          throw error;
        }
        return Response.json({
          ok: true,
          version: input.version,
          boot: this.boot,
        });
      }
      if (op === "ticket") {
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "DELETE FROM tickets WHERE expires<?",
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO tickets VALUES (?,?)",
          id,
          Date.now() + 60000,
        );
        return Response.json({ ticket: id });
      }
      if (op === "snapshot")
        return Response.json({
          parentBoot: this.boot,
          value: await this.facet().snapshot(),
        });
      // Private SDK acceptance harness; not a production application auth boundary.
      if (op === "sdk")
        return Response.json(
          await (this.facet() as unknown as FacetRpc).execute(
            input.call as Invocation,
          ),
        );
      if (op === "sdkPending")
        return Response.json(
          await (this.facet() as unknown as FacetRpc).pendingJobs(),
        );
      if (op === "mutate") {
        await this.armRecovery();
        const value = await this.facet().mutate(input);
        if (input.fault === "afterCommit")
          return Response.json(
            { error: "INJECTED_AFTER_COMMIT" },
            { status: 503 },
          );
        await this.recover();
        return Response.json(value);
      }
      if (op === "schedule")
        return Response.json(
          await this.scheduler.set(Number(input.delay), "increment", {
            id: input.id,
          }),
        );
      if (op === "receipts")
        return Response.json(
          this.ctx.storage.sql.exec("SELECT * FROM job_receipts").toArray(),
        );
      if (op === "boundaries")
        return Response.json({
          egress: await this.facet().deniedFetch(),
          parentIsolated: await this.facet().parentIsolated(),
        });
      if (op === "action") {
        const result = await (
          this.loader(this.release(), "action").getEntrypoint("Action") as any
        ).run({ id: input.id });
        return Response.json(result);
      }
      return Response.json({ error: "Unknown operation" }, { status: 400 });
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/p/"))
      return coreRuntime.fetch(request, coreEnv(env));
    if (url.pathname === "/health")
      return Response.json({ status: "kernel-only" });
    if (url.pathname === "/core" && request.method === "POST") {
      if (
        !env.KERNEL_TOKEN ||
        request.headers.get("Authorization") !== `Bearer ${env.KERNEL_TOKEN}`
      )
        return new Response("Unauthorized", { status: 401 });
      const input = await request.json<{ op: string; args: any[] }>();
      if (input.op === "backupBytes") {
        const [scope, id, file, bytes] = input.args;
        if (
          !/^[0-9a-f-]{36}\/(dev|prod)$/.test(scope) ||
          !/^[0-9a-f-]{36}$/.test(id) ||
          !/^[0-9a-f-]{36}$/.test(file) ||
          typeof bytes !== "string" ||
          bytes.length > 100
        )
          return new Response("Invalid", { status: 400 });
        await env.BUNDLES.put(`backups/${scope}/${id}/files/${file}`, bytes);
        return Response.json({ ok: true, value: null });
      }
      if (input.op === "kernelCrashRelease") {
        const [scope, bundle, afterFacet] = input.args;
        if (
          !/^[0-9a-f-]{36}\/(dev|prod)$/.test(scope) ||
          typeof afterFacet !== "boolean"
        )
          return new Response("Invalid", { status: 400 });
        let crashed = false;
        try {
          await (
            env.APP_SUPERVISORS.getByName(scope) as any
          ).kernelCrashRelease(bundle, afterFacet);
        } catch {
          crashed = true;
        }
        return Response.json({ ok: true, value: { crashed } });
      }
      if (input.op === "kernelAbort") {
        await (env.APP_SUPERVISORS.getByName(input.args[0]) as any)
          .kernelAbort()
          .catch(() => {});
        return Response.json({ ok: true, value: null });
      }
      if (input.op === "kernelState")
        return Response.json({
          ok: true,
          value: await (
            env.APP_SUPERVISORS.getByName(input.args[0]) as any
          ).kernelState(),
        });
      try {
        return Response.json(
          await (ctx.exports as any)
            .RuntimeControl({})
            .command(input.op, input.args),
        );
      } catch (error) {
        console.error({ source: "native-core-harness", error: String(error) });
        return Response.json({ error: "CORE_HARNESS_FAILED" }, { status: 500 });
      }
    }
    const scope = url.searchParams.get("scope");
    if (!scope || !/^[a-z0-9-]{1,64}\/(dev|prod)$/.test(scope))
      return new Response("Invalid scope", { status: 400 });
    const supervisor = env.SUPERVISORS.getByName(scope);
    if (request.headers.get("Upgrade") === "websocket") {
      if (
        url.searchParams.has("__agents_transport") ||
        !(await supervisor.consumeTicket(url.searchParams.get("ticket") ?? ""))
      )
        return new Response("Unauthorized", { status: 401 });
      return supervisor.fetch(request);
    }
    if (
      !env.KERNEL_TOKEN ||
      request.headers.get("Authorization") !== `Bearer ${env.KERNEL_TOKEN}`
    )
      return new Response("Unauthorized", { status: 401 });
    if (Number(request.headers.get("content-length") ?? 0) > 1024 * 1024)
      return new Response("Too large", { status: 413 });
    if (url.pathname === "/file-stream-proof" && request.method === "POST") {
      const key = `kernel-file-proof/${scope}/${crypto.randomUUID()}`;
      let removed = false;
      try {
        const bytes = new TextEncoder().encode("stream proof");
        const size = bytes.length + Number(url.searchParams.get("wrong") ?? 0);
        const upload = new Request("https://proof.invalid", {
          method: "POST",
          body: new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
        });
        await receiveUpload(
          upload,
          env.BUNDLES,
          key,
          {
            size,
            type: "text/plain",
          },
          async () => {
            if (url.searchParams.get("ack") === "lost") throw Error("ACK_LOST");
            if (url.searchParams.get("ack") === "deleted") fail("NOT_FOUND");
          },
          async () => {
            removed = true;
          },
        );
        return Response.json({
          text: await (await env.BUNDLES.get(key))!.text(),
        });
      } catch {
        return Response.json(
          {
            error: "UPLOAD_FAILED",
            preserved: !!(await env.BUNDLES.head(key)),
            removed,
          },
          { status: 400 },
        );
      } finally {
        await env.BUNDLES.delete(key);
      }
    }
    if (url.pathname === "/bundle" && request.method === "PUT") {
      const code = await request.text();
      if (code.length > 1024 * 1024)
        return new Response("Too large", { status: 413 });
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const key = `kernel/${hash}.js`;
      await env.BUNDLES.put(key, code, { onlyIf: { etagDoesNotMatch: "*" } });
      return Response.json({ key, hash });
    }
    try {
      const response = await supervisor.fetch(request);
      // Lifecycle may turn a thrown handler error into a plain-text 500.
      // Never forward framework diagnostics across the public HTTP boundary.
      if (response.status >= 500)
        return Response.json(
          { error: "KERNEL_OPERATION_FAILED" },
          { status: response.status },
        );
      return response;
    } catch (error) {
      console.error({ source: "flare-kernel", scope, error: String(error) });
      return Response.json(
        { error: "KERNEL_OPERATION_FAILED" },
        { status: 500 },
      );
    }
  },
  async queue(batch: MessageBatch<Job>, env: Env, ctx: ExecutionContext) {
    if (batch.messages.some((message) => (message.body as any).job))
      return coreRuntime.queue(batch as any, coreEnv(env));
    // Sequential handling obeys Dynamic Worker per-invocation concurrency limits.
    for (const message of batch.messages) {
      try {
        await env.SUPERVISORS.getByName(message.body.scope).executeJob(
          message.body,
        );
        message.ack();
      } catch (error) {
        console.error({ source: "flare-kernel-queue", error: String(error) });
        message.retry();
      }
    }
  },
};
