import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  flatten,
  validate,
  type ActionContext,
  type FunctionTree,
  type MutationContext,
  type QueryContext,
} from "./server.js";
import {
  FlaredError,
  type Auth,
  type FunctionKind,
  type Json,
} from "./protocol.js";
import { exportData, restoreData, emptyData } from "./backup.js";
import { database } from "./database.js";
import { applySchema, schemaContract, type Schema } from "./schema.js";
import { boundedJson, LIMITS } from "./protocol.js";

export interface Invocation {
  path: string;
  kind: FunctionKind;
  args: Json;
  auth: Auth | null;
  internal?: boolean;
}
export interface OutboxJob {
  id: string;
  release: string;
  path: string;
  args: Json;
  auth: Auth | null;
  dueAt: number;
  internal?: boolean;
}
export interface FacetRpc {
  snapshot(): Promise<{ revision: number; changes: Record<string, number> }>;
  execute(
    call: Invocation,
  ): Promise<{ result: Json; revision: number; tables: string[] }>;
  pendingJobs(limit?: number): Promise<OutboxJob[]>;
  markJobsSent(ids: string[]): Promise<void>;
  cancelJob(id: string): Promise<boolean>;
  pendingJobReferences(): Promise<{
    paths: string[];
    releases: string[];
    truncated: boolean;
  }>;
  enqueueJob(job: OutboxJob): Promise<void>;
  validateJob(path: string, args: Json): Promise<void>;
  inspect(input: {
    table?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<any>;
  edit(input: {
    table: string;
    operation: "insert" | "update" | "delete";
    values?: Record<string, Json>;
    key?: string;
    expectedRevision: number;
  }): Promise<any>;
  invoke(
    call: Invocation,
  ): Promise<
    | { ok: true; value: { result: Json; revision: number; tables: string[] } }
    | { ok: false; code: string }
  >;
  administrative(
    operation: string,
    input: any,
  ): Promise<{ ok: true; value: any } | { ok: false; code: string }>;
}
export type FacetConstructor = new (
  ctx: DurableObjectState,
  env: { RELEASE_ID: string },
) => DurableObject<{ RELEASE_ID: string }> & FacetRpc;
export type ActionConstructor = new (
  ctx: ExecutionContext,
  env: { CAPABILITY: ScopedCapability },
) => WorkerEntrypoint<{ CAPABILITY: ScopedCapability }> & {
  execute(call: Invocation): Promise<Json>;
  invoke(
    call: Invocation,
  ): Promise<{ ok: true; value: Json } | { ok: false; code: string }>;
};
export interface ScopedCapability {
  runQuery(path: string, args: unknown, auth?: Auth | null): Promise<any>;
  runMutation(path: string, args: unknown, auth?: Auth | null): Promise<any>;
  secret(name: string): Promise<string>;
  upload(
    body: ReadableStream<Uint8Array>,
    contentType: string,
    options: { name: string; size: number },
  ): Promise<string>;
  download(id: string): Promise<Response>;
  fileCommand(op: string, input: unknown): Promise<any>;
  scheduleCommand(op: string, input: unknown): Promise<any>;
}
function authorize(
  mode: "required" | "public" | "internal",
  auth: Auth | null,
  internal = false,
) {
  if (mode === "internal" && !internal)
    throw new FlaredError("UNAUTHORIZED", "Internal function");
  if (
    auth &&
    (!auth.subject ||
      !auth.issuer ||
      !Number.isFinite(auth.expiresAt) ||
      auth.expiresAt <= Date.now())
  )
    throw new FlaredError("AUTH_EXPIRED", "Authorization expired");
  if (mode === "required" && !auth)
    throw new FlaredError("UNAUTHORIZED", "Authentication required");
}

/** Construct the class at build time. Parent supplies a verified identity and release ID,
 * never D1, R2, secrets or its own storage bindings. The parent must arm recovery first. */
export function createFacet(app: {
  functions: FunctionTree;
  schema: Schema;
}): FacetConstructor {
  const functions = flatten(app.functions);
  const contract = schemaContract(app.schema);
  return class AppFacet extends DurableObject<{ RELEASE_ID: string }> {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(ctx: DurableObjectState, env: { RELEASE_ID: string }) {
      super(ctx, env);
      ctx.blockConcurrencyWhile(async () => {
        await applySchema(ctx.storage, app.schema);
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _flared_revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)",
        );
        ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO _flared_revision VALUES (1,0)",
        );
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _flared_outbox (id TEXT PRIMARY KEY, release TEXT NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, auth TEXT NOT NULL, dueAt INTEGER NOT NULL,internal INTEGER NOT NULL DEFAULT 0)",
        );
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _flared_changes (name TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
        );
        ctx.storage.sql.exec(
          "CREATE INDEX IF NOT EXISTS outbox_pending ON _flared_outbox(dueAt,id)",
        );
      });
    }
    private serial<T>(fn: () => Promise<T>) {
      const result = this.tail.then(fn);
      this.tail = result.catch(() => undefined);
      return result;
    }
    private revision() {
      return Number(
        this.ctx.storage.sql
          .exec("SELECT value FROM _flared_revision WHERE id=1")
          .one().value,
      );
    }
    snapshot() {
      return this.serial(async () => ({
        revision: this.revision(),
        changes: Object.fromEntries(
          this.ctx.storage.sql
            .exec("SELECT * FROM _flared_changes")
            .toArray()
            .map((row) => [String(row.name), Number(row.revision)]),
        ),
      }));
    }
    async invoke(call: Invocation) {
      try {
        return { ok: true as const, value: await this.execute(call) };
      } catch (error) {
        return {
          ok: false as const,
          code: error instanceof FlaredError ? error.code : "OPERATION_FAILED",
        };
      }
    }
    async administrative(operation: string, input: any) {
      try {
        const work: Record<string, () => Promise<any>> = {
          inspect: () => this.inspect(input),
          edit: () => this.edit(input),
          "backup-export": () =>
            this.serial(async () => exportData(this.ctx.storage, app.schema)),
          "backup-empty": () =>
            this.serial(async () => emptyData(this.ctx.storage, app.schema)),
          "backup-restore": () =>
            this.serial(() =>
              restoreData(
                this.ctx.storage,
                app.schema,
                input.id,
                input.snapshot,
              ),
            ),
        };
        if (!Object.hasOwn(work, operation))
          throw new FlaredError(
            "INVALID_OPERATION",
            "Unknown administrative capability",
          );
        return { ok: true as const, value: await work[operation]() };
      } catch (error) {
        return {
          ok: false as const,
          code: error instanceof FlaredError ? error.code : "OPERATION_FAILED",
        };
      }
    }
    execute(
      call: Invocation,
    ): Promise<{ result: Json; revision: number; tables: string[] }> {
      return this.serial(async () => {
        const fn = functions[call.path];
        if (!fn || fn.kind !== call.kind || call.kind === "action")
          throw new FlaredError(
            "FUNCTION_NOT_FOUND",
            "Data function not found",
          );
        authorize(fn.auth, call.auth, call.internal);
        const args = await validate(fn.input, call.args);
        if (call.kind === "query") {
          return this.ctx.storage.transaction(async () => {
            const tables = new Set<string>();
            const capability = database(
              this.ctx.storage.sql,
              app.schema,
              false,
              tables,
            );
            try {
              const result = await validate(
                fn.output,
                await fn.handler(
                  { db: capability.db, auth: call.auth } as QueryContext,
                  args,
                ),
                true,
              );
              await capability.finish();
              return { result, revision: this.revision(), tables: [...tables] };
            } finally {
              capability.revoke();
            }
          });
        }
        let result: Json = null;
        const changed = new Set<string>();
        await this.ctx.storage.transaction(async () => {
          let active = true;
          const scheduled: Promise<unknown>[] = [];
          const jobs: MutationContext["jobs"] = Object.freeze({
            cancel: (id: string) => {
              const pending = (async () => {
                if (!active)
                  throw new FlaredError(
                    "CAPABILITY_EXPIRED",
                    "Mutation invocation ended",
                  );
                if (scheduled.length >= 100)
                  throw new FlaredError(
                    "LIMIT_EXCEEDED",
                    "Maximum 100 job operations per mutation",
                  );
                return this.cancelPending(id);
              })();
              scheduled.push(pending);
              void pending.catch(() => undefined);
              return pending;
            },
            schedule: (path, jobArgs, options = {}) => {
              const pending = (async () => {
                if (!active)
                  throw new FlaredError(
                    "CAPABILITY_EXPIRED",
                    "Mutation invocation ended",
                  );
                if (scheduled.length >= 100)
                  throw new FlaredError(
                    "LIMIT_EXCEEDED",
                    "Maximum 100 jobs per mutation",
                  );
                const target = functions[path];
                if (!target || target.kind !== "action")
                  throw new FlaredError(
                    "FUNCTION_NOT_FOUND",
                    "Scheduled action not found",
                  );
                const delay = options.delaySeconds ?? 0;
                if (!Number.isFinite(delay) || delay < 0 || delay > 31536000)
                  throw new FlaredError("INVALID_INPUT", "Invalid job delay");
                const input = await validate(target.input, jobArgs);
                if (!active)
                  throw new FlaredError(
                    "CAPABILITY_EXPIRED",
                    "Mutation invocation ended",
                  );
                const id = crypto.randomUUID();
                this.ctx.storage.sql.exec(
                  "INSERT INTO _flared_outbox (id,release,path,args,auth,dueAt) VALUES (?,?,?,?,?,?)",
                  id,
                  this.env.RELEASE_ID,
                  path,
                  JSON.stringify(input),
                  JSON.stringify(call.auth),
                  Date.now() + Math.ceil(delay * 1000),
                );
                if (target.auth === "internal")
                  this.ctx.storage.sql.exec(
                    "UPDATE _flared_outbox SET internal=1,auth='null' WHERE id=?",
                    id,
                  );
                return id;
              })();
              scheduled.push(pending);
              void pending.catch(() => undefined);
              return pending;
            },
          });
          const capability = database(
            this.ctx.storage.sql,
            app.schema,
            true,
            new Set(),
            changed,
          );
          try {
            result = await validate(
              fn.output,
              await fn.handler(
                { db: capability.db, auth: call.auth, jobs } as MutationContext,
                args,
              ),
              true,
            );
            await capability.finish();
            const settled = await Promise.allSettled(scheduled);
            const failed = settled.find(
              (result) => result.status === "rejected",
            );
            if (failed?.status === "rejected") throw failed.reason;
          } finally {
            active = false;
            capability.revoke();
            await Promise.allSettled(scheduled);
          }
          this.commitRevision(changed);
        });
        await this.ctx.storage.sync();
        return { result, revision: this.revision(), tables: [...changed] };
      });
    }
    private commitRevision(changed: Set<string>) {
      this.ctx.storage.sql.exec(
        "UPDATE _flared_revision SET value=value+1 WHERE id=1",
      );
      for (const name of changed)
        this.ctx.storage.sql.exec(
          "INSERT INTO _flared_changes VALUES (?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision",
          name,
          this.revision(),
        );
    }
    pendingJobs(limit = 100): Promise<OutboxJob[]> {
      return this.serial(async () => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new FlaredError("INVALID_INPUT", "Invalid outbox page size");
        return this.ctx.storage.sql
          .exec("SELECT * FROM _flared_outbox ORDER BY dueAt,id LIMIT ?", limit)
          .toArray()
          .map((row) => ({
            id: String(row.id),
            release: String(row.release),
            path: String(row.path),
            args: JSON.parse(String(row.args)),
            auth: JSON.parse(String(row.auth)),
            dueAt: Number(row.dueAt),
            internal: Number(row.internal) === 1,
          }));
      });
    }
    private cancelPending(id: string) {
      if (typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/.test(id))
        throw new FlaredError("INVALID_INPUT", "Invalid job ID");
      return (
        this.ctx.storage.sql
          .exec("DELETE FROM _flared_outbox WHERE id=? RETURNING id", id)
          .toArray().length === 1
      );
    }
    cancelJob(id: string) {
      return this.serial(async () => {
        const cancelled = this.cancelPending(id);
        await this.ctx.storage.sync();
        return cancelled;
      });
    }
    pendingJobReferences() {
      return this.serial(async () => {
        const paths = this.ctx.storage.sql
          .exec(
            "SELECT DISTINCT path FROM _flared_outbox ORDER BY path LIMIT 201",
          )
          .toArray()
          .map((row) => String(row.path));
        const releases = this.ctx.storage.sql
          .exec(
            "SELECT DISTINCT release FROM _flared_outbox ORDER BY release LIMIT 1001",
          )
          .toArray()
          .map((row) => String(row.release));
        return {
          paths: paths.slice(0, 200),
          releases: releases.slice(0, 1000),
          truncated: paths.length > 200 || releases.length > 1000,
        };
      });
    }
    validateJob(path: string, args: Json): Promise<void> {
      return this.serial(async () => {
        const target = functions[path];
        if (!target || target.kind !== "action")
          throw new FlaredError(
            "FUNCTION_NOT_FOUND",
            "Scheduled action not found",
          );
        await validate(target.input, args);
      });
    }
    enqueueJob(job: OutboxJob): Promise<void> {
      return this.serial(async () => {
        const target = functions[job.path];
        if (!target || target.kind !== "action")
          throw new FlaredError(
            "FUNCTION_NOT_FOUND",
            "Scheduled action not found",
          );
        const args = await validate(target.input, job.args);
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO _flared_outbox (id,release,path,args,auth,dueAt,internal) VALUES (?,?,?,?,?,?,1)",
          job.id,
          this.env.RELEASE_ID,
          job.path,
          JSON.stringify(args),
          "null",
          job.dueAt,
        );
        await this.ctx.storage.sync();
      });
    }
    markJobsSent(ids: string[]): Promise<void> {
      return this.serial(async () => {
        if (
          !Array.isArray(ids) ||
          ids.length > 100 ||
          ids.some(
            (id) => typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/.test(id),
          )
        )
          throw new FlaredError("INVALID_INPUT", "Invalid outbox IDs");
        if (ids.length)
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              `DELETE FROM _flared_outbox WHERE id IN (${ids.map(() => "?").join(",")})`,
              ...ids,
            );
          });
        await this.ctx.storage.sync();
      });
    }
    // Dashboard writes use exactly the same document validators and native CRUD as mutations.
    inspect(
      input: { table?: string; cursor?: string | null; limit?: number } = {},
    ) {
      return this.serial(async () => {
        if (!input.table)
          return {
            revision: this.revision(),
            tables: Object.entries(contract).map(([name, definition]) => ({
              name,
              document: definition.document,
              indexes: definition.indexes,
              columns: this.columns(name),
            })),
          };
        const capability = database(this.ctx.storage.sql, app.schema, false);
        try {
          const result = await capability.db
            .query(input.table)
            .paginate({ limit: input.limit ?? 50, cursor: input.cursor });
          await capability.finish();
          return {
            revision: this.revision(),
            columns: this.columns(input.table),
            rows: result.page,
            next: result.continueCursor,
          };
        } finally {
          capability.revoke();
        }
      });
    }
    private columns(name: string) {
      const definition = contract[name];
      if (!definition) throw new FlaredError("INVALID_TABLE", "Unknown table");
      return [
        { name: "_id", type: "TEXT", pk: 1, notnull: 1, dflt_value: null },
        {
          name: "_creationTime",
          type: "REAL",
          pk: 0,
          notnull: 1,
          dflt_value: null,
          readonly: true,
        },
        ...Object.entries(definition.document.properties).map(
          ([field, value]: [string, any]) => ({
            name: field,
            type:
              value.type === "boolean"
                ? "BOOLEAN"
                : ["integer", "number"].includes(value.type)
                  ? "REAL"
                  : value.type === "string"
                    ? "TEXT"
                    : "JSON",
            pk: 0,
            notnull: Number(
              (definition.document.required ?? []).includes(field),
            ),
            dflt_value:
              value.default === undefined
                ? null
                : JSON.stringify(value.default),
            schema: value,
          }),
        ),
      ];
    }
    edit(input: {
      table: string;
      operation: "insert" | "update" | "delete";
      values?: Record<string, Json>;
      key?: string;
      expectedRevision: number;
    }) {
      return this.serial(async () => {
        boundedJson(input, LIMITS.inputBytes);
        let rows: unknown[] = [];
        const changed = new Set<string>();
        await this.ctx.storage.transaction(async () => {
          if (input.expectedRevision !== this.revision())
            throw new FlaredError(
              "CONFLICT",
              "Data changed; reload before editing",
            );
          const capability = database(
            this.ctx.storage.sql,
            app.schema,
            true,
            new Set(),
            changed,
          );
          try {
            if (input.operation === "insert") {
              const id = await capability.db.insert(
                input.table,
                input.values ?? {},
              );
              rows = [await capability.db.get(input.table, id)];
            } else if (input.key && input.operation === "update") {
              await capability.db.patch(
                input.table,
                input.key,
                input.values ?? {},
              );
              rows = [await capability.db.get(input.table, input.key)];
            } else if (input.key && input.operation === "delete") {
              const row = await capability.db.get(input.table, input.key);
              await capability.db.delete(input.table, input.key);
              rows = [row];
            } else throw new FlaredError("INVALID_INPUT", "Invalid edit");
            await capability.finish();
            boundedJson(rows, LIMITS.outputBytes);
          } finally {
            capability.revoke();
          }
          this.commitRevision(changed);
        });
        await this.ctx.storage.sync();
        return { rows, revision: this.revision() };
      });
    }
  };
}

// Native RPC adds Symbol.dispose to object results. JSON capabilities consume
// that transport-owned handle here, not in user function validators.
async function rpcData<T>(response: Promise<T>): Promise<T> {
  const result = await response;
  try {
    const value = structuredClone(result);
    boundedJson(value, LIMITS.outputBytes);
    return value;
  } finally {
    if (result && typeof result === "object") {
      const dispose = (result as { [Symbol.dispose]?: () => void })[
        Symbol.dispose
      ];
      dispose?.call(result);
    }
  }
}

/** A separate Dynamic Worker role. Capabilities are scoped by the parent, not the app. */
export function createAction(app: {
  functions: FunctionTree;
}): ActionConstructor {
  const functions = flatten(app.functions);
  return class Action extends WorkerEntrypoint<{
    CAPABILITY: ScopedCapability;
  }> {
    async invoke(call: Invocation) {
      try {
        return { ok: true as const, value: await this.execute(call) };
      } catch (e) {
        return {
          ok: false as const,
          code: e instanceof FlaredError ? e.code : "OPERATION_FAILED",
        };
      }
    }
    async execute(call: Invocation): Promise<Json> {
      const fn = functions[call.path];
      if (!fn || fn.kind !== "action" || call.kind !== "action")
        throw new FlaredError("FUNCTION_NOT_FOUND", "Action not found");
      authorize(fn.auth, call.auth, call.internal);
      const args = await validate(fn.input, call.args);
      const capability = this.env.CAPABILITY;
      const context: ActionContext = {
        auth: call.auth,
        schedules: {
          set: (input) => rpcData(capability.scheduleCommand("set", input)),
          cancel: (name) =>
            rpcData(capability.scheduleCommand("cancel", { name })),
          list: () => rpcData(capability.scheduleCommand("list", {})),
        },
        runQuery: (ref, input) => {
          if (ref.kind !== "query")
            throw new FlaredError("INVALID_KIND", "Expected query");
          return rpcData(capability.runQuery(ref.path, input, call.auth));
        },
        runMutation: (ref, input) => {
          if (ref.kind !== "mutation")
            throw new FlaredError("INVALID_KIND", "Expected mutation");
          return rpcData(capability.runMutation(ref.path, input, call.auth));
        },
        secrets: { get: (name) => capability.secret(name) },
        files: {
          upload: (body, type, options) =>
            capability.upload(body, type, options),
          download: (id) => capability.download(id),
          generateUploadUrl: (input) =>
            rpcData(capability.fileCommand("reserve", input)),
          getDownloadUrl: (id) =>
            rpcData(capability.fileCommand("download", { id })),
          delete: (id) => rpcData(capability.fileCommand("delete", { id })),
          list: (input = {}) => rpcData(capability.fileCommand("list", input)),
        },
      };
      return validate(fn.output, await fn.handler(context, args), true);
    }
  };
}
