import { afterEach, describe, expect, it, jest } from "bun:test";
import { z } from "zod";
import { defineTable } from "../packages/flared/src/sdk/schema.js";
import {
  createClient,
  type Socket,
} from "../packages/flared/src/sdk/client.js";
import {
  action,
  defineApp,
  flatten,
  manifest,
  mutation,
  query,
  validate,
} from "../packages/flared/src/sdk/server.js";
import {
  assertPath,
  errorCode,
  boundedJson,
  reference,
  stableJson,
} from "../packages/flared/src/sdk/protocol.js";

afterEach(() => jest.useRealTimers());
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
describe("function contracts", () => {
  const table = defineTable(z.object({ value: z.number() }));
  const options = {
    input: z.object({ id: z.number() }),
    output: z.number(),
    handler: () => 1,
  };
  it("exposes three kinds with required auth by default", () => {
    expect(
      [query(options), mutation(options), action(options)].map((f) => [
        f.kind,
        f.auth,
      ]),
    ).toEqual([
      ["query", "required"],
      ["mutation", "required"],
      ["action", "required"],
    ]);
  });
  it("rejects the removed live declaration rather than publishing a compatibility alias", () => {
    expect(() =>
      defineApp({
        schema: {},
        functions: { old: { ...query(options), kind: "live" } as any },
      }),
    ).toThrow();
  });
  it("generates JSON Schema contracts with no handler/source serialization", () => {
    const app = defineApp({
      schema: { counter: table },
      functions: {
        counter: {
          get: query(options),
          publicGet: query({ ...options, auth: "public" }),
        },
      },
    });
    const contract = manifest(app);
    expect(Object.keys(contract.functions)).toEqual([
      "counter/get",
      "counter/publicGet",
    ]);
    expect(contract.functions["counter/get"].input.type).toBe("object");
    expect(contract.functions["counter/publicGet"].auth).toBe("public");
    expect(JSON.stringify(contract)).not.toContain("handler");
  });
  it("declares internal functions separately without relaxing the default", () => {
    const contract = manifest(
      defineApp({
        schema: {},
        functions: {
          hidden: mutation({ ...options, auth: "internal" }),
          public: action({ ...options, auth: "public" }),
          protected: query(options),
        },
      }),
    );
    expect(contract.runtimeAbi).toBe(4);
    expect(contract.functions.hidden.auth).toBe("internal");
    expect(contract.functions.public.auth).toBe("public");
    expect(contract.functions.protected.auth).toBe("required");
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
    const fetch = jest.fn(async (_url: unknown, _options: unknown) => json(4));
    let token = "one";
    const client = createClient({
      url: "https://backend.example/project/dev",
      fetch: fetch as any,
      getToken: () => token,
    });
    const ref = reference<{ id: number }, number>("counter/get", "query");
    expect(await client[ref.kind](ref, { id: 1 })).toBe(4);
    token = "two";
    await client[ref.kind](ref, { id: 1 });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://backend.example/project/dev/v1/call",
    );
    expect((fetch.mock.calls[1] as any)[1].headers.Authorization).toBe(
      "Bearer two",
    );
    client.dispose();
  });
  it("never retries a mutation with an ambiguous network outcome", async () => {
    const fetch = jest.fn(async () => {
      throw new Error("socket lost");
    });
    const client = createClient({
      url: "https://backend.example",
      fetch: fetch as any,
    });
    await expect(
      client.mutation(reference("counter/increment", "mutation"), {}),
    ).rejects.toMatchObject({ ambiguous: true, code: "TRANSPORT_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(1);
    client.dispose();
  });
  it("marks server errors ambiguous for writes, not validation/auth errors", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(json(null, 503))
      .mockResolvedValueOnce(json(null, 403));
    const client = createClient({ url: "https://backend.example", fetch });
    const ref = reference("x", "mutation");
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      ambiguous: true,
    });
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      ambiguous: false,
    });
    client.dispose();
  });
  it("preserves bounded backend error codes without replaying writes", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "OPERATION_FAILED" }), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new Response("<html>gateway failure</html>", { status: 502 }),
      );
    const client = createClient({ url: "https://backend.example", fetch });
    const ref = reference("x", "mutation");
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
      ambiguous: false,
    });
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      ambiguous: true,
    });
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      code: "HTTP_502",
      ambiguous: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    client.dispose();
  });
  it("rejects oversized and malformed responses", async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(json("x".repeat(270000)))
      .mockResolvedValueOnce(new Response("not json"));
    const client = createClient({ url: "https://backend.example", fetch });
    const ref = reference("x", "query");
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(client[ref.kind](ref, {})).rejects.toMatchObject({
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
      client.query(reference("x", "query"), {}),
    ).rejects.toMatchObject({ code: "DISPOSED" });
  });
});

async function fixture() {
  const sockets: TestSocket[] = [];
  const urls: string[] = [];
  const fetch = jest.fn(async (_url: string) =>
    json({ ticket: "short-lived-single-use" }),
  );
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
  it("one query supports one-off HTTP and a single subscription with its initial snapshot", async () => {
    const sockets: TestSocket[] = [];
    const fetch = jest.fn(async (url: string) =>
      json(url.endsWith("/v1/call") ? 42 : { ticket: "ticket" }),
    );
    const client = createClient({
      url: "https://backend.example",
      fetch,
      createWebSocket: () => {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const ref = reference<{}, number>("counter/get", "query");
    expect(await client.query(ref, {})).toBe(42);
    expect(sockets).toHaveLength(0);
    const next = jest.fn();
    const stop = client.onUpdate(ref, {}, next);
    await ticks();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://backend.example/v1/call",
      "https://backend.example/v1/live/ticket",
    ]);
    const ws = sockets[0];
    ws.open();
    expect(ws.frames).toEqual([
      { type: "subscribe", id: "subscription-1", path: ref.path, args: {} },
    ]);
    ws.snapshot("subscription-1", 1, 42);
    ws.snapshot("subscription-1", 2, 43);
    expect(next.mock.calls.map(([value]) => value)).toEqual([42, 43]);
    expect(fetch).toHaveBeenCalledTimes(2); // No initial HTTP read inside onUpdate, no polling.
    stop();
    client.dispose();
  });
  it("reactive reading alone never adds an initial HTTP query", async () => {
    const { client, sockets, fetch } = await fixture();
    const next = jest.fn();
    const stop = client.onUpdate(reference("counter/get", "query"), {}, next);
    await ticks();
    sockets[0].open();
    sockets[0].snapshot("subscription-1", 1, 7);
    expect(next).toHaveBeenCalledWith(7);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/v1/live/ticket");
    stop();
    client.dispose();
  });
  it.each(["mutation", "action"] as const)(
    "rejects subscription to %s before opening any transport",
    async (kind) => {
      const { client, sockets, fetch } = await fixture();
      expect(() => client.onUpdate(reference("x", kind), {}, () => {})).toThrow(
        "Only queries",
      );
      await expect(
        client.query(reference("x", kind), {}),
      ).rejects.toMatchObject({ code: "INVALID_KIND" });
      expect(fetch).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(0);
      client.dispose();
    },
  );
  it("exposes only the three call methods and onUpdate, with no call/subscribe aliases", async () => {
    const { client } = await fixture();
    expect(Object.keys(client).sort()).toEqual([
      "action",
      "dispose",
      "mutation",
      "onUpdate",
      "query",
      "refreshAuth",
    ]);
    client.dispose();
  });
  it("deduplicates subscriptions, suppresses stale/unchanged values, ACKs, cleans listeners", async () => {
    const { client, sockets, urls } = await fixture();
    const a = jest.fn(),
      b = jest.fn();
    const ref = reference("counter/publicGet", "query");
    const stopA = client.onUpdate(ref, {}, a),
      stopB = client.onUpdate(ref, {}, b);
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
    const second = jest.fn();
    const ref = reference<any, any>("counter/publicGet", "query");
    client.onUpdate(ref, {}, (value) => {
      value.x = 999;
      throw new Error("observer");
    });
    client.onUpdate(ref, {}, second);
    await ticks();
    const ws = sockets[0];
    ws.open();
    ws.snapshot(ws.frames[0].id, 1, { x: 1 });
    expect(second).toHaveBeenCalledWith({ x: 1 });
    expect(ws.frames.at(-1).type).toBe("ack");
    client.dispose();
  });
  it("uses a new ticket on reconnect and accepts fresh snapshots with reset revision", async () => {
    jest.useFakeTimers();
    const { client, sockets, fetch } = await fixture();
    const next = jest.fn();
    client.onUpdate(reference("counter/publicGet", "query"), {}, next);
    await ticks();
    const first = sockets[0];
    first.open();
    first.snapshot(first.frames[0].id, 10, 10);
    first.close();
    jest.advanceTimersByTime(300);
    await ticks();
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
    const next = jest.fn();
    const ref = reference("counter/publicGet", "query");
    client.onUpdate(ref, {}, next);
    await ticks();
    sockets[0].open();
    sockets[0].snapshot(sockets[0].frames[0].id, 5, "old-user");
    client.refreshAuth();
    const newObserver = jest.fn();
    client.onUpdate(ref, {}, newObserver);
    expect(newObserver).not.toHaveBeenCalled();
    await ticks();
    sockets[1].open();
    sockets[1].snapshot(sockets[1].frames[0].id, 1, "new-user");
    expect(newObserver).toHaveBeenCalledWith("new-user");
    client.dispose();
  });
  it("disposes during ticket acquisition without opening a socket", async () => {
    let resolve!: (response: Response) => void;
    const createWebSocket = jest.fn();
    const client = createClient({
      url: "https://backend.example",
      fetch: (() => new Promise((r) => (resolve = r))) as any,
      createWebSocket,
    });
    client.onUpdate(reference("counter/publicGet", "query"), {}, () => {});
    await ticks();
    client.dispose();
    resolve(json({ ticket: "ticket" }));
    await ticks();
    expect(createWebSocket).not.toHaveBeenCalled();
  });
  it("keeps independent registrations when an observer object is reused", async () => {
    const { client, sockets } = await fixture();
    const next = jest.fn(),
      observer = { next };
    const ref = reference("counter/publicGet", "query");
    const stop = client.onUpdate(ref, {}, observer.next);
    client.onUpdate(ref, {}, observer.next);
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
    const ref = reference("counter/publicGet", "query"),
      error = jest.fn();
    client.onUpdate(ref, {}, () => {}, error);
    await ticks();
    const ws = sockets[0];
    ws.open();
    ws.snapshot(ws.frames[0].id, 1, "PRIVATE_OLD_IDENTITY");
    ws.readyState = 3;
    ws.emit("close", { code: 1008 });
    const next = jest.fn();
    client.onUpdate(ref, {}, next);
    expect(next).not.toHaveBeenCalled();
    expect(error).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "AUTH_EXPIRED" }),
    );
    client.dispose();
  });
  it("does not replay cached values after an unauthorized live frame", async () => {
    const { client, sockets } = await fixture();
    const ref = reference("counter/publicGet", "query");
    client.onUpdate(ref, {}, () => {});
    await ticks();
    const ws = sockets[0];
    ws.open();
    const id = ws.frames[0].id;
    ws.snapshot(id, 1, "PRIVATE");
    ws.emit("message", {
      data: JSON.stringify({ type: "error", id, code: "UNAUTHORIZED" }),
    });
    const next = jest.fn();
    client.onUpdate(ref, {}, next);
    expect(next).not.toHaveBeenCalled();
    client.dispose();
  });
});

describe("separately bundled error contracts", () => {
  it("preserves only explicit bounded SDK codes without exposing messages", () => {
    class SeparateFlaredError extends Error {
      name = "FlaredError";
      code = "FORBIDDEN";
    }
    expect(errorCode(new SeparateFlaredError("private details"))).toBe(
      "FORBIDDEN",
    );
    expect(
      errorCode(
        Object.assign(new Error("private details"), { code: "FORBIDDEN" }),
      ),
    ).toBe("OPERATION_FAILED");
    expect(errorCode({ name: "FlaredError", code: "FORBIDDEN" })).toBe(
      "OPERATION_FAILED",
    );
    for (const code of [
      "password details",
      "X".repeat(65),
      "",
      "SECRET\nVALUE",
    ])
      expect(
        errorCode(Object.assign(new SeparateFlaredError(), { code })),
      ).toBe("OPERATION_FAILED");
  });
});
