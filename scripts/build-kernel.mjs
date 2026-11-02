import { bundle } from "../packages/flare/src/cli/bundle.mjs";
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
  if (
    Object.keys(result.metafile.inputs).some((path) =>
      /modelcontextprotocol|agents\/dist\/mcp\//.test(path),
    )
  )
    throw new Error("MCP entered application facet bundle");
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
    // The harness imports the real Runtime HTTP server, including its native MCP route.
    // Only the application facet above must be MCP-free; legacy/client stacks remain forbidden.
    inputs.some((path) =>
      /@modelcontextprotocol\/(?:sdk|client)\/|agents\/dist\/mcp\/index\.js/.test(
        path,
      ),
    )
  )
    throw new Error("MCP client/legacy stack entered kernel harness");
  await writeFile(
    "artifacts/kernel-metafile.json",
    JSON.stringify(result.metafile, null, 2),
  );
  console.log(
    `Kernel built, ${inputs.length} input modules; MCP-free facets and server-only Runtime`,
  );
});
