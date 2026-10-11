import { z } from "zod";
import {
  action,
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "../../packages/flared/src/sdk/server.js";
const schema = defineSchema({
  counter: defineTable(z.object({ value: z.number() })),
});
const { query, mutation } = createFunctions<typeof schema>();
const get = query({
  auth: "public",
  input: z.object({}),
  output: z.number(),
  handler: async ({ db }) => (await db.query("counter").first())?.value ?? 0,
});
const increment = mutation({
  auth: "public",
  input: z.object({
    failOutput: z.boolean().default(false),
    fail: z.boolean().default(false),
    job: z.boolean().default(false),
  }),
  output: z.number(),
  handler: async ({ db, jobs }, args) => {
    const row = await db.query("counter").first();
    const value = (row?.value ?? 0) + 1;
    if (row) await db.patch("counter", row._id, { value });
    else await db.insert("counter", { value });
    if (args.job) await jobs.schedule("send", { value: 1 });
    await Promise.resolve();
    if (args.fail) throw Error("SDK_ROLLBACK_SENTINEL");
    return args.failOutput ? ("invalid" as any) : value;
  },
});
export const app = defineApp({
  schema,
  functions: {
    get,
    increment,
    privateGet: query({
      input: z.object({}),
      output: z.number(),
      handler: async ({ db }) =>
        (await db.query("counter").first())?.value ?? 0,
    }),
    badQuery: query({
      auth: "public",
      input: z.object({}),
      output: z.number(),
      handler: ({ db }) => {
        if ("insert" in db || "sql" in db) throw Error("WRITE_CAPABILITY_LEAK");
        throw Error("READ_ONLY_CAPABILITY");
      },
    }),
    send: action({
      auth: "public",
      input: z.object({ value: z.number() }),
      output: z.number(),
      handler: (_ctx, args) => args.value,
    }),
  },
});
export default app;
