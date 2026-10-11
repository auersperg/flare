import { bundle } from "../packages/cli/lib/bundle.mjs";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("artifacts", { recursive: true });
for (const version of [1, 2, 3]) {
  const result = await bundle({
    entrypoints: ["tests/kernel/kernel-facet.ts"],
    format: "esm",
    target: "browser",
    external: ["cloudflare:workers"],
    define: { RELEASE: String(version) },
    metafile: true,
  });
  await writeFile(
    `artifacts/kernel-v${version}.js`,
    new Uint8Array(await result.outputs[0].arrayBuffer()),
  );
}
await bundle({
  entrypoints: ["tests/kernel/kernel.ts"],
  outdir: "artifacts",
  naming: { entry: "kernel.js" },
  format: "esm",
  target: "browser",
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
