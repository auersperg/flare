import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { database } from "../packages/flared/src/sdk/database.js";
import {
  defineSchema,
  defineTable,
  applySchema,
  schemaContract,
} from "../packages/flared/src/sdk/schema.js";

const schema = defineSchema({
  tasks: defineTable(
    z.object({
      title: z.string().min(1),
      done: z.boolean(),
      score: z.number().nullable(),
      meta: z.object({ tags: z.array(z.string()) }).optional(),
    }),
  )
    .index("by_done", ["done"])
    .index("by_score", ["score"]),
  notes: defineTable(z.object({ title: z.string() })).index("by_title", [
    "title",
  ]),
});
async function setup() {
  const sqlite = new Database(":memory:");
  const statements: string[] = [];
  const sql = {
    exec(text: string, ...bindings: any[]) {
      statements.push(text);
      const q = sqlite.query(text);
      const rows = q.columnNames.length
        ? q.all(...bindings)
        : (q.run(...bindings), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw Error("Expected one row");
          return rows[0];
        },
      };
    },
  } as unknown as SqlStorage;
  const storage = {
    sql,
    async transaction(fn: () => Promise<any>) {
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    sync: async () => {},
  } as unknown as DurableObjectStorage;
  await applySchema(storage, schema);
  return { sqlite, sql, storage, statements };
}
const value = (title: string, score: number | null = 1) => ({
  title,
  done: false,
  score,
});
describe("native SQLite document capability", () => {
  it("validates nested documents, booleans and immutable system fields", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      const id = await c.db.insert("tasks", {
        ...value("one"),
        meta: { tags: ["a"] },
      });
      await c.db.patch("tasks", id, { done: true });
      const doc = await c.db.get("tasks", id);
      expect(doc).toMatchObject({
        _id: id,
        title: "one",
        done: true,
        meta: { tags: ["a"] },
      });
      expect(doc!._creationTime).toBeGreaterThan(0);
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it.each([
    { title: "", done: false, score: 1 },
    { title: "x", done: "false", score: 1 },
    { title: "x", done: false, score: 1, unknown: 2 },
    { title: "x", done: false, score: 1, _id: "forged" },
    { title: "x", done: false, score: 1, meta: { tags: [1] } },
  ])("rejects invalid insert without a persisted row: %j", async (v) => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      await expect(c.db.insert("tasks", v as any)).rejects.toThrow();
      expect(s.sqlite.query("SELECT COUNT(*) n FROM tasks").get()).toEqual({
        n: 0,
      });
      c.revoke();
    } finally {
      s.sqlite.close();
    }
  });
  it("validates the complete resulting patch, not only supplied fields", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      const id = await c.db.insert("tasks", value("good"));
      await expect(c.db.patch("tasks", id, { title: "" })).rejects.toThrow();
      expect((await c.db.get("tasks", id))!.title).toBe("good");
      c.revoke();
    } finally {
      s.sqlite.close();
    }
  });
  it("read capability never exposes writes, raw SQL, storage or a session", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, false);
      expect(Object.keys(c.db)).toEqual(["get", "query"]);
      expect((c.db as any).sql).toBeUndefined();
      expect((c.db as any).insert).toBeUndefined();
      await c.finish();
      expect(() => c.db.query("tasks")).toThrow("ended");
    } finally {
      s.sqlite.close();
    }
  });
  it("revokes captured queries and mutations when an invocation finishes", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      const q = c.db.query("tasks");
      await c.finish();
      await expect(q.take(1)).rejects.toThrow();
      await expect(c.db.insert("tasks", value("late"))).rejects.toThrow();
    } finally {
      s.sqlite.close();
    }
  });
  it("tracks unawaited writes and propagates failures before commit", async () => {
    const s = await setup();
    try {
      await expect(
        s.storage.transaction(async () => {
          const c = database(s.sql, schema, true);
          void c.db.insert("tasks", value("good"));
          void c.db.insert("tasks", value(""));
          await c.finish();
        }),
      ).rejects.toThrow();
      expect(s.sqlite.query("SELECT COUNT(*) n FROM tasks").get()).toEqual({
        n: 0,
      });
    } finally {
      s.sqlite.close();
    }
  });
  it("SQL transaction rolls back documents and preserves the old schema", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      await c.db.insert("tasks", value("kept"));
      await c.finish();
      const before = s.sqlite
        .query("SELECT contract FROM _flared_schema")
        .get();
      const invalid = defineSchema({
        ...schema,
        tasks: defineTable(
          z.object({
            title: z.string(),
            done: z.boolean(),
            score: z.number().nullable(),
            required: z.string(),
          }),
        ),
      });
      await expect(applySchema(s.storage, invalid)).rejects.toThrow();
      expect(
        s.sqlite.query("SELECT contract FROM _flared_schema").get(),
      ).toEqual(before);
      expect(s.sqlite.query("SELECT COUNT(*) n FROM tasks").get()).toEqual({
        n: 1,
      });
    } finally {
      s.sqlite.close();
    }
  });
  it("changed validators with defaults normalize existing rows atomically", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      await c.db.insert("tasks", value("kept"));
      await c.finish();
      const next = defineSchema({
        ...schema,
        tasks: defineTable(
          z.object({
            title: z.string(),
            done: z.boolean(),
            score: z.number().nullable(),
            label: z.string().default("new"),
          }),
        ),
      });
      await applySchema(s.storage, next);
      const r = database(s.sql, next, false);
      expect((await r.db.query("tasks").first())!.label).toBe("new");
      await r.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("rejects automatic deletion of a nonempty table", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      await c.db.insert("tasks", value("kept"));
      await c.finish();
      await expect(
        applySchema(s.storage, defineSchema({ notes: schema.notes })),
      ).rejects.toThrow("nonempty");
    } finally {
      s.sqlite.close();
    }
  });
  it("index filtering uses native expression indexes, not JavaScript collection filtering", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      for (let i = 0; i < 5; i++)
        await c.db.insert("tasks", { ...value("t" + i), done: i % 2 === 0 });
      const rows = await c.db
        .query("tasks")
        .withIndex("by_done", (q) => q.eq("done", true))
        .take(100);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.done)).toBe(true);
      const query = [...s.statements]
        .reverse()
        .find((x) => x.startsWith("SELECT *,") && x.includes("WHERE"));
      const plan = s.sqlite.query("EXPLAIN QUERY PLAN " + query).all(1, 101);
      expect(JSON.stringify(plan)).toContain("idx_5_tasks_by_done");
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it.each(["asc", "desc"] as const)(
    "keyset pagination handles ties, NULLs and ranges (%s)",
    async (direction) => {
      const s = await setup();
      try {
        const c = database(s.sql, schema, true);
        for (const score of [null, null, -1, 1, 1, 3])
          await c.db.insert("tasks", value("t", score));
        const q = c.db.query("tasks").withIndex("by_score").order(direction);
        let cursor: string | null = null;
        const all: any[] = [];
        do {
          const p = await q.paginate({ limit: 2, cursor });
          all.push(...p.page);
          cursor = p.continueCursor;
        } while (cursor);
        expect(all).toHaveLength(6);
        expect(new Set(all.map((r) => r._id)).size).toBe(6);
        expect(all.map((r) => r.score)).toEqual(
          direction === "asc"
            ? [null, null, -1, 1, 1, 3]
            : [3, 1, 1, -1, null, null],
        );
        const ranged = await c.db
          .query("tasks")
          .withIndex("by_score", (q) => q.gte("score", 1).lt("score", 3))
          .take(100);
        expect(ranged).toHaveLength(2);
        await c.finish();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it("UTF-8 cursor round-trips and cannot switch query/index/order", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      for (const title of ["你好", "你好", "🦊"])
        await c.db.insert("notes", { title });
      const q = c.db.query("notes").withIndex("by_title");
      const p = await q.paginate({ limit: 1 });
      expect(p.continueCursor).not.toBeNull();
      expect(
        (await q.paginate({ limit: 2, cursor: p.continueCursor })).page,
      ).toHaveLength(2);
      await expect(
        q.order("desc").paginate({ limit: 1, cursor: p.continueCursor }),
      ).rejects.toThrow();
      c.revoke();
    } finally {
      s.sqlite.close();
    }
  });
  it.each([0, -1, 101, 1.5])(
    "rejects unbounded/invalid page %s",
    async (limit) => {
      const s = await setup();
      try {
        const c = database(s.sql, schema, false);
        await expect(c.db.query("tasks").take(limit)).rejects.toThrow();
        c.revoke();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it("unknown table/index identifiers and forged IDs cannot reach SQL", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      expect(() => c.db.query("tasks; DROP TABLE tasks" as any)).toThrow();
      expect(() => c.db.query("tasks").withIndex("missing" as any)).toThrow();
      await expect(c.db.get("tasks", "invalid")).rejects.toThrow();
      c.revoke();
    } finally {
      s.sqlite.close();
    }
  });
  it("validates declared indexes and hides reserved fields at declaration time", () => {
    expect(() =>
      schemaContract({ bad: defineTable(z.object({ _id: z.string() })) }),
    ).toThrow();
    expect(() =>
      defineSchema({
        bad: defineTable(z.object({ meta: z.object({ x: z.string() }) })).index(
          "by_meta",
          ["meta"],
        ),
      }),
    ).toThrow();
  });
  it("rejects SQLite case-insensitive table collisions", () => {
    expect(() =>
      defineSchema({ tasks: schema.tasks, Tasks: schema.tasks }),
    ).toThrow("case-insensitive");
  });
  it("prevents a captured index range from mutating a constructed query", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, false);
      let range: any;
      const query = c.db.query("tasks").withIndex("by_done", (q) => {
        range = q;
        return q.eq("done", true);
      });
      expect(() => range.eq("done", false)).toThrow();
      expect(await query.take(1)).toEqual([]);
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("tracks changed tables separately from reads", async () => {
    const s = await setup();
    try {
      const read = new Set<string>(),
        changed = new Set<string>();
      const c = database(s.sql, schema, true, read, changed);
      await c.db.query("notes").take(1);
      await c.db.insert("tasks", value("write"));
      expect([...read].sort()).toEqual(["notes", "tasks"]);
      expect([...changed]).toEqual(["tasks"]);
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("system and user indexes cannot collide, including across underscore-containing table names", async () => {
    const s = await setup();
    try {
      await applySchema(
        s.storage,
        defineSchema({
          a: defineTable(z.object({ x: z.string() }))
            .index("b_c", ["x"])
            .index("creation", ["x"]),
          a_b: defineTable(z.object({ x: z.string() })).index("c", ["x"]),
        }),
      );
      const names = s.sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
        )
        .all();
      expect(new Set(names.map((n: any) => n.name)).size).toBe(5);
    } finally {
      s.sqlite.close();
    }
  });
  it("paginates large documents by byte budget without dropping rows", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      for (let i = 0; i < 10; i++)
        await c.db.insert("tasks", value(String(i) + "x".repeat(60000)));
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const result = await c.db
          .query("tasks")
          .paginate({ limit: 100, cursor });
        expect(
          new TextEncoder().encode(JSON.stringify(result.page)).length,
        ).toBeLessThanOrEqual(262144);
        for (const doc of result.page) seen.add(doc._id);
        cursor = result.continueCursor;
      } while (cursor);
      expect(seen.size).toBe(10);
      await c.finish();
      const read = database(s.sql, schema, false);
      await expect(read.db.query("tasks").take(100)).rejects.toThrow(
        "paginate",
      );
      read.revoke();
    } finally {
      s.sqlite.close();
    }
  });
  it("drains writes spawned while another tracked write is validating", async () => {
    const s = await setup();
    try {
      const base = z.object({
        title: z.string(),
        done: z.boolean(),
        score: z.number().nullable(),
      });
      let capability: any;
      const validator = {
        "~standard": {
          ...base["~standard"],
          validate: async (input: any) => {
            if (input.title === "first") {
              await Promise.resolve();
              void capability.db.insert("tasks", value("second"));
            }
            if (input.title === "second") await Bun.sleep(10);
            return base["~standard"].validate(input);
          },
        },
      };
      const nested = defineSchema({
        ...schema,
        tasks: defineTable(validator as any),
      });
      await s.storage.transaction(async () => {
        capability = database(s.sql, nested, true);
        void capability.db.insert("tasks", value("first"));
        await capability.finish();
      });
      expect(s.sqlite.query("SELECT COUNT(*) n FROM tasks").get()).toEqual({
        n: 2,
      });
    } finally {
      s.sqlite.close();
    }
  });
});
