// Shared native compiler. Local tooling runs in Bun; emitted Workers never do.
export async function bundle(options) {
  const result = await Bun.build({
    format: "esm",
    target: "browser",
    env: "disable",
    metafile: true,
    ...options,
  });
  if (!result.success) throw new AggregateError(result.logs, "Build failed");
  if (!result.metafile) throw new Error("Compiler dependency graph is missing");
  return result;
}
