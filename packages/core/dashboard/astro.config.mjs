import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  output: "static",
  outDir: "../dist/dashboard",
  integrations: [react()],
  // Keep the React virtual-module consumer and Astro's cookie major inside the prerender bundle.
  vite: {
    plugins: [tailwindcss()],
    environments: {
      prerender: { resolve: { noExternal: ["@astrojs/react", "cookie"] } },
    },
  },
  build: { inlineStylesheets: "never" },
  markdown: { syntaxHighlight: false },
  security: { csp: true },
});
