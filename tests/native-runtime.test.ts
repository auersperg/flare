import { describe, expect, it, afterEach, jest } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appPolicy,
  appSecret,
  outbound,
} from "../packages/core/src/capabilities.js";
import {
  collectJobHistory,
  jobRetentionMs,
} from "../packages/core/src/retention.js";
import {
  needsSnapshot,
  SnapshotCache,
} from "../packages/core/src/reactivity.js";
const scope = "00000000-0000-4000-8000-000000000001/dev";
afterEach(() => jest.restoreAllMocks());
describe("native runtime capabilities", () => {
  it("denies network and secrets by default", async () => {
    expect(appPolicy({}, scope)).toEqual({ outbound: [], secrets: {} });
    await expect(
      outbound(new Request("https://api.example.com"), appPolicy({}, scope)),
    ).rejects.toMatchObject({ code: "OUTBOUND_DENIED" });
    await expect(appSecret({}, scope, "KEY")).rejects.toMatchObject({
      code: "SECRET_NOT_FOUND",
    });
  });
  it("grants only a selected environment's native Secrets Store binding", async () => {
    const binding = { get: jest.fn(async () => "test-secret") };
    const env = {
      APP_CAPABILITIES: JSON.stringify({
        [scope]: { secrets: { KEY: "APP_SECRET_TEST" } },
      }),
      APP_SECRET_TEST: binding,
    };
    expect(await appSecret(env, scope, "KEY")).toBe("test-secret");
    await expect(
      appSecret(env, scope.replace("/dev", "/prod"), "KEY"),
    ).rejects.toThrow();
    await expect(appSecret(env, scope, "DEV_SIGNING_KEY")).rejects.toThrow();
    expect(binding.get).toHaveBeenCalledTimes(1);
  });
  it.each([
    { outbound: ["*"] },
    { outbound: ["*.example.com"] },
    { outbound: ["127.0.0.1"] },
    { outbound: ["localhost"] },
    { outbound: ["api.internal"] },
    { outbound: ["api.example.com:443"] },
    { secrets: { KEY: "DEV_SIGNING_KEY" } },
    { secrets: { KEY: "BUNDLES" } },
    { unknown: true },
  ])("rejects unsafe operator policy %j", (value) =>
    expect(() =>
      appPolicy(
        { APP_CAPABILITIES: JSON.stringify({ [scope]: value }) },
        scope,
      ),
    ).toThrow(),
  );
  it.each([
    "http://api.example.com",
    "https://api.example.com:444",
    "https://user:password@api.example.com",
    "https://other.example.com",
    "https://api.example.com.attacker.test",
  ])("blocks disallowed URL %s", async (url) => {
    await expect(
      outbound(new Request(url), {
        outbound: ["api.example.com"],
        secrets: {},
      }),
    ).rejects.toMatchObject({ code: "OUTBOUND_DENIED" });
  });
  it("forwards HTTPS with a deadline and no redirects or platform headers", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await outbound(
      new Request("https://api.example.com/data", {
        headers: {
          "cf-access-jwt-assertion": "private",
          authorization: "Bearer app-key",
        },
      }),
      { outbound: ["api.example.com"], secrets: {} },
    );
    const body: unknown = await response.json();
    expect(body).toEqual({ ok: true });
    const options = fetchMock.mock.calls[0][1]!;
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).has("cf-access-jwt-assertion")).toBe(
      false,
    );
    expect(new Headers(options.headers).get("authorization")).toBe(
      "Bearer app-key",
    );
  });
  it("refuses redirection to another destination", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.redirect("https://attacker.test"));
    await expect(
      outbound(new Request("https://api.example.com"), {
        outbound: ["api.example.com"],
        secrets: {},
      }),
    ).rejects.toMatchObject({ code: "OUTBOUND_DENIED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds a chunked response without buffering the entire body", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(1048577));
            c.close();
          },
        }),
      ),
    );
    const response = await outbound(new Request("https://api.example.com"), {
      outbound: ["api.example.com"],
      secrets: {},
    });
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });
});
describe("conservative live invalidation", () => {
  const sub = {
    dependencies: JSON.stringify(["tasks"]),
    checked: 5,
    release: "v1",
  };
  it("ignores writes to an unrelated table", () =>
    expect(needsSnapshot(sub, "v1", { tasks: 5, notes: 6 })).toBe(false));
  it("recomputes changed table reads", () =>
    expect(needsSnapshot(sub, "v1", { tasks: 6 })).toBe(true));
  it("forces a new snapshot when application code changes", () =>
    expect(needsSnapshot(sub, "v2", { tasks: 5 })).toBe(true));
  it("resynchronizes subscriptions without stored dependencies", () =>
    expect(needsSnapshot({ ...sub, dependencies: null }, "v1", {})).toBe(true));
  it("does not rerun a constant query after a data-only change", () =>
    expect(
      needsSnapshot({ ...sub, dependencies: "[]" }, "v1", { tasks: 6 }),
    ).toBe(false));
});
describe("bounded broadcast snapshots", () => {
  const snapshot = (result: string) => ({
    result,
    revision: 1,
    tables: ["tasks"],
  });
  it("loads and hashes one shared query once per broadcast", async () => {
    const cache = new SnapshotCache();
    const load = jest.fn(async () => snapshot("same"));
    const hashing = jest.spyOn(crypto.subtle, "digest");
    const first = await cache.get("same-auth-query", load);
    expect(await cache.get("same-auth-query", load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hashing).toHaveBeenCalledTimes(1);
    // A new broadcast never serves the preceding commit's result.
    await new SnapshotCache().get("same-auth-query", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("never combines different identity keys", async () => {
    const cache = new SnapshotCache();
    expect(
      (await cache.get("user-a", async () => snapshot("a"))).value.result,
    ).toBe("a");
    expect(
      (await cache.get("user-b", async () => snapshot("b"))).value.result,
    ).toBe("b");
  });
  it("evicts old entries at the byte budget and never caches oversized results", async () => {
    const cache = new SnapshotCache(50, 64);
    const load = jest.fn(async () => snapshot("x".repeat(20)));
    await cache.get("first", load);
    await cache.get("second", load);
    await cache.get("first", load);
    expect(load).toHaveBeenCalledTimes(3);
    const large = jest.fn(async () => snapshot("x".repeat(100)));
    await cache.get("large", large);
    await cache.get("large", large);
    expect(large).toHaveBeenCalledTimes(2);
  });
  it("bounds small entries too and does not cache failures", async () => {
    const cache = new SnapshotCache(1048576, 1);
    const load = jest.fn(async () => snapshot("ok"));
    await cache.get("first", load);
    await cache.get("second", load);
    await cache.get("first", load);
    expect(load).toHaveBeenCalledTimes(3);
    const fail = jest.fn(async () => {
      throw Error("temporary");
    });
    await expect(cache.get("failed", fail)).rejects.toThrow("temporary");
    expect((await cache.get("failed", load)).value.result).toBe("ok");
  });
});
describe("on-demand retention", () => {
  it("bounds cleanup and preserves active jobs and recent deduplication receipts", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE receipts(id TEXT PRIMARY KEY,at INTEGER);CREATE TABLE job_events(id TEXT PRIMARY KEY,state TEXT,at INTEGER)",
      );
      const now = Date.now(),
        old = now - jobRetentionMs - 1;
      for (let i = 0; i < 1005; i++)
        db.query("INSERT INTO receipts VALUES (?,?)").run(String(i), old);
      db.query("INSERT INTO receipts VALUES (?,?)").run("recent", now);
      for (const state of ["queued", "running", "failed", "completed"])
        db.query("INSERT INTO job_events VALUES (?,?,?)").run(
          state,
          state,
          old,
        );
      const sql = {
        exec(statement: string, cutoff: number) {
          return { rowsWritten: db.query(statement).run(cutoff).changes };
        },
      } as unknown as SqlStorage;
      expect(collectJobHistory(sql, now)).toBe(1002);
      expect(db.query("SELECT count(*) n FROM receipts").get()).toEqual({
        n: 6,
      });
      expect(
        db.query("SELECT state FROM job_events ORDER BY state").all(),
      ).toEqual([{ state: "queued" }, { state: "running" }]);
      expect(collectJobHistory(sql, now)).toBe(5);
      expect(db.query("SELECT id FROM receipts").all()).toEqual([
        { id: "recent" },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("release retention", () => {
  it("keeps five successful builds, active/candidate and queued jobs without timers", async () => {
    const { releaseRetentionQuery } =
      await import("../packages/core/src/retention.js");
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE releases(hash TEXT PRIMARY KEY,at INTEGER);CREATE TABLE release_history(hash TEXT PRIMARY KEY,at INTEGER);CREATE TABLE activation(active TEXT,candidate TEXT);CREATE TABLE job_events(release TEXT,state TEXT);",
      );
      for (let n = 1; n <= 11; n++) {
        db.query("INSERT INTO releases VALUES (?,?)").run(String(n), n);
        if (n <= 10)
          db.query("INSERT INTO release_history VALUES (?,?)").run(
            String(n),
            n,
          );
      }
      db.exec(
        "INSERT INTO activation VALUES ('1','2');INSERT INTO job_events VALUES ('3','queued');",
      );
      const rows = db.query(releaseRetentionQuery).all(100) as {
        hash: string;
      }[];
      expect(rows.map((r) => r.hash)).toEqual(["4", "5", "11"]);
    } finally {
      db.close();
    }
  });
});
