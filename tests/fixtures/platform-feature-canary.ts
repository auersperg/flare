import { z } from "zod";
import {
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "@auersperg/flare/server";
import canary from "./platform-canary.js";
const schema = defineSchema({
  tasks: defineTable(canary.schema.tasks.validator).index("by_title", [
    "title",
  ]),
  notes: canary.schema.tasks,
});
const { action, query, mutation } = createFunctions<typeof schema>();
export default defineApp({
  schema,
  functions: {
    ...canary.functions,
    checks: {
      writeBoth: mutation({
        auth: "public",
        input: z.object({ fail: z.boolean(), empty: z.boolean() }),
        output: z.null(),
        handler: async ({ db }, { fail, empty }) => {
          if (!empty) {
            await db.insert("tasks", { title: "atomic task" });
            await db.insert("notes", { title: "atomic note" });
          }
          if (fail) throw Error("Intentional fixture rollback");
          return null;
        },
      }),
      notes: query({
        auth: "public",
        input: z.object({}),
        output: canary.functions.tasks.list.output,
        handler: ({ db }) => db.query("notes").take(100),
      }),
      page: query({
        auth: "public",
        input: z.object({
          direction: z.enum(["asc", "desc"]),
          indexed: z.boolean().default(false),
          cursor: z.string().nullable(),
        }),
        output: z.object({
          page: z.array(
            z.object({
              _id: z.string(),
              _creationTime: z.number(),
              title: z.string(),
            }),
          ),
          continueCursor: z.string().nullable(),
          isDone: z.boolean(),
        }),
        handler: ({ db }, { direction, cursor, indexed }) => {
          const q = db.query("tasks");
          return (
            indexed ? q.withIndex("by_title", (r) => r.gte("title", "")) : q
          )
            .order(direction)
            .paginate({ limit: 1, cursor });
        },
      }),
      secret: action({
        auth: "public",
        input: z.object({}),
        output: z.boolean(),
        handler: async ({ secrets }) =>
          (await secrets.get("TEST")) ===
          "flare-fixture-only-not-a-real-credential",
      }),
      outbound: action({
        auth: "public",
        input: z.object({}),
        output: z.boolean(),
        handler: async () => {
          const r = await fetch("https://example.com", { redirect: "manual" });
          await r.body?.cancel();
          return r.ok;
        },
      }),
    },
  },
});
