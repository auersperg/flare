import assert from "node:assert/strict";
import { readFile, readdir, writeFile, access, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const dashboard = "packages/core/dist/dashboard";
const html = await readFile(`${dashboard}/index.html`, "utf8");
const admin = await readFile("packages/core/dist/admin.js", "utf8");
for (const name of ["admin", "runtime"]) {
  const code = await readFile(`packages/core/dist/${name}.js`, "utf8");
  assert(
    !/\bBun\s*\.|(?:from|import)\s*["']bun(?::[^"']*)?["']/.test(code),
    `Bun runtime API entered Cloudflare ${name}`,
  );
}
for (const name of [
  "client",
  "server",
  "react",
  "protocol",
  "cloudflare",
  "schema",
  "database",
]) {
  const code = await readFile(`packages/flared/dist/sdk/${name}.js`, "utf8");
  assert(
    !/\bBun\s*\.|(?:from|import)\s*["']bun(?::[^"']*)?["']/.test(code),
    `Bun runtime API entered portable SDK ${name}`,
  );
}
const csp = html.match(
  /http-equiv="content-security-policy" content="([^"]+)"/i,
)?.[1];
assert(csp && !/unsafe-inline|unsafe-eval/.test(csp));
let inlineScripts = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (/\bsrc=/.test(match[1]) || !match[2].trim()) continue;
  const hash = `sha256-${createHash("sha256").update(match[2]).digest("base64")}`;
  assert(csp.includes(hash), "Inline bootstrap is missing its CSP hash");
  assert(
    admin.includes(hash),
    "Admin header does not match the Astro bootstrap",
  );
  inlineScripts++;
}
assert(inlineScripts > 0);
// Public variable names in setup instructions are not credential values.
const forbiddenSecrets = [];
for (const file of [".private/flared-dev-key", ".private/kernel-token"]) {
  const value = await readFile(file, "utf8").catch(() => "");
  if (value.trim()) forbiddenSecrets.push(value.trim());
}
const scripts = [];
for (const name of await readdir(`${dashboard}/_astro`)) {
  if (!name.endsWith(".js")) continue;
  const bytes = await readFile(`${dashboard}/_astro/${name}`);
  const code = bytes.toString();
  assert(
    !/DEV_SIGNING_KEY|cloudflare:workers|drizzle-orm|modelcontextprotocol/.test(
      code,
    ),
    `Backend code entered ${name}`,
  );
  for (const secret of forbiddenSecrets)
    assert(
      !bytes.toString().includes(secret),
      "Credential value entered frontend",
    );
  scripts.push({
    name,
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  });
}
assert(scripts.some((x) => x.name.startsWith("data-view.")));
assert(scripts.some((x) => x.name.startsWith("functions-view.")));
for (const name of ["platform", "src", "apps", "examples"]) {
  assert.equal(
    await access(name)
      .then(() => true)
      .catch(() => false),
    false,
    `Obsolete tree remains: ${name}`,
  );
}
const manifest = JSON.parse(
  await readFile(`${dashboard}/bootstrap/manifest.json`, "utf8"),
);
const schema = JSON.parse(
  await readFile(`${dashboard}/bootstrap/schema.json`, "utf8"),
);
assert.deepEqual(
  manifest.functions,
  {},
  "New projects must not include demo functions",
);
assert.deepEqual(schema, {}, "Bootstrap has no app tables");
assert.equal(
  await access(`${dashboard}/starter`)
    .then(() => true)
    .catch(() => false),
  false,
);
await mkdir("artifacts", { recursive: true });
const report = {
  status: "PASS",
  checkedAt: new Date().toISOString(),
  framework: {
    astro: "7.3.8",
    react: "19.3.0",
    shadcn: "4.21.4",
    preset: "bKGijeGe",
  },
  checks: [
    "Exact Astro bootstrap hashes included in strict Admin CSP",
    "Cloudflare Workers and portable SDK exclude Bun runtime APIs",
    "Frontend excludes backend bindings and platform credentials",
    "Secondary view chunks are separate",
    "Legacy root source and nested platform removed",
    "New project bootstrap has no application tables or functions",
  ],
  sizes: {
    adminGzipBytes: gzipSync(admin).length,
    allDashboardJavaScriptGzipBytes: scripts.reduce(
      (sum, x) => sum + x.gzipBytes,
      0,
    ),
    scripts,
  },
  note: "Local production build verification only; not cloud deployment or full production acceptance. Total JS includes optional lazy views, not a latency/cost benchmark.",
};
await writeFile(
  "artifacts/build-acceptance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "PASS: production build CSP, frontend boundaries and empty project bootstrap",
);
