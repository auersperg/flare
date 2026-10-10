import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("artifacts", { recursive: true });
for (const version of [1, 2, 3]) {
  const result = await build({
    entryPoints: ["tests/kernel/kernel-facet.ts"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    external: ["cloudflare:workers"],
    define: { RELEASE: String(version) },
    metafile: true,
  });
  await writeFile(
    `artifacts/kernel-v${version}.js`,
    result.outputFiles[0].contents,
  );
}
await build({
  entryPoints: ["tests/kernel/kernel.ts"],
  bundle: true,
  outfile: "artifacts/kernel.js",
  format: "esm",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  metafile: true,
}).then(async (result) => {
  const inputs = Object.keys(result.metafile.inputs);
  if (
    inputs.some((path) => /modelcontextprotocol|agents\/dist\/mcp\//.test(path))
  )
    throw new Error("MCP entered kernel bundle");
  await writeFile(
    "artifacts/kernel-metafile.json",
    JSON.stringify(result.metafile, null, 2),
  );
  console.log(`Kernel built, ${inputs.length} input modules, no MCP`);
});
