import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
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
import { assertReadSql } from "./read-sql.js";
import { getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { boundedJson, LIMITS } from "./protocol.js";

export type Migrations = Parameters<typeof migrate>[1];
export interface Invocation {
  path: string;
  kind: FunctionKind;
  args: Json;
  auth: Auth | null;
}
export interface OutboxJob {
  id: string;
  release: string;
  path: string;
  args: Json;
  auth: Auth | null;
  dueAt: number;
}
export interface FacetRpc {
  snapshot(): Promise<{ revision: number }>;
  execute(call: Invocation): Promise<{ result: Json; revision: number }>;
  pendingJobs(limit?: number): Promise<OutboxJob[]>;
  markJobSent(id: string): Promise<void>;
  inspect(input: {
    table?: string;
    cursor?: string | number;
    limit?: number;
  }): Promise<any>;
  edit(input: {
    table: string;
    operation: "insert" | "update" | "delete";
    values?: Record<string, Json>;
    key?: string | number;
    expectedRevision: number;
  }): Promise<any>;
  invoke(
    call: Invocation,
  ): Promise<
    | { ok: true; value: { result: Json; revision: number } }
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
  ): Promise<string>;
  download(id: string): Promise<Response>;
}
function authorize(mode: "required" | "public", auth: Auth | null) {
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
export function createFacet(
  app: { functions: FunctionTree; tables?: Record<string, SQLiteTable> },
  migrations: Migrations,
): FacetConstructor {
  const functions = flatten(app.functions);
  const tables = new Set(Object.values(app.tables ?? {}).map(getTableName));
  const quote = (name: string) => '"' + name.replace(/"/g, '""') + '"';
  return class AppFacet extends DurableObject<{ RELEASE_ID: string }> {
    private readonly db;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(ctx: DurableObjectState, env: { RELEASE_ID: string }) {
      super(ctx, env);
      this.db = drizzle(ctx.storage);
      ctx.blockConcurrencyWhile(async () => {
        await migrate(this.db, migrations);
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _reactive_revision (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)",
        );
        ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO _reactive_revision VALUES (1,0)",
        );
        ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS _reactive_outbox (id TEXT PRIMARY KEY, release TEXT NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, auth TEXT NOT NULL, dueAt INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0)",
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
          .exec("SELECT value FROM _reactive_revision WHERE id=1")
          .one().value,
      );
    }
    snapshot() {
      return this.serial(async () => ({ revision: this.revision() }));
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
        if (operation !== "inspect" && operation !== "edit")
          throw new FlaredError(
            "INVALID_OPERATION",
            "Unknown administrative capability",
          );
        return {
          ok: true as const,
          value: await (operation === "inspect"
            ? this.inspect(input)
            : this.edit(input)),
        };
      } catch (error) {
        return {
          ok: false as const,
          code: error instanceof FlaredError ? error.code : "OPERATION_FAILED",
        };
      }
    }
    execute(call: Invocation): Promise<{ result: Json; revision: number }> {
      return this.serial(async () => {
        const fn = functions[call.path];
        if (!fn || fn.kind !== call.kind || call.kind === "action")
          throw new FlaredError(
            "FUNCTION_NOT_FOUND",
            "Data function not found",
          );
        authorize(fn.auth, call.auth);
        const args = await validate(fn.input, call.args);
        if (call.kind === "query" || call.kind === "live") {
          // DO SQLite rejects PRAGMA query_only. Never expose the write-capable
          // native storage through Drizzle's publicly reachable session/client.
          const storage = Object.freeze({
            sql: Object.freeze({
              exec: (sql: string, ...bindings: any[]) => {
                assertReadSql(sql);
                const cursor = this.ctx.storage.sql.exec(sql, ...bindings);
                if (cursor.rowsWritten)
                  throw new FlaredError(
                    "READ_ONLY",
                    "Query attempted to write data",
                  );
                return cursor;
              },
            }),
          });
          return this.ctx.storage.transaction(async () => {
            const read = drizzle(storage as DurableObjectStorage);
            const db = Object.freeze({
              select: read.select.bind(read),
              selectDistinct: read.selectDistinct.bind(read),
              $count: read.$count.bind(read),
            });
            const result = await validate(
              fn.output,
              await fn.handler({ db, auth: call.auth } as QueryContext, args),
              true,
            );
            return { result, revision: this.revision() };
          });
        }
        let result: Json = null;
        await this.ctx.storage.transaction(async () => {
          const jobs: MutationContext["jobs"] = {
            schedule: async (path, jobArgs, options = {}) => {
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
              const id = crypto.randomUUID();
              this.ctx.storage.sql.exec(
                "INSERT INTO _reactive_outbox (id,release,path,args,auth,dueAt) VALUES (?,?,?,?,?,?)",
                id,
                this.env.RELEASE_ID,
                path,
                JSON.stringify(input),
                JSON.stringify(call.auth),
                Date.now() + Math.ceil(delay * 1000),
              );
              return id;
            },
          };
          result = await validate(
            fn.output,
            await fn.handler(
              { db: this.db, auth: call.auth, jobs } as MutationContext,
              args,
            ),
            true,
          );
          this.ctx.storage.sql.exec(
            "UPDATE _reactive_revision SET value=value+1 WHERE id=1",
          );
        });
        await this.ctx.storage.sync();
        return { result, revision: this.revision() };
      });
    }
    pendingJobs(limit = 100): Promise<OutboxJob[]> {
      return this.serial(async () => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new FlaredError("INVALID_INPUT", "Invalid outbox page size");
        return this.ctx.storage.sql
          .exec(
            "SELECT * FROM _reactive_outbox WHERE sent=0 ORDER BY dueAt,id LIMIT ?",
            limit,
          )
          .toArray()
          .map((row) => ({
            id: String(row.id),
            release: String(row.release),
            path: String(row.path),
            args: JSON.parse(String(row.args)),
            auth: JSON.parse(String(row.auth)),
            dueAt: Number(row.dueAt),
          }));
      });
    }
    markJobSent(id: string): Promise<void> {
      return this.serial(async () => {
        this.ctx.storage.sql.exec(
          "UPDATE _reactive_outbox SET sent=1 WHERE id=?",
          id,
        );
        await this.ctx.storage.sync();
      });
    }
    // Native RPC only. The Supervisor's administrative capability owns authorization.
    private table(name: string) {
      if (!tables.has(name) || name.startsWith("_"))
        throw new FlaredError("INVALID_TABLE", "Unknown application table");
      return this.ctx.storage.sql
        .exec(`PRAGMA table_info(${quote(name)})`)
        .toArray();
    }
    inspect(
      input: { table?: string; cursor?: string | number; limit?: number } = {},
    ) {
      return this.serial(async () => {
        if (!input.table)
          return {
            revision: this.revision(),
            tables: [...tables]
              .filter((name) => !name.startsWith("_"))
              .map((name) => ({
                name,
                columns: this.table(name),
                sql: this.ctx.storage.sql
                  .exec(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                    name,
                  )
                  .one().sql,
              })),
          };
        const columns = this.table(input.table),
          primary = columns.filter((c) => Number(c.pk) > 0);
        if (primary.length !== 1)
          throw new FlaredError(
            "UNSUPPORTED",
            "Data preview requires a single primary key",
          );
        const limit = input.limit ?? 50;
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (input.cursor !== undefined &&
            !["string", "number"].includes(typeof input.cursor))
        )
          throw new FlaredError("INVALID_INPUT", "Invalid page");
        const key = String(primary[0].name);
        const rows = this.ctx.storage.sql
          .exec(
            `SELECT * FROM ${quote(input.table)} ${input.cursor === undefined ? "" : `WHERE ${quote(key)} > ?`} ORDER BY ${quote(key)} LIMIT ?`,
            ...(input.cursor === undefined ? [] : [input.cursor]),
            limit + 1,
          )
          .toArray();
        const more = rows.length > limit;
        if (more) rows.pop();
        const result = {
          revision: this.revision(),
          columns,
          rows,
          next: more ? rows.at(-1)?.[key] : null,
        };
        boundedJson(result, LIMITS.outputBytes);
        return result;
      });
    }
    edit(input: {
      table: string;
      operation: "insert" | "update" | "delete";
      values?: Record<string, Json>;
      key?: string | number;
      expectedRevision: number;
    }) {
      return this.serial(async () => {
        const columns = this.table(input.table),
          primary = columns.filter((c) => Number(c.pk) > 0);
        if (primary.length !== 1)
          throw new FlaredError(
            "UNSUPPORTED",
            "Data edits require a single primary key",
          );
        boundedJson(input, LIMITS.inputBytes);
        if (input.expectedRevision !== this.revision())
          throw new FlaredError(
            "CONFLICT",
            "Data changed; reload before editing",
          );
        const values = Object.entries(input.values ?? {}),
          key = String(primary[0].name);
        for (const [name, value] of values)
          if (
            !columns.some((c) => c.name === name) ||
            (value !== null && !["string", "number"].includes(typeof value))
          )
            throw new FlaredError(
              "INVALID_INPUT",
              "Invalid column or SQL value",
            );
        let rows: Record<string, unknown>[] = [];
        await this.ctx.storage.transaction(async () => {
          if (input.operation === "insert" && values.length)
            rows = this.ctx.storage.sql
              .exec(
                `INSERT INTO ${quote(input.table)} (${values.map(([k]) => quote(k)).join(",")}) VALUES (${values.map(() => "?").join(",")}) RETURNING *`,
                ...values.map(([, v]) => v),
              )
              .toArray();
          else if (
            ["update", "delete"].includes(input.operation) &&
            ["string", "number"].includes(typeof input.key)
          ) {
            if (input.operation === "update") {
              if (!values.length || values.some(([k]) => k === key))
                throw new FlaredError(
                  "INVALID_INPUT",
                  "Primary key is immutable",
                );
              rows = this.ctx.storage.sql
                .exec(
                  `UPDATE ${quote(input.table)} SET ${values.map(([k]) => `${quote(k)}=?`).join(",")} WHERE ${quote(key)}=? RETURNING *`,
                  ...values.map(([, v]) => v),
                  input.key!,
                )
                .toArray();
            } else
              rows = this.ctx.storage.sql
                .exec(
                  `DELETE FROM ${quote(input.table)} WHERE ${quote(key)}=? RETURNING *`,
                  input.key!,
                )
                .toArray();
            if (rows.length !== 1)
              throw new FlaredError("NOT_FOUND", "Row not found");
          } else throw new FlaredError("INVALID_INPUT", "Invalid operation");
          boundedJson(rows, LIMITS.outputBytes);
          this.ctx.storage.sql.exec(
            "UPDATE _reactive_revision SET value=value+1 WHERE id=1",
          );
        });
        await this.ctx.storage.sync();
        return { rows, revision: this.revision() };
      });
    }
  };
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
      authorize(fn.auth, call.auth);
      const args = await validate(fn.input, call.args);
      const capability = this.env.CAPABILITY;
      const context: ActionContext = {
        auth: call.auth,
        runQuery: (ref, input) => {
          if (ref.kind !== "query")
            throw new FlaredError("INVALID_KIND", "Expected query");
          return capability.runQuery(ref.path, input, call.auth);
        },
        runMutation: (ref, input) => {
          if (ref.kind !== "mutation")
            throw new FlaredError("INVALID_KIND", "Expected mutation");
          return capability.runMutation(ref.path, input, call.auth);
        },
        secrets: { get: (name) => capability.secret(name) },
        files: {
          upload: (body, type) => capability.upload(body, type),
          download: (id) => capability.download(id),
        },
      };
      return validate(fn.output, await fn.handler(context, args), true);
    }
  };
}
