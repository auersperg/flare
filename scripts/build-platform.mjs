import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { bundle } from "../packages/flare/src/cli/bundle.mjs";
import { mkdir, rm, cp, writeFile } from "node:fs/promises";
import { buildApplication } from "../packages/flare/src/cli/build.mjs";
const out = "packages/core/dist";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const dashboard = spawnSync(process.execPath, ["run", "build:dashboard"], {
  stdio: "inherit",
});
if (dashboard.status !== 0) throw Error("Astro dashboard build failed");
await writeFile(
  `${out}/dashboard/_headers`,
  `/_astro/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff
`,
);
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
  const result = await bundle({
    entrypoints: [`packages/core/src/${role}.ts`],
    outdir: out,
    naming: { entry: `${role}.js` },
    format: "esm",
    target: "browser",
    external: ["cloudflare:workers", "node:*"],
    metafile: true,
    define: { FLARE_DASHBOARD_CSP_HASHES: JSON.stringify(cspHashes) },
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
  outdir: `${out}/bootstrap`,
});
await cp(`${out}/bootstrap`, `${out}/dashboard/bootstrap`, { recursive: true });
console.log(
  "Astro/shadcn dashboard, Admin/Runtime and empty project bootstrap built",
);
