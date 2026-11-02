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
} from "../packages/flare/src/sdk/schema.js";
import {
  exportData,
  restoreData,
  emptyData,
} from "../packages/flare/src/sdk/backup.js";
import {
  BackupStore,
  BackupInventory,
  backupPrefix,
} from "../packages/core/src/backups.js";
import { digest } from "../packages/core/src/security.js";
import { stableJson } from "../packages/flare/src/sdk/protocol.js";
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
describe("Supervisor backup inventory", () => {
  it("seeks deep pages through timestamp ties and incomplete backups without rescanning", async () => {
    const { db, storage } = await fixture();
    try {
      const calls: { text: string; args: any[] }[] = [];
      const exec = storage.sql.exec.bind(storage.sql);
      storage.sql.exec = (text: string, ...args: any[]) => {
        if (text.startsWith("SELECT * FROM backup_index WHERE"))
          calls.push({ text, args });
        return exec(text, ...args);
      };
      const inventory = new BackupInventory(
        storage as any,
        { completed: async () => true } as any,
        scope,
      );
      db.exec("UPDATE backup_inventory SET complete=1");
      for (let i = 0; i < 65; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        const at = Math.floor(i / 23) - 1;
        db.query("INSERT INTO backup_index VALUES (?,?,?)").run(
          id,
          at,
          JSON.stringify(
            at < 0
              ? { id, scope, state: "incomplete" }
              : {
                  id,
                  scope,
                  at,
                  hash: "fixture",
                  revision: i,
                  rows: 0,
                  files: 0,
                },
          ),
        );
      }
      const expected = db
        .query("SELECT id FROM backup_index ORDER BY at DESC,id DESC")
        .all()
        .map((r: any) => r.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await inventory.list(cursor);
        seen.push(...result.page.map((item: any) => item.id));
        cursor = result.cursor ?? undefined;
        // A cursor is a key, not a requirement that its row still exists.
        db.query("DELETE FROM backup_index WHERE id=?").run(
          result.page.at(-1)!.id,
        );
      } while (cursor);
      expect(seen).toEqual(expected);
      expect(calls).toHaveLength(3);
      for (const { text, args } of calls) {
        const plan = db
          .query("EXPLAIN QUERY PLAN " + text)
          .all(...args)
          .map((r: any) => r.detail)
          .join(" ");
        expect(plan).toContain(
          "SEARCH backup_index USING INDEX backup_index_at",
        );
        expect(plan).not.toContain("SCAN");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    } finally {
      db.close();
    }
  });
  it("reads one bounded R2 metadata page concurrently and preserves listing order", async () => {
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const pending: { key: string; resolve: (value: any) => void }[] = [];
    const store = new BackupStore(
      {
        async list(options: any) {
          expect(options).toEqual({
            prefix: backupPrefix(scope),
            delimiter: "/",
            limit: 20,
            cursor: "previous",
          });
          return {
            delimitedPrefixes: ids.map((id) => backupPrefix(scope, id)),
            truncated: true,
            cursor: "next",
          };
        },
        head(key: string) {
          return new Promise((resolve) => pending.push({ key, resolve }));
        },
      } as any,
      undefined,
    );
    const result = store.list(scope, "previous");
    await Promise.resolve();
    expect(pending.map((p) => p.key)).toEqual(
      ids.map((id) => backupPrefix(scope, id) + "manifest.json"),
    );
    for (let i = pending.length - 1; i >= 0; i--)
      pending[i].resolve(
        i === 7
          ? null
          : {
              customMetadata: {
                at: String(i),
                revision: "1",
                release: "hash",
                rows: "2",
                files: "0",
              },
            },
      );
    const page = await result;
    expect(page.cursor).toBe("next");
    expect(page.page.map((item) => item.id)).toEqual(ids);
    expect(page.page[7]).toEqual({ id: ids[7], scope, state: "incomplete" });
    expect(page.page[19]).toMatchObject({
      at: 19,
      revision: 1,
      rows: 2,
      files: 0,
    });
  });
  it("does not checkpoint partial metadata results when a concurrent read fails", async () => {
    const { db, storage } = await fixture();
    try {
      const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
      const pending: {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
      }[] = [];
      let failed = true;
      const cursors: unknown[] = [];
      const store = new BackupStore(
        {
          async list(options: any) {
            cursors.push(options.cursor);
            return {
              delimitedPrefixes: ids.map((id) => backupPrefix(scope, id)),
              truncated: true,
              cursor: "next",
            };
          },
          async head() {
            if (failed)
              return new Promise((resolve, reject) =>
                pending.push({ resolve, reject }),
              );
            return null;
          },
        } as any,
        undefined,
      );
      const inventory = new BackupInventory(storage as any, store, scope);
      const result = inventory.list();
      await Promise.resolve();
      expect(pending).toHaveLength(3);
      pending[1].reject(Error("metadata unavailable"));
      await expect(result).rejects.toThrow("metadata unavailable");
      pending[0].resolve(null);
      pending[2].resolve(null);
      await Promise.resolve();
      expect(db.query("SELECT COUNT(*) n FROM backup_index").get()).toEqual({
        n: 0,
      });
      expect(
        db.query("SELECT cursor,complete FROM backup_inventory").get(),
      ).toEqual({ cursor: null, complete: 0 });
      failed = false;
      const retried = await inventory.list();
      expect(cursors).toEqual([undefined, undefined]);
      expect(retried.page).toHaveLength(3);
      expect(retried.inventory).toBe("partial");
      expect(
        db.query("SELECT cursor,complete FROM backup_inventory").get(),
      ).toEqual({ cursor: "next", complete: 0 });
    } finally {
      db.close();
    }
  });
  it("does not confuse UUID order with newest completed and survives restart/delete ambiguity", async () => {
    const { db, storage } = await fixture(),
      { r2, objects } = bucket();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ];
    const now = Date.now();
    for (const [i, id] of ids.entries())
      await r2.put(backupPrefix(scope, id) + "manifest.json", "fixture", {
        customMetadata: {
          sha256: "verified",
          at: String(now - i * 86400001),
          release: "hash",
          revision: "1",
          rows: "2",
          files: "0",
        },
      });
    const store = new BackupStore(r2, undefined);
    const inventory = new BackupInventory(storage as any, store, scope);
    const page = await inventory.list();
    expect(page.inventory).toBe("complete");
    expect(page.latest?.id).toBe(ids[0]);
    expect(page.page.map((r) => r.id)).toEqual(ids);
    expect(page.recoveryPoint).toBe("within-24h");
    expect(
      (await new BackupInventory(storage as any, store, scope).list()).latest
        ?.id,
    ).toBe(ids[0]);
    const old = r2.delete;
    r2.delete = async (keys: any) => {
      await old(keys);
      throw Error("lost delete acknowledgement");
    };
    await expect(inventory.remove(ids[0])).rejects.toThrow();
    r2.delete = old;
    expect(objects.has(backupPrefix(scope, ids[0]) + "manifest.json")).toBe(
      false,
    );
    const after = await inventory.list();
    expect(after.latest?.id).toBe(ids[1]);
    expect(after.recoveryPoint).toBe("overdue");
    await expect(
      inventory.list(
        btoa(JSON.stringify({ scope: target, at: now, id: ids[1] })),
      ),
    ).rejects.toThrow("INVALID_CURSOR");
    db.close();
  });
  it("marks a paginated legacy scan unknown until every page is incorporated", async () => {
    const { db, storage } = await fixture();
    let scans = 0;
    const id = crypto.randomUUID(),
      at = Date.now();
    const store = {
      list: async () => ({
        page: [
          { id, scope, at, hash: "fixture", revision: 0, rows: 0, files: 0 },
        ],
        cursor: ++scans === 1 ? "next" : null,
      }),
      completed: async () => true,
    };
    const inventory = new BackupInventory(storage as any, store as any, scope);
    expect((await inventory.list()).recoveryPoint).toBe("unknown");
    expect((await inventory.list()).latest?.id).toBe(id);
    db.close();
  });
});
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
  it.each(["create", "restore"] as const)(
    "bounds %s streams, preserves order and waits for in-flight writes on failure",
    async (operation) => {
      for (const fail of [false, true]) {
        const s = await fixture(),
          builds = bucket(),
          files = bucket();
        try {
          const entries = Array.from({ length: 7 }, (_, i) => ({
            id: crypto.randomUUID(),
            name: `file${i}`,
            type: "text/plain",
            size: 1,
            createdAt: i,
          }));
          for (const [i, file] of entries.entries())
            await files.r2.put(`files/${scope}/${file.id}`, String(i));
          const store = new BackupStore(builds.r2, files.r2);
          const value = {
            format: 1 as const,
            id: crypto.randomUUID(),
            scope,
            at: 1,
            bundle: await bundle(),
            data: exportData(s.storage, schema),
          };
          if (operation === "restore") await store.create(value, entries);
          const saved =
            operation === "restore" ? await store.read(scope, value.id) : null;
          const destination = operation === "create" ? builds.r2 : files.r2;
          const put = destination.put.bind(destination);
          const writes: {
            resolve: () => void;
            reject: (error: Error) => void;
          }[] = [];
          let active = 0,
            peak = 0,
            settled = false,
            manifests = 0;
          destination.put = async (key: string, body: any, options: any) => {
            if (key.endsWith("manifest.json")) {
              expect(active).toBe(0);
              expect(writes).toHaveLength(entries.length);
              manifests++;
              return put(key, body, options);
            }
            peak = Math.max(peak, ++active);
            try {
              await new Promise<void>((resolve, reject) =>
                writes.push({ resolve, reject }),
              );
              return await put(key, body, options);
            } finally {
              active--;
            }
          };
          const pending =
            operation === "create"
              ? store.create(value, entries)
              : store.copyFiles(saved!, target);
          void pending.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          const waitForWrites = async (count: number) => {
            for (let i = 0; i < 200 && writes.length < count; i++)
              await Bun.sleep(1);
            expect(writes).toHaveLength(count);
          };
          await waitForWrites(3);
          expect(active).toBe(3);
          if (fail) {
            writes[1].reject(Error("copy unavailable"));
            await Bun.sleep(1);
            expect(settled).toBe(false);
            expect(writes).toHaveLength(3);
            writes[2].resolve();
            writes[0].resolve();
            await expect(pending).rejects.toThrow("copy unavailable");
            expect(writes).toHaveLength(3);
            expect(manifests).toBe(0);
          } else {
            // A free slot starts another file without waiting for slow peers.
            let count = 3;
            for (const i of [2, 0, 1, 3]) {
              writes[i].resolve();
              await waitForWrites(++count);
              expect(active).toBe(3);
            }
            for (const i of [6, 5, 4]) writes[i].resolve();
            await pending;
            expect(manifests).toBe(operation === "create" ? 1 : 0);
            expect(
              (await store.read(scope, value.id))!.files.map((file) => file.id),
            ).toEqual(entries.map((file) => file.id));
            if (operation === "restore")
              for (const [i, file] of entries.entries())
                expect(
                  await (
                    await files.r2.get(`files/${target}/${file.id}`)
                  ).text(),
                ).toBe(String(i));
          }
          expect(peak).toBe(3);
          expect(active).toBe(0);
        } finally {
          s.db.close();
        }
      }
    },
  );
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
