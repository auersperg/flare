import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(
        new URL("./packages/core/dashboard/src", import.meta.url),
      ),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
