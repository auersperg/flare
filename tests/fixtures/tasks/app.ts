import { z } from "zod";
import { eq } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { defineApp, query, live, mutation, action } from "@flared/sdk/server";
const tasks = sqliteTable("tasks", {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: integer().notNull(),
});
const input = z.object({ limit: z.number().int().min(1).max(100).default(50) });
const output = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    done: z.boolean(),
    createdAt: z.number(),
  }),
);
const list = ({ db }: any, args: any) =>
  db
    .select()
    .from(tasks)
    .orderBy(tasks.createdAt, tasks.id)
    .limit(args.limit)
    .all();
export default defineApp({
  tables: { tasks },
  functions: {
    tasks: {
      list: query({ input, output, handler: list }),
      watch: live({ input, output, handler: list }),
      create: mutation({
        input: z.object({ title: z.string().trim().min(1).max(200) }),
        output: z.string(),
        handler: ({ db }, a) => {
          const id = crypto.randomUUID();
          db.insert(tasks)
            .values({ id, title: a.title, createdAt: Date.now(), done: false })
            .run();
          return id;
        },
      }),
      toggle: mutation({
        input: z.object({ id: z.string().uuid(), done: z.boolean() }),
        output: z.boolean(),
        handler: ({ db }, a) => {
          db.update(tasks)
            .set({ done: a.done })
            .where(eq(tasks.id, a.id))
            .run();
          return a.done;
        },
      }),
      remove: mutation({
        input: z.object({ id: z.string().uuid() }),
        output: z.boolean(),
        handler: ({ db }, a) => {
          db.delete(tasks).where(eq(tasks.id, a.id)).run();
          return true;
        },
      }),
      echo: action({
        input: z.object({ message: z.string().max(200) }),
        output: z.string(),
        handler: (_ctx, a) => a.message,
      }),
    },
  },
});
