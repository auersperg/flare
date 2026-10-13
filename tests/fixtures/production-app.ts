// Isolated production acceptance only; never compiled into platform bootstrap.
import {
  z,
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "@auersperg/flare/server";
import { FlareError, reference } from "@auersperg/flare/protocol";

const schema = defineSchema({
  owned: defineTable(
    z.object({ owner: z.string(), value: z.string(), seq: z.number().int() }),
  ).index("by_owner", ["owner"]),
  effects: defineTable(
    z.object({
      owner: z.string(),
      key: z.string(),
      attempts: z.number().int(),
      applications: z.number().int(),
    }),
  ).index("by_key", ["key"]),
});
const { query, mutation, action } = createFunctions<typeof schema>();
const empty = z.object({}),
  key = z.object({ key: z.string() }),
  jobInput = key.extend({ owner: z.string() });
const doc = z.object({
  _id: z.string(),
  _creationTime: z.number(),
  owner: z.string(),
  value: z.string(),
  seq: z.number(),
});

export default defineApp({
  schema,
  functions: {
    load: {
      seed: mutation({
        input: z.object({
          count: z.number().int().min(1).max(100),
          offset: z.number().int(),
        }),
        output: z.array(z.string()),
        handler: async ({ db, auth }, args) => {
          const ids = [];
          for (let i = 0; i < args.count; i++)
            ids.push(
              await db.insert("owned", {
                owner: auth!.subject,
                value: "recovery-" + (args.offset + i),
                seq: args.offset + i,
              }),
            );
          return ids;
        },
      }),
      identity: query({
        input: empty,
        output: z.string(),
        handler: ({ auth }) => auth!.subject,
      }),
      list: query({
        input: z.object({ limit: z.number().int().min(1).max(100) }),
        output: z.array(doc),
        handler: ({ db, auth }, args) =>
          db
            .query("owned")
            .withIndex("by_owner", (q) => q.eq("owner", auth!.subject))
            .order("desc")
            .take(args.limit),
      }),
      get: query({
        input: z.object({ ids: z.array(z.string()).max(100) }),
        output: z.array(doc),
        handler: async ({ db, auth }, args) => {
          const rows = [];
          for (const id of args.ids) {
            const row = await db.get("owned", id);
            if (!row || row.owner !== auth!.subject)
              throw new FlareError("FORBIDDEN", "FORBIDDEN");
            rows.push(row);
          }
          return rows;
        },
      }),
      write: mutation({
        input: z.object({ value: z.string().max(200), seq: z.number().int() }),
        output: z.string(),
        handler: ({ db, auth }, args) =>
          db.insert("owned", { ...args, owner: auth!.subject }),
      }),
      patch: mutation({
        input: z.object({ id: z.string(), value: z.string() }),
        output: z.boolean(),
        handler: async ({ db, auth }, args) => {
          const row = await db.get("owned", args.id);
          if (!row || row.owner !== auth!.subject)
            throw new FlareError("FORBIDDEN", "FORBIDDEN");
          await db.patch("owned", args.id, { value: args.value });
          return true;
        },
      }),
      marker: mutation({
        auth: "internal",
        input: key,
        output: z.string(),
        handler: ({ db, auth }, args) =>
          db.insert("owned", {
            owner: auth!.subject,
            value: args.key,
            seq: -2,
          }),
      }),
      busy: action({
        input: key,
        output: z.boolean(),
        handler: async (ctx, args) => {
          await ctx.runMutation(reference("load/marker", "mutation"), args);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          return true;
        },
      }),
      schedule: mutation({
        input: key,
        output: z.string(),
        handler: ({ jobs, auth }, args) =>
          jobs.schedule(
            "effects/run",
            { ...args, owner: auth!.subject },
            { delaySeconds: 5 },
          ),
      }),
    },
    effects: {
      attempt: mutation({
        auth: "internal",
        input: jobInput,
        output: z.number(),
        handler: async ({ db }, args) => {
          const row = await db
            .query("effects")
            .withIndex("by_key", (q) => q.eq("key", args.key))
            .first();
          if (!row) {
            await db.insert("effects", {
              ...args,
              owner: args.owner,
              attempts: 1,
              applications: 0,
            });
            return 1;
          }
          if (row.owner !== args.owner)
            throw new FlareError("FORBIDDEN", "FORBIDDEN");
          await db.patch("effects", row._id, { attempts: row.attempts + 1 });
          return row.attempts + 1;
        },
      }),
      apply: mutation({
        auth: "internal",
        input: jobInput,
        output: z.boolean(),
        handler: async ({ db }, args) => {
          const row = await db
            .query("effects")
            .withIndex("by_key", (q) => q.eq("key", args.key))
            .first();
          if (!row || row.owner !== args.owner)
            throw new FlareError("FORBIDDEN", "FORBIDDEN");
          if (row.applications) return false;
          await db.patch("effects", row._id, { applications: 1 });
          return true;
        },
      }),
      run: action({
        auth: "internal",
        input: jobInput,
        output: z.boolean(),
        handler: async (ctx, args) => {
          const attempt = await ctx.runMutation(
            reference<z.infer<typeof jobInput>, number>(
              "effects/attempt",
              "mutation",
            ),
            args,
          );
          if (attempt === 1)
            throw new FlareError(
              "FIXTURE_RETRY",
              "Intentional fixture failure",
            );
          return ctx.runMutation(
            reference<z.infer<typeof jobInput>, boolean>(
              "effects/apply",
              "mutation",
            ),
            args,
          );
        },
      }),
      status: query({
        input: key,
        output: z
          .object({ attempts: z.number(), applications: z.number() })
          .nullable(),
        handler: async ({ db, auth }, args) => {
          const row = await db
            .query("effects")
            .withIndex("by_key", (q) => q.eq("key", args.key))
            .first();
          if (!row) return null;
          if (row.owner !== auth!.subject)
            throw new FlareError("FORBIDDEN", "FORBIDDEN");
          return { attempts: row.attempts, applications: row.applications };
        },
      }),
    },
  },
});
