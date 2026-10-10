import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { mkdir, rm, cp, writeFile } from "node:fs/promises";
import { buildApplication } from "../packages/cli/lib/build.mjs";
const out = "packages/core/dist";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const dashboard = spawnSync("npm", ["run", "build:dashboard"], {
  stdio: "inherit",
});
if (dashboard.status !== 0) throw Error("Astro dashboard build failed");
const html = await readFile(`${out}/dashboard/index.html`, "utf8");
const meta = html.match(
  /http-equiv="content-security-policy" content="([^"]+)"/i,
)?.[1];
if (!meta) throw Error("Astro did not emit a CSP");
const hashes = (directive) => [
  ...new Set(
    (
      meta.split(";").find((part) => part.trim().startsWith(directive + " ")) ??
      ""
    ).match(/'sha(?:256|384|512)-[^']+'/g) ?? [],
  ),
];
const cspHashes = {
  scripts: hashes("script-src"),
  styles: hashes("style-src"),
};
if (!cspHashes.scripts.length)
  throw Error("Astro bootstrap CSP hashes missing");
for (const role of ["runtime", "admin"]) {
  const result = await build({
    entryPoints: [`packages/core/src/${role}.ts`],
    bundle: true,
    outfile: `${out}/${role}.js`,
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
    metafile: true,
    define: { FLARED_DASHBOARD_CSP_HASHES: JSON.stringify(cspHashes) },
  });
  if (
    Object.keys(result.metafile.inputs).some((x) =>
      /modelcontextprotocol|agents\/dist\/mcp\//.test(x),
    )
  )
    throw Error("Full MCP entered platform");
  await writeFile(
    `${out}/${role}-metafile.json`,
    JSON.stringify(result.metafile, null, 2),
  );
}
await buildApplication({
  entry: "packages/core/bootstrap/app.ts",
  migrations: "packages/core/bootstrap/drizzle",
  outdir: `${out}/bootstrap`,
});
await cp(`${out}/bootstrap`, `${out}/dashboard/bootstrap`, { recursive: true });
console.log(
  "Astro/shadcn dashboard, Admin/Runtime and empty project bootstrap built",
);
