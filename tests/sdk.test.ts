import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { createClient, type Socket } from "../packages/sdk/src/client.js";
import {
  action,
  defineApp,
  flatten,
  live,
  manifest,
  mutation,
  query,
  validate,
} from "../packages/sdk/src/server.js";
import {
  assertPath,
  boundedJson,
  reference,
  stableJson,
} from "../packages/sdk/src/protocol.js";
import { assertReadSql } from "../packages/sdk/src/read-sql.js";

afterEach(() => vi.useRealTimers());
const json = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
class TestSocket implements Socket {
  readyState = 0;
  frames: any[] = [];
  listeners = new Map<string, Set<(event: any) => void>>();
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, fn: (event: any) => void) {
    const list = this.listeners.get(type) ?? new Set();
    list.add(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, data: any) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(data);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  snapshot(id: string, revision: number, result: unknown) {
    this.emit("message", {
      data: JSON.stringify({ type: "snapshot", id, revision, result }),
    });
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}
const ticks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("wire protocol", () => {
  it("canonicalizes objects without conflating arrays", () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    new Date(),
    1n,
    [undefined],
    { a: undefined },
    new Map(),
    [, 1],
  ])("rejects lossy JSON %#", (value) =>
    expect(() => stableJson(value)).toThrow(),
  );
  it("rejects cycles, accessors and excessive nesting", () => {
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => stableJson(cycle)).toThrow();
    let called = false;
    expect(() =>
      stableJson({
        get x() {
          called = true;
          return 1;
        },
      }),
    ).toThrow();
    expect(called).toBe(false);
    let nested: any = null;
    for (let i = 0; i < 45; i++) nested = [nested];
    expect(() => stableJson(nested)).toThrow();
  });
  it("permits repeated noncyclic references", () => {
    const value = { a: 1 };
    expect(stableJson([value, value])).toBe('[{"a":1},{"a":1}]');
  });
  it("measures UTF-8 bytes, not JS string length", () =>
    expect(() => boundedJson("🔥", 5)).toThrow());
  it.each(["constructor", "tasks/prototype", "a/../b", "a//b", "", "a-b"])(
    "rejects unsafe path %s",
    (path) => expect(() => assertPath(path)).toThrow(),
  );
});
describe("read SQL capability", () => {
  it.each([
    "SELECT * FROM tasks",
    " /* comment */ SELECT count(*) FROM tasks",
    "-- prefix\n SELECT 'value;DROP TABLE x'",
    'SELECT "a;column" FROM x',
    "SELECT 'it''s;safe'",
    "SELECT [a;b] FROM x",
    "SELECT `a;b` FROM x",
    "SELECT 1 /* ; UPDATE tasks */",
  ])("accepts one SELECT: %s", (value) =>
    expect(() => assertReadSql(value)).not.toThrow(),
  );
  it.each([
    "UPDATE tasks SET x=1",
    "SELECT 1; UPDATE tasks SET x=1",
    "SELECT 1; -- comment\nDROP TABLE tasks",
    "PRAGMA query_only=OFF",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "/* unclosed",
    "SELECT 'unclosed",
    "/* comment */ DELETE FROM tasks",
    "-- comment",
    "SELECT 1; /*tail*/",
  ])("rejects unavailable SQL: %s", (value) =>
    expect(() => assertReadSql(value)).toThrow(),
  );
});

describe("function contracts", () => {
  const table = sqliteTable("counter", { id: integer().primaryKey() });
  const options = {
    input: z.object({ id: z.number() }),
    output: z.number(),
    handler: () => 1,
  };
  it("exposes four kinds with required auth by default", () => {
    expect(
      [query(options), live(options), mutation(options), action(options)].map(
        (f) => [f.kind, f.auth],
      ),
    ).toEqual([
      ["query", "required"],
      ["live", "required"],
      ["mutation", "required"],
      ["action", "required"],
    ]);
  });
  it("generates JSON Schema contracts with no handler/source serialization", () => {
    const app = defineApp({
      tables: { counter: table },
      functions: {
        counter: {
          get: query(options),
          watch: live({ ...options, auth: "public" }),
        },
      },
    });
    const contract = manifest(app);
    expect(Object.keys(contract.functions)).toEqual([
      "counter/get",
      "counter/watch",
    ]);
    expect(contract.functions["counter/get"].input.type).toBe("object");
    expect(contract.functions["counter/watch"].auth).toBe("public");
    expect(JSON.stringify(contract)).not.toContain("handler");
  });
  it("validates both input and output including async schemas", async () => {
    await expect(validate(z.number(), "wrong")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(validate(z.number(), "wrong", true)).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    });
    await expect(
      validate(
        z.number().refine(async (x) => x > 0),
        1,
      ),
    ).resolves.toBe(1);
  });
  it("rejects non-JSON transformations and schemas without JSON converters", async () => {
    await expect(
      validate(
        z.string().transform(() => new Date()),
        "x",
      ),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
    const schema: any = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    };
    expect(() =>
      manifest({ functions: { test: query({ ...options, input: schema }) } }),
    ).toThrow(/JSON Schema/);
  });
  it("rejects cyclic function trees", () => {
    const tree: any = {};
    tree.a = tree;
    expect(() => flatten(tree)).toThrow();
  });
});

describe("HTTP client", () => {
  it("works without window and sends fresh authorization per call", async () => {
    const fetch = vi.fn(async (_url: unknown, _options: unknown) => json(4));
    let token = "one";
    const client = createClient({
      url: "https://backend.example/project/dev",
      fetch: fetch as any,
      getToken: () => token,
    });
    const ref = reference<{ id: number }, number>("counter/get", "query");
    expect(await client.call(ref, { id: 1 })).toBe(4);
    token = "two";
    await client.call(ref, { id: 1 });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://backend.example/project/dev/v1/call",
    );
    expect((fetch.mock.calls[1] as any)[1].headers.Authorization).toBe(
      "Bearer two",
    );
    client.dispose();
  });
  it("never retries a mutation with an ambiguous network outcome", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("socket lost");
    });
    const client = createClient({
      url: "https://backend.example",
      fetch: fetch as any,
    });
    await expect(
      client.call(reference("counter/increment", "mutation"), {}),
    ).rejects.toMatchObject({ ambiguous: true, code: "TRANSPORT_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("marks server errors ambiguous for writes, not validation/auth errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(null, 503))
      .mockResolvedValueOnce(json(null, 403));
    const client = createClient({ url: "https://backend.example", fetch });
    const ref = reference("x", "mutation");
    await expect(client.call(ref, {})).rejects.toMatchObject({
      ambiguous: true,
    });
    await expect(client.call(ref, {})).rejects.toMatchObject({
      ambiguous: false,
    });
    client.dispose();
  });
  it("rejects oversized and malformed responses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json("x".repeat(270000)))
      .mockResolvedValueOnce(new Response("not json"));
    const client = createClient({ url: "https://backend.example", fetch });
    const ref = reference("x", "query");
    await expect(client.call(ref, {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(client.call(ref, {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    client.dispose();
  });
  it("rejects remote cleartext, credentials and use after disposal", async () => {
    expect(() => createClient({ url: "http://remote.example" })).toThrow();
    expect(() =>
      createClient({ url: "https://user:secret@example.com" }),
    ).toThrow();
    const client = createClient({ url: "http://localhost:8799" });
    client.dispose();
    await expect(
      client.call(reference("x", "query"), {}),
    ).rejects.toMatchObject({ code: "DISPOSED" });
  });
});

async function fixture() {
  const sockets: TestSocket[] = [];
  const urls: string[] = [];
  const fetch = vi.fn(async () => json({ ticket: "short-lived-single-use" }));
  const client = createClient({
    url: "https://backend.example",
    fetch: fetch as any,
    getToken: () => "long-token",
    createWebSocket: (url) => {
      urls.push(url);
      const ws = new TestSocket();
      sockets.push(ws);
      return ws;
    },
  });
  return { client, sockets, urls, fetch };
}
describe("live client lifecycle", () => {
  it("deduplicates subscriptions, suppresses stale/unchanged values, ACKs, cleans listeners", async () => {
    const { client, sockets, urls } = await fixture();
    const a = vi.fn(),
      b = vi.fn();
    const ref = reference("counter/watch", "live");
    const stopA = client.subscribe(ref, {}, { next: a }),
      stopB = client.subscribe(ref, {}, { next: b });
    await ticks();
    const ws = sockets[0];
    ws.open();
    expect(ws.frames).toHaveLength(1);
    expect(urls[0]).not.toContain("long-token");
    const id = ws.frames[0].id;
    ws.snapshot(id, 1, { value: 1 });
    ws.snapshot(id, 2, { value: 1 });
    ws.snapshot(id, 0, { value: 99 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(ws.frames.at(-1)).toEqual({ type: "ack", id, revision: 2 });
    stopA();
    expect(ws.readyState).toBe(1);
    stopB();
    expect(ws.readyState).toBe(3);
    expect(ws.listenerCount()).toBe(0);
    client.dispose();
  });
  it("isolates observer mutations and exceptions", async () => {
    const { client, sockets } = await fixture();
    const second = vi.fn();
    const ref = reference<any, any>("counter/watch", "live");
    client.subscribe(
      ref,
      {},
      {
        next: (value) => {
          value.x = 999;
          throw new Error("observer");
        },
      },
    );
    client.subscribe(ref, {}, { next: second });
    await ticks();
    const ws = sockets[0];
    ws.open();
    ws.snapshot(ws.frames[0].id, 1, { x: 1 });
    expect(second).toHaveBeenCalledWith({ x: 1 });
    expect(ws.frames.at(-1).type).toBe("ack");
    client.dispose();
  });
  it("uses a new ticket on reconnect and accepts fresh snapshots with reset revision", async () => {
    vi.useFakeTimers();
    const { client, sockets, fetch } = await fixture();
    const next = vi.fn();
    client.subscribe(reference("counter/watch", "live"), {}, { next });
    await ticks();
    const first = sockets[0];
    first.open();
    first.snapshot(first.frames[0].id, 10, 10);
    first.close();
    await vi.advanceTimersByTimeAsync(300);
    await ticks();
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = sockets[1];
    second.open();
    second.snapshot(second.frames[0].id, 1, 20);
    expect(next).toHaveBeenLastCalledWith(20);
    expect(first.listenerCount()).toBe(0);
    client.dispose();
  });
  it("clears cached identity and terminal errors when authorization changes", async () => {
    const { client, sockets } = await fixture();
    const next = vi.fn();
    const ref = reference("counter/watch", "live");
    client.subscribe(ref, {}, { next });
    await ticks();
    sockets[0].open();
    sockets[0].snapshot(sockets[0].frames[0].id, 5, "old-user");
    client.refreshAuth();
    const newObserver = vi.fn();
    client.subscribe(ref, {}, { next: newObserver });
    expect(newObserver).not.toHaveBeenCalled();
    await ticks();
    sockets[1].open();
    sockets[1].snapshot(sockets[1].frames[0].id, 1, "new-user");
    expect(newObserver).toHaveBeenCalledWith("new-user");
    client.dispose();
  });
  it("disposes during ticket acquisition without opening a socket", async () => {
    let resolve!: (response: Response) => void;
    const createWebSocket = vi.fn();
    const client = createClient({
      url: "https://backend.example",
      fetch: (() => new Promise((r) => (resolve = r))) as any,
      createWebSocket,
    });
    client.subscribe(reference("counter/watch", "live"), {}, { next() {} });
    await ticks();
    client.dispose();
    resolve(json({ ticket: "ticket" }));
    await ticks();
    expect(createWebSocket).not.toHaveBeenCalled();
  });
  it("keeps independent registrations when an observer object is reused", async () => {
    const { client, sockets } = await fixture();
    const next = vi.fn(),
      observer = { next };
    const ref = reference("counter/watch", "live");
    const stop = client.subscribe(ref, {}, observer);
    client.subscribe(ref, {}, observer);
    await ticks();
    const ws = sockets[0];
    ws.open();
    stop();
    ws.snapshot(ws.frames[0].id, 1, 7);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(1);
    client.dispose();
  });
});

describe("expired live cache", () => {
  it("clears cached snapshots when the server closes for authorization", async () => {
    const { client, sockets } = await fixture();
    const ref = reference("counter/watch", "live"),
      error = vi.fn();
    client.subscribe(ref, {}, { next() {}, error });
    await ticks();
    const ws = sockets[0];
    ws.open();
    ws.snapshot(ws.frames[0].id, 1, "PRIVATE_OLD_IDENTITY");
    ws.readyState = 3;
    ws.emit("close", { code: 1008 });
    const next = vi.fn();
    client.subscribe(ref, {}, { next });
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "AUTH_EXPIRED" }),
    );
    client.dispose();
  });
  it("does not replay cached values after an unauthorized live frame", async () => {
    const { client, sockets } = await fixture();
    const ref = reference("counter/watch", "live");
    client.subscribe(ref, {}, { next() {} });
    await ticks();
    const ws = sockets[0];
    ws.open();
    const id = ws.frames[0].id;
    ws.snapshot(id, 1, "PRIVATE");
    ws.emit("message", {
      data: JSON.stringify({ type: "error", id, code: "UNAUTHORIZED" }),
    });
    const next = vi.fn();
    client.subscribe(ref, {}, { next });
    expect(next).not.toHaveBeenCalled();
    client.dispose();
  });
});
