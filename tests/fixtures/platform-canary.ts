import { z } from "zod";
import {
  defineApp,
  defineSchema,
  defineTable,
  createFunctions,
} from "@auersperg/flare/server";

// Only this disposable canary exposes anonymous CRUD. Application defaults
// remain authenticated; the cloud proof also verifies privateList is closed.
const schema = defineSchema({
  tasks: defineTable(z.object({ title: z.string().min(1).max(200) })),
});
const { query, mutation, action } = createFunctions<typeof schema>();
const input = z.object({ limit: z.number().int().min(1).max(100) });
const output = z.array(
  z.object({ _id: z.string(), _creationTime: z.number(), title: z.string() }),
);
const list = ({ db }: any, args: any) => db.query("tasks").take(args.limit);

export default defineApp({
  schema,
  functions: {
    tasks: {
      list: query({ auth: "public", input, output, handler: list }),
      privateList: query({ input, output, handler: list }),
      schedule: mutation({
        auth: "public",
        input: z.object({}),
        output: z.string(),
        handler: ({ jobs }) =>
          jobs.schedule(
            "tasks/echo",
            { message: "retain queued job" },
            { delaySeconds: 3600 },
          ),
      }),
      echo: action({
        auth: "internal",
        input: z.object({ message: z.string() }),
        output: z.string(),
        handler: (_ctx, args) => args.message,
      }),
      create: mutation({
        auth: "public",
        input: z.object({ title: z.string().min(1).max(200) }),
        output: z.string(),
        handler: ({ db }, args) => db.insert("tasks", args),
      }),
    },
  },
});
