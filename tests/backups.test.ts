import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  defineSchema,
  defineTable,
  applySchema,
  schemaContract,
  type NativeStorage,
} from "../packages/sdk/src/schema.js";
import {
  exportData,
  restoreData,
  emptyData,
} from "../packages/sdk/src/backup.js";
import { BackupStore, backupPrefix } from "../packages/core/src/backups.js";
import { digest } from "../packages/core/src/security.js";
import { stableJson } from "../packages/sdk/src/protocol.js";
const schema = defineSchema({
  tasks: defineTable(z.object({ title: z.string().min(1) })),
  notes: defineTable(z.object({ task: z.string() })),
});
const scope = "00000000-0000-4000-8000-000000000001/dev",
  target = scope.replace("dev", "prod"),
  id = crypto.randomUUID(),
  docId = crypto.randomUUID();
async function fixture() {
  const db = new Database(":memory:");
  const storage: NativeStorage = {
    sql: {
      exec(sql: string, ...args: any[]) {
        const q = db.query(sql),
          rows = q.columnNames.length ? q.all(...args) : (q.run(...args), []);
        return { toArray: () => rows as any[], one: () => rows[0] as any };
      },
    },
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const value = await fn();
        db.exec("COMMIT");
        return value;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    sync: async () => {},
  };
  await applySchema(storage, schema);
  db.exec(
    "CREATE TABLE _flared_revision (id INTEGER PRIMARY KEY,value INTEGER); INSERT INTO _flared_revision VALUES (1,7); CREATE TABLE _flared_outbox(id TEXT); CREATE TABLE _flared_changes(name TEXT PRIMARY KEY,revision INTEGER)",
  );
  return { db, storage };
}
function bucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; etag: string; customMetadata: any }
  >();
  const r2: any = {
    async put(key: string, body: any, options: any = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key))
        return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer()),
        etag = createHash("md5").update(bytes).digest("hex");
      if (options.md5 && options.md5 !== etag) throw Error("Bad checksum");
      objects.set(key, {
        bytes,
        etag,
        customMetadata: options.customMetadata ?? {},
      });
      return { size: bytes.length, etag };
    },
    async get(key: string, options: any = {}) {
      const value = objects.get(key);
      if (!value) return null;
      const meta = {
        size: value.bytes.length,
        etag: value.etag,
        customMetadata: value.customMetadata,
      };
      if (
        options.onlyIf?.etagMatches &&
        options.onlyIf.etagMatches !== value.etag
      )
        return meta;
      return {
        ...meta,
        body: new Response(new Uint8Array(value.bytes)).body,
        text: async () => new TextDecoder().decode(value.bytes),
      };
    },
    async head(key: string) {
      const v = objects.get(key);
      return v
        ? {
            customMetadata: v.customMetadata,
            etag: v.etag,
            size: v.bytes.length,
          }
        : null;
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys])
        objects.delete(key);
    },
    async list({ prefix, delimiter }: any) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return {
        objects: keys
          .filter(
            (k) => !delimiter || !k.slice(prefix.length).includes(delimiter),
          )
          .map((key) => ({ key })),
        delimitedPrefixes: delimiter
          ? [
              ...new Set(
                keys
                  .filter((k) => k.slice(prefix.length).includes(delimiter))
                  .map(
                    (k) =>
                      prefix +
                      k.slice(prefix.length).split(delimiter)[0] +
                      delimiter,
                  ),
              ),
            ]
          : [],
        truncated: false,
      };
    },
  };
  return { r2, objects };
}
async function bundle() {
  const manifest = {
      protocol: 1 as const,
      runtimeAbi: 4 as const,
      functions: {},
    },
    contract = schemaContract(schema),
    facet = "facet",
    action = "action";
  const checksums = {
    facet: await digest(facet),
    action: await digest(action),
    schema: await digest(stableJson(contract)),
    manifest: await digest(stableJson(manifest)),
  };
  const release = {
    protocol: 1 as const,
    compatibilityDate: "2026-10-10",
    checksums,
  };
  return {
    release: { ...release, hash: await digest(stableJson(release)) },
    manifest,
    schema: contract,
    facet,
    action,
  };
}
describe("bounded logical snapshots", () => {
  it("restores IDs, references, timestamps and revision in an empty native database", async () => {
    const a = await fixture(),
      b = await fixture();
    try {
      a.db
        .query("INSERT INTO tasks VALUES (?,?,?)")
        .run(docId, 1234, '{"title":"saved"}');
      a.db
        .query("INSERT INTO notes VALUES (?,?,?)")
        .run(crypto.randomUUID(), 1235, JSON.stringify({ task: docId }));
      const snapshot = exportData(a.storage, schema);
      await restoreData(b.storage, schema, id, snapshot);
      expect(exportData(b.storage, schema)).toEqual(snapshot);
      expect(await restoreData(b.storage, schema, id, snapshot)).toEqual({
        restored: true,
        revision: 7,
      });
      expect(emptyData(b.storage, schema)).toBe(false);
    } finally {
      a.db.close();
      b.db.close();
    }
  });
  it("rolls back the entire restore if a later document fails validation", async () => {
    const a = await fixture();
    try {
      const snapshot = exportData(a.storage, schema);
      snapshot.tables.tasks = [
        { _id: docId, _creationTime: 1, value: { title: "good" } },
        { _id: crypto.randomUUID(), _creationTime: 1, value: { title: "" } },
      ];
      await expect(
        restoreData(a.storage, schema, id, snapshot),
      ).rejects.toThrow();
      expect(a.db.query("SELECT * FROM tasks").all()).toEqual([]);
      expect(a.db.query("SELECT value FROM _flared_revision").get()).toEqual({
        value: 7,
      });
    } finally {
      a.db.close();
    }
  });
  it("never overwrites existing data or exports an undelivered outbox", async () => {
    const a = await fixture();
    try {
      const snapshot = exportData(a.storage, schema);
      a.db
        .query("INSERT INTO tasks VALUES (?,?,?)")
        .run(docId, 1, '{"title":"keep"}');
      await expect(
        restoreData(a.storage, schema, id, snapshot),
      ).rejects.toMatchObject({ code: "RESTORE_NOT_EMPTY" });
      a.db.exec("INSERT INTO _flared_outbox VALUES ('pending')");
      expect(() => exportData(a.storage, schema)).toThrow("BACKUP_BUSY");
    } finally {
      a.db.close();
    }
  });
  it("rejects a mismatched schema, forged ID and unsupported format", async () => {
    const a = await fixture();
    try {
      const snapshot = exportData(a.storage, schema);
      for (const bad of [
        { ...snapshot, format: 2 },
        { ...snapshot, schema: {} },
        {
          ...snapshot,
          tables: {
            tasks: [],
            notes: [
              { _id: "forged", _creationTime: 1, value: { task: docId } },
            ],
          },
        },
      ])
        await expect(
          restoreData(a.storage, schema, id, bad as any),
        ).rejects.toThrow();
    } finally {
      a.db.close();
    }
  });
  it("fails explicitly instead of silently truncating a large snapshot", async () => {
    const a = await fixture();
    try {
      const q = a.db.query("INSERT INTO tasks VALUES (?,?,?)");
      for (let i = 0; i < 10001; i++)
        q.run(crypto.randomUUID(), 1, '{"title":"x"}');
      expect(() => exportData(a.storage, schema)).toThrow("BACKUP_TOO_LARGE");
    } finally {
      a.db.close();
    }
  });
});
describe("private R2 backup capsules", () => {
  it("copies bytes, commits manifest last and restores scoped files with matching checksums", async () => {
    const s = await fixture(),
      builds = bucket(),
      files = bucket(),
      fileId = crypto.randomUUID();
    try {
      await files.r2.put(`files/${scope}/${fileId}`, "hello");
      const store = new BackupStore(builds.r2, files.r2),
        value = {
          format: 1 as const,
          id,
          scope,
          at: 1234,
          bundle: await bundle(),
          data: exportData(s.storage, schema),
        };
      const summary = await store.create(value, [
        {
          id: fileId,
          name: "hello.txt",
          type: "text/plain",
          size: 5,
          createdAt: 1234,
        },
      ]);
      expect(summary.files).toBe(1);
      expect((await store.create(value, [])).files).toBe(1);
      const saved = (await store.read(scope, id))!;
      await files.r2.delete(`files/${scope}/${fileId}`);
      await store.copyFiles(saved, target);
      expect(
        await (await files.r2.get(`files/${target}/${fileId}`)).text(),
      ).toBe("hello");
      expect(await store.read(target, id)).toBeNull();
      expect((await store.list(scope)).page).toHaveLength(1);
      await store.remove(scope, id);
      expect(builds.objects.size).toBe(0);
      expect(files.objects.size).toBe(1);
    } finally {
      s.db.close();
    }
  });
  it("does not advertise a successful backup when a file is missing", async () => {
    const s = await fixture(),
      builds = bucket(),
      store = new BackupStore(builds.r2, bucket().r2);
    try {
      await expect(
        store.create(
          {
            format: 1,
            id,
            scope,
            at: 1,
            bundle: await bundle(),
            data: exportData(s.storage, schema),
          },
          [{ id: docId, name: "x", type: "text/plain", size: 1, createdAt: 1 }],
        ),
      ).rejects.toThrow();
      expect(await store.read(scope, id)).toBeNull();
    } finally {
      s.db.close();
    }
  });
  it("detects corrupted manifests and file bytes", async () => {
    const s = await fixture(),
      builds = bucket(),
      files = bucket(),
      store = new BackupStore(builds.r2, files.r2);
    try {
      await files.r2.put(`files/${scope}/${docId}`, "hello");
      await store.create(
        {
          format: 1,
          id,
          scope,
          at: 1,
          bundle: await bundle(),
          data: exportData(s.storage, schema),
        },
        [{ id: docId, name: "x", type: "text/plain", size: 5, createdAt: 1 }],
      );
      const saved = (await store.read(scope, id))!;
      await builds.r2.put(backupPrefix(scope, id) + "files/" + docId, "wrong");
      await expect(store.copyFiles(saved, target)).rejects.toThrow(
        "INVALID_BACKUP",
      );
      builds.objects.get(backupPrefix(scope, id) + "manifest.json")!.bytes =
        new TextEncoder().encode("{}");
      await expect(store.read(scope, id)).rejects.toThrow("INVALID_BACKUP");
    } finally {
      s.db.close();
    }
  });
  it.each(["../dev", scope + "/extra", "demo/dev"])(
    "rejects unsafe prefixes %s",
    (value) => expect(() => backupPrefix(value, id)).toThrow(),
  );
});
