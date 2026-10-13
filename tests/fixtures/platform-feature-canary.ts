import { z } from "zod";
import { defineApp, createFunctions } from "@auersperg/flare/server";
import canary from "./platform-canary.js";
const { action } = createFunctions<typeof canary.schema>();
export default defineApp({
  schema: canary.schema,
  functions: {
    ...canary.functions,
    checks: {
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
