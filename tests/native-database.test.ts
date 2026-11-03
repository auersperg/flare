import { Database } from "bun:sqlite";
import { describe, it, expect, jest } from "bun:test";
import { z } from "zod";
import { database } from "../packages/flare/src/sdk/database.js";
import {
  defineSchema,
  defineTable,
  applySchema,
  schemaContract,
} from "../packages/flare/src/sdk/schema.js";

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
  const calls: { text: string; bindings: any[] }[] = [];
  const sql = {
    exec(text: string, ...bindings: any[]) {
      statements.push(text);
      calls.push({ text, bindings });
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
  return { sqlite, sql, storage, statements, calls };
}
const value = (title: string, score: number | null = 1) => ({
  title,
  done: false,
  score,
});
describe("native SQLite document capability", () => {
  it("writes normalized canonical JSON directly for insert, patch and replace", async () => {
    const s = await setup();
    try {
      const normalized = defineSchema({
        notes: defineTable(
          z.object({
            title: z.string().trim(),
            done: z.boolean().default(false),
          }),
        ),
      });
      await applySchema(s.storage, normalized);
      const c = database(s.sql, normalized, true);
      const id = await c.db.insert("notes", { title: "  first  " });
      const stored = () =>
        s.sqlite.query("SELECT _data FROM notes WHERE _id=?").get(id);
      expect(stored()).toEqual({ _data: '{"done":false,"title":"first"}' });
      await c.db.patch("notes", id, { title: "  patched  " });
      expect(stored()).toEqual({ _data: '{"done":false,"title":"patched"}' });
      await c.db.replace("notes", id, { title: " replaced ", done: true });
      expect(stored()).toEqual({ _data: '{"done":true,"title":"replaced"}' });
      expect(await c.db.get("notes", id)).toMatchObject({
        title: "replaced",
        done: true,
      });
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("rejects oversized normalized output before writing to SQLite", async () => {
    const s = await setup();
    try {
      const large = defineSchema({
        notes: defineTable(
          z.object({
            title: z.string().default("x".repeat(65537)),
          }),
        ),
      });
      await applySchema(s.storage, large);
      const c = database(s.sql, large, true);
      await expect(c.db.insert("notes", {})).rejects.toMatchObject({
        code: "TOO_LARGE",
      });
      expect(s.sqlite.query("SELECT count(*) n FROM notes").get()).toEqual({
        n: 0,
      });
      c.revoke();
    } finally {
      s.sqlite.close();
    }
  });
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
  it.each(["patch", "replace", "delete"] as const)(
    "respects a concurrent %s while patch validation is pending",
    async (operation) => {
      const s = await setup();
      try {
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => (release = resolve));
        const base = schema.tasks.validator;
        const concurrent = defineSchema({
          ...schema,
          tasks: defineTable({
            "~standard": {
              ...base["~standard"],
              validate: async (input: unknown) => {
                if ((input as { title?: string }).title === "renamed")
                  await waiting;
                return base["~standard"].validate(input);
              },
            },
          }),
        });
        const c = database(s.sql, concurrent, true);
        const id = await c.db.insert("tasks", value("original"));
        const patches = Promise.all([
          c.db.patch("tasks", id, { title: "renamed" }),
          (operation === "patch"
            ? c.db.patch("tasks", id, { done: true })
            : operation === "replace"
              ? c.db.replace("tasks", id, {
                  ...value("replacement", 2),
                  done: true,
                })
              : c.db.delete("tasks", id)
          ).then(release),
        ]);
        if (operation === "delete") {
          await expect(patches).rejects.toMatchObject({ code: "NOT_FOUND" });
          expect(await c.db.get("tasks", id)).toBeNull();
          await expect(c.finish()).rejects.toMatchObject({ code: "NOT_FOUND" });
        } else {
          await patches;
          expect(await c.db.get("tasks", id)).toMatchObject({
            title: "renamed",
            done: true,
            score: operation === "replace" ? 2 : 1,
          });
          await c.finish();
        }
      } finally {
        s.sqlite.close();
      }
    },
  );
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
        .find((x) => x.startsWith("SELECT *") && x.includes("WHERE"));
      const plan = s.sqlite.query("EXPLAIN QUERY PLAN " + query).all(1, 100);
      expect(JSON.stringify(plan)).toContain("idx_5_tasks_by_done");
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("first and take read only requested rows without cursor projections", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      for (let i = 0; i < 3; i++) await c.db.insert("tasks", value(String(i)));
      const query = c.db.query("tasks").withIndex("by_score");
      const exec = jest.spyOn(s.sql, "exec");
      expect(await query.first()).not.toBeNull();
      expect(exec.mock.calls[0].at(-1)).toBe(1);
      expect(exec.mock.calls[0][0]).not.toContain("__k");
      expect(
        (exec.mock.results[0].value as ReturnType<typeof s.sql.exec>).toArray(),
      ).toHaveLength(1);
      exec.mockClear();
      expect(await query.take(2)).toHaveLength(2);
      expect(exec.mock.calls[0].at(-1)).toBe(2);
      expect(
        (exec.mock.results[0].value as ReturnType<typeof s.sql.exec>).toArray(),
      ).toHaveLength(2);
      exec.mockRestore();
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it("first and take do not require a cursor for long indexed values", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      const title = "x".repeat(8000);
      await c.db.insert("notes", { title });
      await c.db.insert("notes", { title });
      const q = c.db.query("notes").withIndex("by_title");
      expect((await q.first())?.title).toBe(title);
      expect(await q.take(1)).toHaveLength(1);
      await c.finish();
    } finally {
      s.sqlite.close();
    }
  });
  it.each([
    ["asc", false],
    ["desc", false],
    ["asc", true],
    ["desc", true],
  ] as const)(
    "seeks past tied timestamps without scanning or sorting (%s, fixed=%s)",
    async (direction, fixed) => {
      const s = await setup();
      try {
        const ids = Array.from(
          { length: 30 },
          (_, i) => "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
        );
        const insert = s.sqlite.query("INSERT INTO notes VALUES (?,?,?)");
        ids.forEach((id, i) =>
          insert.run(id, Math.floor(i / 3), '{"title":"same"}'),
        );
        const c = database(s.sql, schema, false);
        const base = c.db.query("notes");
        const q = (
          fixed
            ? base.withIndex("by_title", (r) => r.eq("title", "same"))
            : base
        ).order(direction);
        const first = await q.paginate({ limit: 4 });
        expect(first.continueCursor).not.toBeNull();
        // Cursors contain values, not a dependency on the last row still existing.
        s.sqlite
          .query("DELETE FROM notes WHERE _id=?")
          .run(first.page.at(-1)!._id);
        let cursor = first.continueCursor;
        const seen = first.page.map((d) => d._id);
        do {
          const page = await q.paginate({ limit: 4, cursor });
          const call = s.calls.at(-1)!;
          const plan = JSON.stringify(
            s.sqlite
              .query("EXPLAIN QUERY PLAN " + call.text)
              .all(...call.bindings),
          );
          expect(plan).toContain("SEARCH notes USING INDEX");
          expect(plan).not.toContain("TEMP B-TREE");
          seen.push(...page.page.map((d) => d._id));
          cursor = page.continueCursor;
        } while (cursor);
        expect(seen).toEqual(direction === "asc" ? ids : [...ids].reverse());
        await c.finish();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it.each(["asc", "desc"] as const)(
    "preserves nullable compound-index order after a fixed prefix (%s)",
    async (direction) => {
      const s = await setup();
      try {
        const compound = defineSchema({
          ...schema,
          tasks: schema.tasks.index("by_done_score", ["done", "score"]),
        });
        await applySchema(s.storage, compound);
        const c = database(s.sql, compound, true);
        for (let i = 0; i < 24; i++)
          await c.db.insert("tasks", {
            ...value(String(i), [null, -1, 1, 1, 3, 3][i % 6]),
            done: i % 2 === 0,
          });
        for (const mode of ["all", "range", "null"] as const) {
          const q = c.db
            .query("tasks")
            .withIndex("by_done_score", (r) => {
              const fixed = r.eq("done", true);
              return mode === "range"
                ? fixed.gte("score", 1).lt("score", 3)
                : mode === "null"
                  ? fixed.eq("score", null)
                  : fixed;
            })
            .order(direction);
          const expected = s.sqlite
            .query(
              `SELECT _id FROM tasks WHERE json_extract(_data,'$.done') IS 1 ${mode === "range" ? "AND json_extract(_data,'$.score') >= 1 AND json_extract(_data,'$.score') < 3" : mode === "null" ? "AND json_extract(_data,'$.score') IS NULL" : ""} ORDER BY json_extract(_data,'$.score') ${direction},_creationTime ${direction},_id ${direction}`,
            )
            .all()
            .map((r: any) => r._id);
          let cursor: string | null = null;
          const seen: string[] = [];
          do {
            const p = await q.paginate({ limit: 2, cursor });
            seen.push(...p.page.map((d) => d._id));
            cursor = p.continueCursor;
          } while (cursor);
          expect(seen).toEqual(expected);
        }
        await c.finish();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it.each(["asc", "desc"] as const)(
    "matches native ordering across four nullable mixed-type index fields (%s)",
    async (direction) => {
      const s = await setup();
      try {
        const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
        const mixed = defineSchema({
          records: defineTable(
            z.object({ a: scalar, b: scalar, c: scalar, d: scalar }),
          ).index("by_keys", ["a", "b", "c", "d"]),
        });
        await applySchema(s.storage, mixed);
        const values = [null, false, true, -2, 3, "é"];
        const insert = s.sqlite.query("INSERT INTO records VALUES(?,?,?)");
        for (let i = 0; i < 144; i++)
          insert.run(
            "00000000-0000-4000-8000-" + String(i).padStart(12, "0"),
            Math.floor(i / 3),
            JSON.stringify({
              a: values[Math.floor(i / 24)],
              b: values[Math.floor(i / 4) % 6],
              c: values[i % 4],
              d: values[(i * 7) % 6],
            }),
          );
        const order = ["a", "b", "c", "d"]
          .map((f) => `json_extract(_data,'$.${f}') ${direction}`)
          .concat([`_creationTime ${direction}`, `_id ${direction}`])
          .join(",");
        const expected = s.sqlite
          .query("SELECT _id FROM records ORDER BY " + order)
          .all()
          .map((r: any) => r._id);
        for (const limit of [1, 7, 31, 100]) {
          const c = database(s.sql, mixed, false);
          const q = c.db.query("records").withIndex("by_keys").order(direction);
          const seen: string[] = [];
          let cursor: string | null = null;
          do {
            const before = s.calls.length;
            const page = await q.paginate({ limit, cursor });
            expect(s.calls.length - before).toBeLessThanOrEqual(9);
            expect(page.page.length).toBeLessThanOrEqual(limit);
            seen.push(...page.page.map((d) => d._id));
            cursor = page.continueCursor;
            expect(seen.length).toBeLessThanOrEqual(expected.length);
          } while (cursor);
          expect(seen).toEqual(expected);
          await c.finish();
        }
      } finally {
        s.sqlite.close();
      }
    },
  );
  it.each(["asc", "desc"] as const)(
    "retains every range filter when a cursor is forged (%s)",
    async (direction) => {
      const s = await setup();
      try {
        const c = database(s.sql, schema, true);
        for (const score of [-5, null, 0, 1, 2, 5, 6])
          await c.db.insert("tasks", value("t", score));
        const q = c.db
          .query("tasks")
          .withIndex("by_score", (r) => r.gte("score", 1).lt("score", 3))
          .order(direction);
        const first = await q.paginate({ limit: 1 });
        const token = JSON.parse(atob(first.continueCursor!));
        token.values[0] = direction === "asc" ? -100 : 100;
        const page = await q.paginate({
          limit: 100,
          cursor: btoa(JSON.stringify(token)),
        });
        expect(page.page.map((d) => d.score)).toEqual(
          direction === "asc" ? [1, 2] : [2, 1],
        );
        expect(page.isDone).toBe(true);
        await c.finish();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it.each(["asc", "desc"] as const)(
    "uses bounded indexed ranges without temporary sorting (%s)",
    async (direction) => {
      const s = await setup();
      try {
        const c = database(s.sql, schema, true);
        for (let score = 0; score < 20; score++)
          await c.db.insert("tasks", value(String(score), score));
        const q = c.db
          .query("tasks")
          .withIndex("by_score", (r) => r.gte("score", 0))
          .order(direction);
        const first = await q.paginate({ limit: 1 });
        const start = s.calls.length;
        expect(
          (
            await q.paginate({ limit: 3, cursor: first.continueCursor })
          ).page.map((d) => d.score),
        ).toEqual(direction === "asc" ? [1, 2, 3] : [18, 17, 16]);
        const calls = s.calls.slice(start);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
          const plan = JSON.stringify(
            s.sqlite
              .query("EXPLAIN QUERY PLAN " + call.text)
              .all(...call.bindings),
          );
          expect(plan).toContain("SEARCH tasks USING INDEX");
          expect(plan).not.toContain("SCAN");
          expect(plan).not.toContain("TEMP B-TREE");
        }
        await c.finish();
      } finally {
        s.sqlite.close();
      }
    },
  );
  it("rejects malformed cursor system fields and values outside the fixed range", async () => {
    const s = await setup();
    try {
      const c = database(s.sql, schema, true);
      await c.db.insert("notes", { title: "same" });
      await c.db.insert("notes", { title: "same" });
      const q = c.db
        .query("notes")
        .withIndex("by_title", (r) => r.eq("title", "same"));
      const first = await q.paginate({ limit: 1 });
      const token = JSON.parse(atob(first.continueCursor!));
      const invalid = [
        null,
        { ...token, values: ["same", null, token.values[2]] },
        { ...token, values: ["same", token.values[1], null] },
        { ...token, values: ["other", ...token.values.slice(1)] },
      ];
      const before = s.calls.length;
      for (const value of invalid)
        await expect(
          q.paginate({ limit: 1, cursor: btoa(JSON.stringify(value)) }),
        ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
      expect(s.calls.length).toBe(before);
      c.revoke();
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
