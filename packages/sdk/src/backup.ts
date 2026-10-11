import { boundedJson, FlaredError, stableJson, type Json } from "./protocol.js";
import {
  documentValue,
  quote,
  schemaContract,
  type NativeStorage,
  type Schema,
  type SchemaContract,
} from "./schema.js";

// Deliberately bounded logical snapshots, not a promise of arbitrary-size PITR.
export const SNAPSHOT_BYTES = 4 * 1048576;
export const SNAPSHOT_ROWS = 10000;
export type DataSnapshot = {
  format: 1;
  schema: SchemaContract;
  revision: number;
  tables: Record<
    string,
    { _id: string; _creationTime: number; value: Record<string, Json> }[]
  >;
};
const reject = (code: string): never => {
  throw new FlaredError(code, code);
};
export function emptyData(storage: NativeStorage, schema: Schema) {
  for (const name of Object.keys(schema))
    if (
      storage.sql.exec(`SELECT 1 FROM ${quote(name)} LIMIT 1`).toArray().length
    )
      return false;
  return !storage.sql.exec("SELECT 1 FROM _flared_outbox LIMIT 1").toArray()
    .length;
}
/** Caller holds the facet's serial gate; all pages belong to one revision. */
export function exportData(
  storage: NativeStorage,
  schema: Schema,
): DataSnapshot {
  if (storage.sql.exec("SELECT 1 FROM _flared_outbox LIMIT 1").toArray().length)
    reject("BACKUP_BUSY");
  const snapshot: DataSnapshot = {
    format: 1,
    schema: schemaContract(schema),
    revision: Number(
      storage.sql.exec("SELECT value FROM _flared_revision WHERE id=1").one()
        .value,
    ),
    tables: Object.create(null),
  };
  let count = 0,
    bytes = 0;
  for (const name of Object.keys(schema)) {
    const docs: DataSnapshot["tables"][string] = [];
    snapshot.tables[name] = docs;
    let cursor = "";
    for (;;) {
      const page = storage.sql
        .exec(
          `SELECT * FROM ${quote(name)} WHERE _id>? ORDER BY _id LIMIT 100`,
          cursor,
        )
        .toArray();
      for (const row of page) {
        const doc = {
          _id: String(row._id),
          _creationTime: Number(row._creationTime),
          value: JSON.parse(String(row._data)),
        };
        bytes += new TextEncoder().encode(stableJson(doc)).length;
        if (++count > SNAPSHOT_ROWS || bytes > SNAPSHOT_BYTES)
          reject("BACKUP_TOO_LARGE");
        docs.push(doc);
      }
      if (page.length < 100) break;
      cursor = String(page.at(-1)!._id);
    }
  }
  // Native RPC does not serialize null-prototype records; normalize the wire value.
  return JSON.parse(boundedJson(snapshot, SNAPSHOT_BYTES));
}
/** Native transaction preserves IDs, references and timestamps; never merges into existing data. */
export async function restoreData(
  storage: NativeStorage,
  schema: Schema,
  id: string,
  snapshot: DataSnapshot,
) {
  boundedJson(snapshot, SNAPSHOT_BYTES);
  if (
    !/^[0-9a-f-]{36}$/.test(id) ||
    snapshot?.format !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    stableJson(snapshot.schema) !== stableJson(schemaContract(schema)) ||
    !snapshot.tables ||
    Array.isArray(snapshot.tables) ||
    Object.keys(snapshot.tables).sort().join() !==
      Object.keys(schema).sort().join()
  )
    reject("INVALID_BACKUP");
  await storage.transaction(async () => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _flared_restore (id TEXT PRIMARY KEY)",
    );
    if (
      storage.sql
        .exec("SELECT id FROM _flared_restore WHERE id=?", id)
        .toArray().length
    )
      return;
    if (!emptyData(storage, schema)) reject("RESTORE_NOT_EMPTY");
    let count = 0;
    for (const [name, docs] of Object.entries(snapshot.tables)) {
      if (!Array.isArray(docs)) reject("INVALID_BACKUP");
      for (const doc of docs) {
        if (
          ++count > SNAPSHOT_ROWS ||
          !doc ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            doc._id,
          ) ||
          !Number.isFinite(doc._creationTime) ||
          doc._creationTime < 0
        )
          reject("INVALID_BACKUP");
        const value = await documentValue(schema[name], doc.value);
        if (stableJson(value) !== stableJson(doc.value))
          reject("INVALID_BACKUP");
        storage.sql.exec(
          `INSERT INTO ${quote(name)} VALUES (?,?,?)`,
          doc._id,
          doc._creationTime,
          stableJson(value),
        );
      }
    }
    storage.sql.exec(
      "UPDATE _flared_revision SET value=? WHERE id=1",
      snapshot.revision,
    );
    storage.sql.exec("DELETE FROM _flared_changes");
    for (const name of Object.keys(schema))
      storage.sql.exec(
        "INSERT INTO _flared_changes VALUES (?,?)",
        name,
        snapshot.revision,
      );
    storage.sql.exec("INSERT INTO _flared_restore VALUES (?)", id);
  });
  await storage.sync();
  return { restored: true, revision: snapshot.revision };
}
