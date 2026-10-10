import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  AliasRegistry,
  applicationRoute,
  applicationUrl,
  defaultAlias,
  projectAlias,
} from "../packages/core/src/routing.js";

const a = "443eb045-22b8-4c1e-bfee-1eaf7b01a0f9";
const b = "7770e865-8191-4e0e-8521-f103390bf0c6";
function bucket() {
  const blobs = new Map<string, string>();
  return {
    blobs,
    get: vi.fn(async (key: string) =>
      blobs.has(key) ? { text: async () => blobs.get(key)! } : null,
    ),
    put: vi.fn(async (key: string, value: string, options: any) => {
      expect(options).toEqual({ onlyIf: { etagDoesNotMatch: "*" } });
      if (blobs.has(key)) return null;
      blobs.set(key, value);
      return { etag: "created" };
    }),
  };
}
describe("Permanent project URLs", () => {
  it.each(["demo", "crm", "shop-2"])(
    "accepts a stable readable name: %s",
    (alias) => expect(projectAlias(alias)).toBe(alias),
  );
  it.each([
    "p",
    "api",
    "control",
    "health",
    "v1",
    "cdn-cgi",
    "",
    "../shop",
    "Shop",
    "2shop",
    "foo--bar",
    "a_",
    "a%2fb",
    "a-",
    "a".repeat(49),
  ])("rejects invalid/reserved name: %s", (alias) =>
    expect(() => projectAlias(alias)).toThrow(),
  );
  it("keeps the existing UUID scope and dev/prod paths", () => {
    for (const env of ["dev", "prod"])
      for (const operation of ["call", "live", "live/ticket"]) {
        expect(applicationRoute(`/p/${a}/${env}/v1/${operation}`)).toEqual({
          id: a,
          alias: null,
          env,
          operation,
        });
        expect(applicationRoute(`/demo/${env}/v1/${operation}`)).toEqual({
          id: null,
          alias: "demo",
          env,
          operation,
        });
      }
    expect(applicationUrl("https://api.auer.wien/", a, "dev", "demo")).toBe(
      "https://api.auer.wien/demo/dev",
    );
    expect(applicationUrl("https://old.example", a, "prod")).toBe(
      `https://old.example/p/${a}/prod`,
    );
  });
  it.each([
    "/demo/staging/v1/call",
    "/demo/dev/v1/call/",
    "/demo/dev/http/x",
    "/control/dev/v1/call",
    "/p/not-uuid/dev/v1/call",
    "/demo%2fother/dev/v1/call",
  ])("does not route unsupported paths: %s", (path) =>
    expect(applicationRoute(path)).toBeNull(),
  );
  it("generates a bounded name independent of display-name changes", () => {
    expect(defaultAlias("Local demo", a)).toBe("local-demo-443eb045");
    expect(defaultAlias("123 / Тест", a)).toBe("app-443eb045");
    expect(defaultAlias("x".repeat(100), a).length).toBeLessThanOrEqual(48);
  });
  it("conditionally publishes and cannot reassign a cached alias", async () => {
    const store = bucket(),
      registry = new AliasRegistry(store);
    await registry.publish("demo", a);
    await registry.publish("demo", a); // Retry of the same operation.
    await expect(registry.publish("demo", b)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await registry.resolve("demo")).toBe(a);
    expect(await new AliasRegistry(store).resolve("demo")).toBe(a);
  });
  it("deduplicates cold reads and performs no storage reads for a warm alias", async () => {
    const store = bucket();
    await new AliasRegistry(store).publish("demo", a);
    const registry = new AliasRegistry(store);
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () => registry.resolve("demo")),
      ),
    ).toEqual(Array(20).fill(a));
    await registry.resolve("demo");
    expect(store.get).toHaveBeenCalledTimes(1);
  });
  it("does not cache misses across publication", async () => {
    const store = bucket(),
      registry = new AliasRegistry(store);
    expect(await registry.resolve("demo")).toBeNull();
    await new AliasRegistry(store).publish("demo", a);
    expect(await registry.resolve("demo")).toBe(a);
  });
  it("uses a bounded least-recently-used cache", async () => {
    const store = bucket(),
      registry = new AliasRegistry(store, 2);
    for (const alias of ["one", "two", "three"])
      await new AliasRegistry(store).publish(alias, a);
    await registry.resolve("one");
    await registry.resolve("two");
    await registry.resolve("one");
    await registry.resolve("three");
    await registry.resolve("one");
    expect(store.get).toHaveBeenCalledTimes(3);
    await registry.resolve("two");
    expect(store.get).toHaveBeenCalledTimes(4);
  });
  it("fails closed on corrupted metadata or unavailable R2", async () => {
    const store = bucket();
    store.blobs.set(
      "routes/demo.json",
      JSON.stringify({ version: 1, alias: "other", projectId: a }),
    );
    await expect(
      new AliasRegistry(store).resolve("demo"),
    ).rejects.toMatchObject({ code: "INVALID_ROUTE" });
    store.get.mockRejectedValueOnce(Error("R2 unavailable"));
    await expect(new AliasRegistry(store).resolve("demo")).rejects.toThrow(
      "R2 unavailable",
    );
  });
  it("protects concurrent publication in different isolates", async () => {
    const store = bucket();
    const outcomes = await Promise.allSettled([
      new AliasRegistry(store).publish("demo", a),
      new AliasRegistry(store).publish("demo", b),
    ]);
    expect(outcomes.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
    expect(await new AliasRegistry(store).resolve("demo")).toBe(a);
  });
  it("uses an additive catalog migration with unique project and alias reservations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        readFileSync(
          new URL("../packages/core/migrations/0001.sql", import.meta.url),
          "utf8",
        ),
      );
      db.exec(
        `INSERT INTO customers VALUES ('c','Team',1); INSERT INTO projects VALUES ('${a}','c','App',1),('${b}','c','Other',1)`,
      );
      db.exec(
        readFileSync(
          new URL(
            "../packages/core/migrations/0002_project_aliases.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const insert = db.prepare(
        "INSERT INTO project_aliases (projectId,alias) VALUES (?,?) ON CONFLICT DO NOTHING",
      );
      insert.run(a, "demo");
      insert.run(b, "demo");
      insert.run(a, "new-name");
      expect(
        db
          .prepare("SELECT projectId,alias,published FROM project_aliases")
          .all(),
      ).toEqual([{ projectId: a, alias: "demo", published: 0 }]);
      expect(db.prepare("SELECT count(*) n FROM projects").get()?.n).toBe(2);
    } finally {
      db.close();
    }
  });
});
