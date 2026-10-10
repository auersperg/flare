import { z } from "zod";
import { sql } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import {
  action,
  defineApp,
  mutation,
  query,
} from "../../packages/sdk/src/server.js";
export const counter = sqliteTable("sdk_counter", {
  id: integer().primaryKey(),
  value: integer().notNull(),
});
const get = query({
  auth: "public",
  input: z.object({}),
  output: z.number(),
  handler: ({ db }) => db.select().from(counter).get()?.value ?? 0,
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
    db.insert(counter).values({ id: 1, value: 0 }).onConflictDoNothing().run();
    db.update(counter)
      .set({ value: sql`${counter.value} + 1` })
      .run();
    if (args.job) await jobs.schedule("send", { value: 1 });
    await Promise.resolve();
    if (args.fail) throw new Error("SDK_ROLLBACK_SENTINEL");
    return args.failOutput
      ? ("invalid" as any)
      : db.select().from(counter).get()!.value;
  },
});
export const app = defineApp({
  tables: { counter },
  functions: {
    get,
    increment,
    privateGet: query({
      input: z.object({}),
      output: z.number(),
      handler: ({ db }) => db.select().from(counter).get()?.value ?? 0,
    }),
    // Deliberately escapes the narrowed type through Drizzle internals: native guard,
    // not just TypeScript, must reject the write. This is a trusted acceptance fixture.
    badQuery: query({
      auth: "public",
      input: z.object({}),
      output: z.number(),
      handler: ({ db }) => {
        (db.select() as any).session.client.sql.exec(
          "UPDATE sdk_counter SET value=999",
        );
        return 0;
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
