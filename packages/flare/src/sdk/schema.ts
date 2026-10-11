import type {
  StandardSchemaV1,
  StandardJSONSchemaV1,
} from "@standard-schema/spec";
import { FlareError, boundedJson, stableJson, type Json } from "./protocol.js";

export type SqlValue = ArrayBuffer | string | number | null;
/** The small structural portion of native storage needed by the adapter; no Worker globals in public types. */
export interface NativeSql {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): T[]; one(): T };
}
export interface NativeStorage {
  sql: NativeSql;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  sync(): Promise<void>;
}
export type Validator<I = unknown, O = I> = StandardSchemaV1<I, O> &
  StandardJSONSchemaV1<I, O>;
export interface Table<
  V extends Validator = Validator<any, any>,
  I extends Record<string, readonly string[]> = Record<
    string,
    readonly string[]
  >,
> {
  readonly validator: V;
  readonly indexes: I;
  index<
    const N extends string,
    const F extends readonly (keyof StandardSchemaV1.InferOutput<V> & string)[],
  >(
    name: N,
    fields: F,
  ): Table<V, I & Record<N, F>>;
}
/** Runtime schema needs only immutable validators and indexes, not builder methods. */
export type TableDefinition = Pick<Table, "validator" | "indexes">;
export type Schema = Record<string, TableDefinition>;
export type Value<T extends TableDefinition> = StandardSchemaV1.InferOutput<
  T["validator"]
>;
export type Input<T extends TableDefinition> = StandardSchemaV1.InferInput<
  T["validator"]
>;
export type Doc<T extends TableDefinition> = Value<T> & {
  readonly _id: string;
  readonly _creationTime: number;
};
export type SchemaContract = Record<
  string,
  { document: Record<string, any>; indexes: Record<string, readonly string[]> }
>;
export function identifier(name: string): string {
  if (
    !/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name) ||
    name.toLowerCase().startsWith("sqlite_")
  )
    throw new FlareError(
      "INVALID_SCHEMA",
      "Invalid table, index or field name",
    );
  return name;
}
export const quote = (name: string) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(name))
    throw new FlareError("INVALID_SCHEMA", "Invalid SQL identifier");
  return `"${name}"`;
};
export const fieldSql = (field: string) =>
  field === "_id" || field === "_creationTime"
    ? `"${field}"`
    : `json_extract("_data", '$.${identifier(field)}')`;
const indexName = (table: string, index: string) =>
  `idx_${table.length}_${table}_${index}`;
const creationIndex = (table: string) => `creation_${table}`;
export function defineTable<V extends Validator>(validator: V): Table<V, {}> {
  function table(indexes: Record<string, readonly string[]>): any {
    return Object.freeze({
      validator,
      indexes: Object.freeze(indexes),
      index(name: string, fields: readonly string[]) {
        identifier(name);
        if (
          Object.hasOwn(indexes, name) ||
          !fields.length ||
          fields.length > 4 ||
          new Set(fields).size !== fields.length
        )
          throw new FlareError("INVALID_SCHEMA", "Invalid index");
        fields.forEach(identifier);
        return table({ ...indexes, [name]: Object.freeze([...fields]) });
      },
    });
  }
  return table({});
}
export function schemaContract(schema: Schema): SchemaContract {
  const out: SchemaContract = Object.create(null);
  if (Object.keys(schema).length > 100)
    throw new FlareError("INVALID_SCHEMA", "Maximum 100 tables");
  for (const [name, table] of Object.entries(schema)) {
    identifier(name);
    const document = table.validator["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    out[name] = { document, indexes: table.indexes };
  }
  assertSchemaContract(out);
  return out;
}
export function assertSchemaContract(contract: SchemaContract): void {
  boundedJson(contract, 1048576);
  if (
    !contract ||
    Array.isArray(contract) ||
    typeof contract !== "object" ||
    Object.keys(contract).length > 100
  )
    throw new FlareError("INVALID_SCHEMA", "Invalid schema");
  const names = new Set<string>();
  for (const [name, table] of Object.entries(contract)) {
    if (names.has(name.toLowerCase()))
      throw new FlareError(
        "INVALID_SCHEMA",
        "SQLite table names are case-insensitive",
      );
    names.add(name.toLowerCase());
    identifier(name);
    const doc = table?.document;
    if (
      !doc ||
      doc.type !== "object" ||
      !doc.properties ||
      doc.additionalProperties !== false
    )
      throw new FlareError(
        "INVALID_SCHEMA",
        "Tables require a closed object validator",
      );
    for (const field of Object.keys(doc.properties)) identifier(field);
    if (
      Object.keys(doc.properties).length > 64 ||
      !table.indexes ||
      Object.keys(table.indexes).length > 20
    )
      throw new FlareError("INVALID_SCHEMA", "Schema exceeds limits");
    const indexes = new Set<string>();
    for (const [index, fields] of Object.entries(table.indexes)) {
      if (indexes.has(index.toLowerCase()))
        throw new FlareError(
          "INVALID_SCHEMA",
          "SQLite index names are case-insensitive",
        );
      indexes.add(index.toLowerCase());
      identifier(index);
      if (
        !Array.isArray(fields) ||
        fields.length < 1 ||
        fields.length > 4 ||
        new Set(fields).size !== fields.length
      )
        throw new FlareError("INVALID_SCHEMA", "Invalid index fields");
      for (const field of fields) {
        identifier(field);
        const p = doc.properties[field];
        const scalar = (s: any): boolean =>
          (Array.isArray(s?.type) &&
            s.type.every((type: string) =>
              ["string", "number", "integer", "boolean", "null"].includes(type),
            )) ||
          ["string", "number", "integer", "boolean", "null"].includes(
            s?.type,
          ) ||
          (Array.isArray(s?.anyOf) && s.anyOf.every(scalar));
        if (!p || !scalar(p))
          throw new FlareError(
            "INVALID_SCHEMA",
            "Indexes require declared scalar fields",
          );
      }
    }
  }
}
export function defineSchema<const S extends Schema>(schema: S): S {
  schemaContract(schema);
  return Object.freeze(schema);
}
const documents = new WeakMap<object, any>();
function documentSchema(table: TableDefinition) {
  let doc = documents.get(table.validator);
  if (!doc) {
    doc = table.validator["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    documents.set(table.validator, doc);
  }
  return doc;
}
export async function documentValue(
  table: TableDefinition,
  input: unknown,
): Promise<Record<string, Json>> {
  boundedJson(input, 65536);
  const properties = documentSchema(table).properties ?? {};
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !Object.hasOwn(properties, k))
  )
    throw new FlareError("INVALID_INPUT", "Unknown document field");
  const result = await table.validator["~standard"].validate(input);
  if (
    result.issues ||
    !result.value ||
    Array.isArray(result.value) ||
    typeof result.value !== "object" ||
    Object.keys(result.value).some((k) => !Object.hasOwn(properties, k))
  )
    throw new FlareError("INVALID_INPUT", "Document failed schema validation");
  return JSON.parse(boundedJson(result.value, 65536));
}
export async function applySchema(storage: NativeStorage, schema: Schema) {
  const contract = schemaContract(schema),
    encoded = stableJson(contract);
  await storage.transaction(async () => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _flared_schema (id INTEGER PRIMARY KEY CHECK(id=1), contract TEXT NOT NULL)",
    );
    const oldRow = storage.sql
      .exec("SELECT contract FROM _flared_schema WHERE id=1")
      .toArray()[0];
    if (oldRow?.contract === encoded) return;
    const old: SchemaContract = oldRow
      ? JSON.parse(String(oldRow.contract))
      : {};
    for (const name of Object.keys(old))
      if (!Object.hasOwn(schema, name)) {
        if (
          storage.sql.exec(`SELECT 1 FROM ${quote(name)} LIMIT 1`).toArray()
            .length
        )
          throw new FlareError(
            "INVALID_SCHEMA",
            "Cannot remove a nonempty table; explicitly clear it first",
          );
        storage.sql.exec(`DROP TABLE ${quote(name)}`);
      }
    for (const [name, definition] of Object.entries(contract)) {
      storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${quote(name)} (_id TEXT PRIMARY KEY, _creationTime REAL NOT NULL, _data TEXT NOT NULL CHECK(json_valid(_data)))`,
      );
      // Validate existing documents before activating a changed contract. Consume each cursor before await.
      let cursor = "";
      while (
        !old[name] ||
        stableJson(old[name].document) !== stableJson(definition.document)
      ) {
        const rows = storage.sql
          .exec(
            `SELECT _id,_data FROM ${quote(name)} WHERE _id > ? ORDER BY _id LIMIT 100`,
            cursor,
          )
          .toArray();
        for (const row of rows) {
          const value = await documentValue(
            schema[name],
            JSON.parse(String(row._data)),
          );
          if (stableJson(value) !== stableJson(JSON.parse(String(row._data))))
            storage.sql.exec(
              `UPDATE ${quote(name)} SET _data=? WHERE _id=?`,
              stableJson(value),
              row._id,
            );
        }
        if (rows.length < 100) break;
        cursor = String(rows.at(-1)!._id);
      }
      storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS ${quote(creationIndex(name))} ON ${quote(name)} (_creationTime,_id)`,
      );
      for (const [index, fields] of Object.entries(old[name]?.indexes ?? {}))
        if (
          stableJson(definition.indexes[index] ?? null) !== stableJson(fields)
        )
          storage.sql.exec(
            `DROP INDEX IF EXISTS ${quote(indexName(name, index))}`,
          );
      for (const [index, fields] of Object.entries(definition.indexes))
        storage.sql.exec(
          `CREATE INDEX IF NOT EXISTS ${quote(indexName(name, index))} ON ${quote(name)} (${[...fields.map(fieldSql), "_creationTime", "_id"].join(",")})`,
        );
    }
    storage.sql.exec(
      "INSERT INTO _flared_schema VALUES (1,?) ON CONFLICT(id) DO UPDATE SET contract=excluded.contract",
      encoded,
    );
  });
  await storage.sync();
}
