import { z } from "zod";
import {
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "../../packages/sdk/src/server.js";
import { FlaredError, reference } from "../../packages/sdk/src/protocol.js";
const schema = defineSchema({
  tasks: defineTable(
    z.object({ title: z.string().min(1), done: z.boolean().default(false) }),
  ).index("by_done", ["done"]),
  notes: defineTable(z.object({ body: z.string() })),
  privateNotes: defineTable(
    z.object({ owner: z.string(), body: z.string() }),
  ).index("by_owner", ["owner"]),
});
const { query, mutation, action } = createFunctions<typeof schema>();
const empty = z.object({}),
  doc = z.object({
    _id: z.string(),
    _creationTime: z.number(),
    title: z.string(),
    done: z.boolean(),
  });
let reads = 0; // Test instrumentation only: verifies that unrelated writes do not re-execute the live handler.
const snapshot = z.object({ rows: z.array(doc), reads: z.number() });
export default defineApp({
  schema,
  functions: {
    tasks: {
      list: query({
        auth: "public",
        input: empty,
        output: z.array(doc),
        handler: ({ db }) => db.query("tasks").take(100),
      }),
      snapshot: query({
        auth: "public",
        input: empty,
        output: snapshot,
        handler: async ({ db }) => ({
          rows: await db.query("tasks").take(100),
          reads: ++reads,
        }),
      }),
      create: mutation({
        auth: "public",
        input: z.object({ title: z.string().min(1) }),
        output: z.string(),
        handler: ({ db }, args) => db.insert("tasks", args),
      }),
      rollback: mutation({
        auth: "public",
        input: empty,
        output: z.boolean(),
        handler: async ({ db, jobs }) => {
          await db.insert("tasks", { title: "ROLLBACK" });
          void jobs.schedule("jobs/add", { title: "MUST_NOT_RUN" });
          throw Error("EXPECTED_ROLLBACK");
        },
      }),
      job: mutation({
        auth: "public",
        input: z.object({ title: z.string() }),
        output: z.string(),
        handler: ({ jobs }, args) => jobs.schedule("jobs/add", args),
      }),
      batch: mutation({
        auth: "public",
        input: z.object({ count: z.number().int().min(1).max(25) }),
        output: z.array(z.string()),
        handler: async ({ jobs }, args) => {
          const ids: string[] = [];
          for (let i = 0; i < args.count; i++)
            ids.push(await jobs.schedule("jobs/add", { title: `Batch ${i}` }));
          return ids;
        },
      }),
      delay: mutation({
        auth: "public",
        input: z.object({ title: z.string() }),
        output: z.string(),
        handler: ({ jobs }, args) =>
          jobs.schedule("jobs/add", args, { delaySeconds: 600 }),
      }),
      cancel: mutation({
        auth: "public",
        input: z.object({ id: z.string() }),
        output: z.boolean(),
        handler: ({ jobs }, args) => jobs.cancel(args.id),
      }),
      badJob: mutation({
        auth: "public",
        input: empty,
        output: z.boolean(),
        handler: ({ jobs }) => {
          void jobs.schedule("jobs/add", { title: 1 });
          return true;
        },
      }),
    },
    privateNotes: {
      list: query({
        auth: "required",
        input: empty,
        output: z.array(
          z.object({
            _id: z.string(),
            _creationTime: z.number(),
            owner: z.string(),
            body: z.string(),
          }),
        ),
        handler: ({ db, auth }) =>
          db
            .query("privateNotes")
            .withIndex("by_owner", (q) => q.eq("owner", auth!.subject))
            .take(100),
      }),
      add: mutation({
        auth: "required",
        input: z.object({ body: z.string() }),
        output: z.string(),
        handler: ({ db, auth }, args) =>
          db.insert("privateNotes", { ...args, owner: auth!.subject }),
      }),
      edit: mutation({
        auth: "required",
        input: z.object({ id: z.string(), body: z.string() }),
        output: z.boolean(),
        handler: async ({ db, auth }, args) => {
          const row = await db.get("privateNotes", args.id);
          if (!row || row.owner !== auth!.subject)
            throw new FlaredError("FORBIDDEN", "FORBIDDEN");
          await db.patch("privateNotes", args.id, { body: args.body });
          return true;
        },
      }),
    },
    notes: {
      add: mutation({
        auth: "public",
        input: z.object({ body: z.string() }),
        output: z.string(),
        handler: ({ db }, args) => db.insert("notes", args),
      }),
    },
    jobs: {
      objectQuery: query({
        auth: "public",
        input: empty,
        output: z.object({
          count: z.number(),
          nested: z.object({ ok: z.boolean() }),
        }),
        handler: () => ({ count: 1, nested: { ok: true } }),
      }),
      objectReport: action({
        auth: "public",
        input: empty,
        output: z.object({
          stats: z.object({
            count: z.number(),
            nested: z.object({ ok: z.boolean() }),
          }),
        }),
        handler: async (ctx) => ({
          stats: await ctx.runQuery(
            reference<{}, { count: number; nested: { ok: boolean } }>(
              "jobs/objectQuery",
              "query",
            ),
            {},
          ),
        }),
      }),
      add: action({
        auth: "internal",
        input: z.object({ title: z.string() }),
        output: z.string(),
        handler: (ctx, args) =>
          ctx.runMutation(reference("tasks/create", "mutation"), args),
      }),
    },
    lab: {
      identity: query({
        auth: "required",
        input: empty,
        output: z.string(),
        handler: ({ auth }) => auth!.subject,
      }),
      privateEcho: action({
        auth: "required",
        input: empty,
        output: z.string(),
        handler: (ctx) => ctx.runQuery(reference("lab/identity", "query"), {}),
      }),
      echo: action({
        auth: "public",
        input: z.object({ message: z.string() }),
        output: z.string(),
        handler: (_ctx, args) => args.message,
      }),
    },
  },
});
