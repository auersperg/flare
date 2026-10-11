import { z } from "zod";
import {
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "flare/server";
const schema = defineSchema({
  tasks: defineTable(
    z.object({
      title: z.string().min(1).max(200),
      done: z.boolean().default(false),
    }),
  ).index("by_done", ["done"]),
});
const { query, mutation, action } = createFunctions<typeof schema>();
const input = z.object({ limit: z.number().int().min(1).max(100).default(50) });
const output = z.array(
  z.object({
    _id: z.string(),
    _creationTime: z.number(),
    title: z.string(),
    done: z.boolean(),
  }),
);
const list = ({ db }: any, args: any) => db.query("tasks").take(args.limit);
export default defineApp({
  schema,
  functions: {
    tasks: {
      list: query({ input, output, handler: list }),
      create: mutation({
        input: z.object({ title: z.string().trim().min(1).max(200) }),
        output: z.string(),
        handler: ({ db }, a) =>
          db.insert("tasks", { title: a.title, done: false }),
      }),
      toggle: mutation({
        input: z.object({ id: z.string().uuid(), done: z.boolean() }),
        output: z.boolean(),
        handler: async ({ db }, a) => {
          await db.patch("tasks", a.id, { done: a.done });
          return a.done;
        },
      }),
      remove: mutation({
        input: z.object({ id: z.string().uuid() }),
        output: z.boolean(),
        handler: async ({ db }, a) => {
          await db.delete("tasks", a.id);
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
