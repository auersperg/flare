import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import {
  dashboardAllowed,
  dashboardIdentity,
} from "../packages/core/src/dashboard-live.js";
import { connectDashboardLive } from "../packages/core/dashboard/src/lib/live.js";
describe("Dashboard invalidation authorization", () => {
  it("clears the channel on confirmed HTTP upgrade denial, not merely a network disconnect", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "location"),
      fetcher = globalThis.fetch;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "https://dash.example.com" },
    });
    const socket: any = { close() {} },
      states: string[] = [];
    globalThis.fetch = (async () => new Response(null, { status: 403 })) as any;
    const stop = connectDashboardLive(
      "projects/id/dev",
      () => {},
      (s) => states.push(s),
      () => socket,
    );
    try {
      await socket.onclose({ code: 1006 });
      expect(states.at(-1)).toBe("revoked");
    } finally {
      stop();
      globalThis.fetch = fetcher;
      if (original) Object.defineProperty(globalThis, "location", original);
      else delete (globalThis as any).location;
    }
  });
  it("allows only existing member/environment, rejects revocation and deletion", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE members(email TEXT,role TEXT); CREATE TABLE projects(id TEXT); CREATE TABLE environments(projectId TEXT,env TEXT); CREATE TABLE project_deletions(projectId TEXT)",
    );
    const id = "00000000-0000-4000-8000-000000000001";
    db.query("INSERT INTO projects VALUES(?)").run(id);
    db.query("INSERT INTO environments VALUES(?,'dev')").run(id);
    db.exec("INSERT INTO members VALUES('owner@example.test','owner')");
    const catalog = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => db.query(sql).get(...args),
        }),
      }),
    } as unknown as D1Database;
    expect(
      await dashboardAllowed(catalog, id + "/dev", "owner@example.test"),
    ).toBe(true);
    expect(
      await dashboardAllowed(catalog, id + "/prod", "owner@example.test"),
    ).toBe(false);
    expect(
      await dashboardAllowed(catalog, id + "/dev", "other@example.test"),
    ).toBe(false);
    db.exec("DELETE FROM members");
    expect(
      await dashboardAllowed(catalog, id + "/dev", "owner@example.test"),
    ).toBe(false);
    db.exec("INSERT INTO members VALUES('owner@example.test','viewer')");
    expect(
      await dashboardAllowed(catalog, id + "/dev", "owner@example.test"),
    ).toBe(true);
    db.query("INSERT INTO project_deletions VALUES(?)").run(id);
    expect(
      await dashboardAllowed(catalog, id + "/dev", "owner@example.test"),
    ).toBe(false);
    db.close();
  });
  it("validates bounded identity leases", () => {
    expect(
      dashboardIdentity({
        email: "Owner@example.test",
        expires: Date.now() + 10000,
      }).email,
    ).toBe("owner@example.test");
    for (const expires of [0, Date.now() + 3600000, Infinity])
      expect(() =>
        dashboardIdentity({ email: "owner@example.test", expires }),
      ).toThrow();
  });
  it("coalesces hints, resyncs readiness and clears all timers on revocation/disposal", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { origin: "https://dash.example.com" },
    });
    const sockets: any[] = [],
      changes: number[] = [],
      states: string[] = [];
    const factory = (url: string) => {
      const s = { url, close() {} } as any;
      sockets.push(s);
      return s;
    };
    const stop = connectDashboardLive(
      "projects/id/dev",
      () => changes.push(1),
      (s) => states.push(s),
      factory,
    );
    try {
      expect(sockets).toHaveLength(1);
      expect(sockets[0].url).toBe(
        "wss://dash.example.com/api/projects/id/dev/live",
      );
      sockets[0].onmessage({ data: '{"type":"ready"}' });
      for (let i = 0; i < 20; i++)
        sockets[0].onmessage({ data: '{"type":"invalidate"}' });
      await Bun.sleep(230);
      expect(changes).toHaveLength(1);
      expect(states).toContain("connected");
      sockets[0].onmessage({ data: '{"type":"invalidate"}' });
      sockets[0].onclose({ code: 1008, reason: "Revoked" });
      await Bun.sleep(230);
      expect(changes).toHaveLength(1);
      expect(states.at(-1)).toBe("revoked");
    } finally {
      stop();
      if (original) Object.defineProperty(globalThis, "location", original);
      else delete (globalThis as any).location;
    }
  });
});
