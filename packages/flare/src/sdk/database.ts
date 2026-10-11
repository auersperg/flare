import { FlareError, boundedJson, stableJson } from "./protocol.js";
import {
  documentValue,
  fieldSql,
  quote,
  type Schema,
  type TableDefinition,
  type Value,
  type Input,
  type Doc,
  type NativeSql,
  type SqlValue,
} from "./schema.js";

type Scalar = string | number | boolean | null;
type Filter = {
  field: string;
  operator: "=" | ">" | ">=" | "<" | "<=";
  value: Scalar;
};
export interface Range<D> {
  eq<K extends keyof D & string>(field: K, value: D[K]): Range<D>;
  gt<K extends keyof D & string>(field: K, value: D[K]): Range<D>;
  gte<K extends keyof D & string>(field: K, value: D[K]): Range<D>;
  lt<K extends keyof D & string>(field: K, value: D[K]): Range<D>;
  lte<K extends keyof D & string>(field: K, value: D[K]): Range<D>;
}
export interface Page<D> {
  page: D[];
  continueCursor: string | null;
  isDone: boolean;
}
export interface Query<T extends TableDefinition> {
  withIndex(
    index: keyof T["indexes"] & string,
    range?: (q: Range<Value<T>>) => Range<Value<T>>,
  ): Query<T>;
  order(direction: "asc" | "desc"): Query<T>;
  take(limit: number): Promise<Doc<T>[]>;
  first(): Promise<Doc<T> | null>;
  paginate(options: {
    limit: number;
    cursor?: string | null;
  }): Promise<Page<Doc<T>>>;
}
export interface ReadDatabase<S extends Schema = Schema> {
  get<K extends keyof S & string>(
    table: K,
    id: string,
  ): Promise<Doc<S[K]> | null>;
  query<K extends keyof S & string>(table: K): Query<S[K]>;
}
export interface WriteDatabase<
  S extends Schema = Schema,
> extends ReadDatabase<S> {
  insert<K extends keyof S & string>(
    table: K,
    value: Input<S[K]>,
  ): Promise<string>;
  patch<K extends keyof S & string>(
    table: K,
    id: string,
    value: Partial<Input<S[K]>>,
  ): Promise<void>;
  replace<K extends keyof S & string>(
    table: K,
    id: string,
    value: Input<S[K]>,
  ): Promise<void>;
  delete<K extends keyof S & string>(table: K, id: string): Promise<void>;
}
const scalar = (v: unknown): v is Scalar =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));
const bind = (v: Scalar) => (typeof v === "boolean" ? Number(v) : v);
const checkedId = (id: string) => {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw new FlareError("INVALID_INPUT", "Invalid document ID");
};
const size = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new FlareError("INVALID_INPUT", "Page size must be 1..100");
};

/** Storage never escapes this closure. Each invocation has a revocable capability. */
export function database<S extends Schema>(
  sql: NativeSql,
  schema: S,
  writable: boolean,
  touched: Set<string> = new Set(),
  changed: Set<string> = new Set(),
) {
  let active = true;
  const pending = new Set<Promise<unknown>>();
  let operations = 0;
  const check = () => {
    if (!active)
      throw new FlareError("CAPABILITY_EXPIRED", "Database invocation ended");
  };
  const writing = () => {
    check();
    if (!writable) throw new FlareError("READ_ONLY", "Queries cannot write");
  };
  function table(name: string) {
    check();
    if (!Object.hasOwn(schema, name))
      throw new FlareError("INVALID_TABLE", "Unknown table");
    touched.add(name);
    return schema[name];
  }
  const task = <T>(fn: () => Promise<T>, count = true): Promise<T> => {
    if (count && ++operations > 1000) {
      const rejected = Promise.reject(
        new FlareError(
          "LIMIT_EXCEEDED",
          "Maximum 1000 database operations per invocation",
        ),
      );
      void rejected.catch(() => undefined);
      pending.add(rejected);
      return rejected;
    }
    const promise = fn();
    pending.add(promise);
    // Track fire-and-forget work too: commit must never race an unawaited write.
    void promise.then(
      () => pending.delete(promise),
      () => undefined,
    );
    return promise;
  };
  // Writes and schema activation validate every stored document. Reads do not repeat validators per row.
  const decode = (row: Record<string, SqlValue>): any => ({
    ...JSON.parse(String(row._data)),
    _id: String(row._id),
    _creationTime: Number(row._creationTime),
  });
  const get = (name: string, id: string) =>
    task(async () => {
      table(name);
      checkedId(id);
      const row = sql
        .exec(`SELECT * FROM ${quote(name)} WHERE _id=?`, id)
        .toArray()[0];
      return row ? decode(row) : null;
    });
  function query(name: string): Query<any> {
    const definition = table(name);
    function make(
      index: string | null,
      filters: readonly Filter[],
      direction: "asc" | "desc",
    ): Query<any> {
      const page = (options: { limit: number; cursor?: string | null }) =>
        task(async () => {
          table(name);
          size(options.limit);
          const fields = [
            ...(index ? definition.indexes[index] : []),
            "_creationTime",
            "_id",
          ];
          const expressions = fields.map(fieldSql);
          const signature = stableJson({ name, index, filters, direction });
          const where = filters.map(
            (f) =>
              `${fieldSql(f.field)} ${f.operator === "=" ? "IS" : f.operator} ?`,
          );
          const bindings: SqlValue[] = filters.map((f) => bind(f.value));
          if (options.cursor != null) {
            let token: any;
            try {
              if (options.cursor.length > 8192) throw Error();
              token = JSON.parse(
                new TextDecoder().decode(
                  Uint8Array.from(atob(options.cursor), (c) => c.charCodeAt(0)),
                ),
              );
            } catch {
              throw new FlareError("INVALID_CURSOR", "Invalid cursor");
            }
            if (
              token.signature !== signature ||
              !Array.isArray(token.values) ||
              token.values.length !== fields.length ||
              !token.values.every(scalar)
            )
              throw new FlareError(
                "INVALID_CURSOR",
                "Cursor belongs to a different query",
              );
            const terms = expressions.map((expr, i) => {
              const prefix = expressions.slice(0, i).map((e) => `${e} IS ?`);
              bindings.push(...token.values.slice(0, i).map(bind));
              const value = token.values[i];
              if (value === null)
                prefix.push(direction === "asc" ? `${expr} IS NOT NULL` : "0");
              else {
                prefix.push(
                  direction === "asc"
                    ? `${expr} > ?`
                    : `(${expr} < ? OR ${expr} IS NULL)`,
                );
                bindings.push(bind(value));
              }
              return "(" + prefix.join(" AND ") + ")";
            });
            where.push("(" + terms.join(" OR ") + ")");
          }
          const rows = sql
            .exec(
              `SELECT *,${expressions.map((e, i) => `${e} AS __k${i}`).join(",")} FROM ${quote(name)} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${expressions.map((e) => `${e} ${direction}`).join(",")} LIMIT ?`,
              ...bindings,
              options.limit + 1,
            )
            .toArray();
          let more = rows.length > options.limit;
          if (more) rows.pop();
          const docs: any[] = [];
          let bytes = 2;
          for (const row of rows) {
            const doc = decode(row),
              length =
                new TextEncoder().encode(JSON.stringify(doc)).length +
                (docs.length ? 1 : 0);
            if (bytes + length > 262144) {
              more = true;
              break;
            }
            docs.push(doc);
            bytes += length;
          }
          const last = rows[docs.length - 1];
          const continueCursor =
            more && last
              ? btoa(
                  String.fromCharCode(
                    ...new TextEncoder().encode(
                      boundedJson(
                        {
                          signature,
                          values: expressions.map((_, i) => last[`__k${i}`]),
                        },
                        6144,
                      ),
                    ),
                  ),
                )
              : null;
          boundedJson(docs, 262144);
          return { page: docs, continueCursor, isDone: !more };
        });
      return Object.freeze({
        withIndex(next: string, range?: (q: Range<any>) => Range<any>) {
          check();
          if (index || !Object.hasOwn(definition.indexes, next))
            throw new FlareError("INVALID_INDEX", "Unknown or duplicate index");
          const selected: Filter[] = [],
            fields = definition.indexes[next];
          let pos = 0,
            open = true;
          const bounds = new Set<string>();
          const add =
            (operator: Filter["operator"]) =>
            (field: string, value: Scalar) => {
              if (!open)
                throw new FlareError(
                  "CAPABILITY_EXPIRED",
                  "Index range declaration ended",
                );
              if (
                !scalar(value) ||
                (operator !== "=" && value === null) ||
                !fields.includes(field) ||
                field !== fields[pos]
              )
                throw new FlareError(
                  "INVALID_INPUT",
                  "Index range must follow its field order",
                );
              const bound =
                operator === "="
                  ? "equal"
                  : operator.startsWith(">")
                    ? "lower"
                    : "upper";
              if ((bound === "equal" && bounds.size) || bounds.has(bound))
                throw new FlareError(
                  "INVALID_INPUT",
                  "Duplicate or mixed index bounds",
                );
              selected.push({ field, operator, value });
              if (operator === "=") {
                pos++;
                bounds.clear();
              } else bounds.add(bound);
              if (selected.length > fields.length + 2)
                throw new FlareError(
                  "INVALID_INPUT",
                  "Index range exceeds limits",
                );
              return q;
            };
          const q: Range<any> = Object.freeze({
            eq: add("="),
            gt: add(">"),
            gte: add(">="),
            lt: add("<"),
            lte: add("<="),
          });
          try {
            if (range && range(q) !== q)
              throw new FlareError("INVALID_INPUT", "Invalid index range");
          } finally {
            open = false;
          }
          return make(next, Object.freeze([...selected]), direction);
        },
        order(next: "asc" | "desc") {
          check();
          if (!["asc", "desc"].includes(next))
            throw new FlareError("INVALID_INPUT", "Invalid order");
          return make(index, filters, next);
        },
        paginate: page,
        take(limit: number) {
          return task(async () => {
            const result = await page({ limit });
            if (!result.isDone && result.page.length < limit)
              throw new FlareError(
                "TOO_LARGE",
                "Use paginate for large documents",
              );
            return result.page;
          }, false);
        },
        first() {
          return task(
            async () => (await page({ limit: 1 })).page[0] ?? null,
            false,
          );
        },
      });
    }
    return make(null, [], "asc");
  }
  const read = { get, query };
  const write = {
    insert(name: string, input: any) {
      return task(async () => {
        writing();
        const definition = table(name),
          value = await documentValue(definition, input);
        writing();
        const id = crypto.randomUUID();
        sql.exec(
          `INSERT INTO ${quote(name)} VALUES (?,?,?)`,
          id,
          Date.now(),
          stableJson(value),
        );
        changed.add(name);
        return id;
      });
    },
    patch(name: string, id: string, patch: any) {
      return task(async () => {
        writing();
        const definition = table(name);
        checkedId(id);
        boundedJson(patch, 65536);
        if (!patch || Array.isArray(patch) || typeof patch !== "object")
          throw new FlareError("INVALID_INPUT", "Invalid patch");
        const row = sql
          .exec(`SELECT _data FROM ${quote(name)} WHERE _id=?`, id)
          .toArray()[0];
        if (!row) throw new FlareError("NOT_FOUND", "Document not found");
        const value = await documentValue(definition, {
          ...JSON.parse(String(row._data)),
          ...patch,
        });
        writing();
        sql.exec(
          `UPDATE ${quote(name)} SET _data=? WHERE _id=?`,
          stableJson(value),
          id,
        );
        changed.add(name);
      });
    },
    replace(name: string, id: string, input: any) {
      return task(async () => {
        writing();
        const definition = table(name);
        checkedId(id);
        const value = await documentValue(definition, input);
        writing();
        const rows = sql
          .exec(
            `UPDATE ${quote(name)} SET _data=? WHERE _id=? RETURNING _id`,
            stableJson(value),
            id,
          )
          .toArray();
        if (!rows.length)
          throw new FlareError("NOT_FOUND", "Document not found");
        changed.add(name);
      });
    },
    delete(name: string, id: string) {
      return task(async () => {
        writing();
        table(name);
        checkedId(id);
        if (
          !sql
            .exec(`DELETE FROM ${quote(name)} WHERE _id=? RETURNING _id`, id)
            .toArray().length
        )
          throw new FlareError("NOT_FOUND", "Document not found");
        changed.add(name);
      });
    },
  };
  return {
    db: Object.freeze(
      writable ? { ...read, ...write } : read,
    ) as ReadDatabase<S> & WriteDatabase<S>,
    async finish() {
      try {
        while (pending.size) {
          const settled = await Promise.allSettled([...pending]);
          const failed = settled.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      } finally {
        active = false;
      }
    },
    revoke() {
      active = false;
    },
  };
}
