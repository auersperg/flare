import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import {
  FileStore,
  fileInput,
  fileKey,
  fileOriginAllowed,
} from "../packages/core/src/files";
const scope = "b6466091-bacf-4193-93ea-4d86d2db9960/dev";
function fixture() {
  const db = new Database(":memory:");
  const storage: any = {
    sql: {
      exec(sql: string, ...args: any[]) {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...args) as any[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw Error("Expected one row");
            return rows[0];
          },
        };
      },
    },
    transactionSync(fn: () => unknown) {
      return db.transaction(fn)();
    },
  };
  const objects = new Map<string, { size: number }>();
  const bucket: any = {
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const wakes: number[] = [];
  FileStore.initialize(storage);
  const files = new FileStore(
    storage,
    bucket,
    scope,
    "https://api.example.test",
    async (at) => {
      wakes.push(at);
    },
  );
  return { db, storage, objects, wakes, files };
}
const input = { name: "hello.txt", type: "text/plain", size: 5 };
const ticket = (url: string) => new URL(url).searchParams.get("ticket")!;
describe("private scoped R2 files", () => {
  it("allows the installation dashboard for file grants only, never wildcard origins", () => {
    expect(
      fileOriginAllowed(
        "https://dashboard.example.test",
        [],
        "https://dashboard.example.test",
      ),
    ).toBe(true);
    expect(
      fileOriginAllowed("http://127.0.0.1:4321", ["http://127.0.0.1:4321"]),
    ).toBe(true);
    for (const origin of [
      "https://evil.test",
      "https://dashboard.example.test.evil.test",
      "http://dashboard.example.test",
      "null",
    ])
      expect(
        fileOriginAllowed(origin, [], "https://dashboard.example.test"),
      ).toBe(false);
    expect(fileOriginAllowed("https://dashboard.example.test", [])).toBe(false);
  });
  it("bounds size, MIME and unsafe names", () => {
    for (const value of [
      { ...input, size: 10485761 },
      { ...input, size: -1 },
      { ...input, size: 1.1 },
      { ...input, name: "../secret" },
      { ...input, name: "a\n" },
      { ...input, type: "text/html" },
    ])
      expect(() => fileInput(value)).toThrow();
    expect(fileInput({ ...input, size: 0 })).toEqual({ ...input, size: 0 });
    expect(() => fileKey(scope, "../prod/id")).toThrow();
    expect(() => fileKey("../../dev", crypto.randomUUID())).toThrow();
  });
  it("arms recovery before reservation and consumes upload tickets once", async () => {
    const f = fixture();
    const grant = await f.files.reserve(input);
    expect(f.wakes.length).toBe(1);
    expect(f.files.grant(ticket(grant.url), "upload")).toMatchObject({
      id: grant.id,
      size: 5,
    });
    expect(() => f.files.grant(ticket(grant.url), "upload")).toThrow();
    await expect(f.files.downloadUrl(grant.id)).rejects.toThrow();
    await expect(f.files.complete(grant.id)).rejects.toThrow();
    f.objects.set(fileKey(scope, grant.id), { size: 4 });
    await expect(f.files.complete(grant.id)).rejects.toThrow();
    f.objects.set(fileKey(scope, grant.id), { size: 5 });
    await f.files.complete(grant.id);
    expect(await f.files.complete(grant.id)).toEqual({ id: grant.id });
    const download = await f.files.downloadUrl(grant.id);
    expect(f.files.grant(ticket(download.url), "download").id).toBe(grant.id);
    expect(f.files.grant(ticket(download.url), "download").id).toBe(grant.id);
    expect(() => f.files.grant(ticket(download.url), "upload")).toThrow();
    f.db.close();
  });
  it("isolates environment grants and revokes them on deletion", async () => {
    const f = fixture(),
      other = fixture();
    const grant = await f.files.reserve(input);
    expect(() => other.files.grant(ticket(grant.url), "upload")).toThrow();
    f.files.grant(ticket(grant.url), "upload");
    f.objects.set(fileKey(scope, grant.id), { size: 5 });
    await f.files.complete(grant.id);
    const download = await f.files.downloadUrl(grant.id);
    expect(await f.files.remove(grant.id)).toEqual({ deleted: true });
    expect(() => f.files.grant(ticket(download.url), "download")).toThrow();
    expect(f.objects.size).toBe(0);
    expect(await f.files.remove(grant.id)).toEqual({ deleted: false });
    f.db.close();
    other.db.close();
  });
  it("expires tickets and recovers interrupted uploads without keeping abandoned objects", async () => {
    const f = fixture();
    const completed = await f.files.reserve(input),
      pending = await f.files.reserve(input);
    f.files.grant(ticket(completed.url), "upload");
    f.objects.set(fileKey(scope, completed.id), { size: 5 });
    f.db.exec("UPDATE files SET expires=0; UPDATE file_grants SET expires=0");
    expect(() => f.files.grant(ticket(pending.url), "upload")).toThrow();
    await f.files.sweep();
    expect(f.files.list().page).toMatchObject([
      { id: completed.id, state: "ready" },
    ]);
    expect(f.db.prepare("SELECT count(*) n FROM file_grants").get()).toEqual({
      n: 0,
    });
    f.db.close();
  });
  it("paginates all files with equal timestamps and a deleted cursor row", () => {
    const f = fixture();
    const ids = Array.from({ length: 123 }, () => crypto.randomUUID()).sort();
    for (const id of ids)
      f.db
        .prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?)")
        .run(id, "name", "text/plain", 0, "ready", 1, 0);
    const first = f.files.list({ limit: 50 });
    expect(first.page.map((row) => row.id)).toEqual(ids.slice(0, 50));
    expect(first.isDone).toBe(false);
    f.db.prepare("DELETE FROM files WHERE id=?").run(ids[49]);
    const second = f.files.list({ cursor: first.continueCursor, limit: 50 });
    const last = f.files.list({ cursor: second.continueCursor, limit: 50 });
    expect(
      [...first.page, ...second.page, ...last.page].map((row) => row.id),
    ).toEqual(ids);
    expect(last.isDone).toBe(true);
    expect(last.continueCursor).toBeNull();
    for (const limit of [0, -1, 101, 1.5])
      expect(() => f.files.list({ limit })).toThrow();
    for (const cursor of [
      "not-json",
      btoa('{"at":1,"id":"../dev"}'),
      "x".repeat(257),
    ])
      expect(() => f.files.list({ cursor })).toThrow();
    f.db.close();
  });
  it("does not report empty storage when R2 is unavailable", async () => {
    const f = fixture();
    const missing = new FileStore(
      f.storage,
      undefined,
      scope,
      "https://api.example.test",
      async () => {},
    );
    expect(() => missing.list()).toThrow();
    await expect(missing.reserve(input)).rejects.toThrow();
    f.db.close();
  });
});
