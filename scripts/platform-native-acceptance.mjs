import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { loadPlatformRelease } from "../packages/flare/src/cli/platform-release.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";
import { workerConfiguration } from "../packages/flare/src/cli/platform.mjs";

const source = await loadPlatformRelease(
  resolve("packages/flare/dist/platform"),
);
await mkdir("artifacts", { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "flare-platform-native-"));
const payloadDirectory = join(scratch, "payload");
for (const file of [...source.manifest.files, { path: "manifest.json" }]) {
  const path = join(payloadDirectory, file.path);
  await mkdir(join(path, ".."), { recursive: true });
  await cp(join(source.directory, file.path), path);
}
const release = await loadPlatformRelease(payloadDirectory);
const persistence = join(scratch, "storage");
const state = newInstallation({
  account: "a".repeat(32),
  name: "native",
  owner: "owner@example.test",
  subdomain: "local",
});
state.resources.catalog.id = randomUUID();
state.access = {
  id: randomUUID(),
  aud: "b".repeat(64),
  issuer: "https://team.cloudflareaccess.com",
};
const config = {};
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
for (const key of [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "FLARE_DEPLOY_TOKEN",
])
  delete env[key];
const run = (args) => {
  const result = spawnSync(
    "node",
    ["node_modules/wrangler/bin/wrangler.js", ...args],
    { env, encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
let server,
  log = "";
try {
  for (const role of ["runtime", "admin"]) {
    const value = workerConfiguration(state, release, role);
    delete value.account_id;
    value.vars = {
      ...value.vars,
      DEV_SIGNING_KEY: "native-only-ephemeral-key-not-a-cloud-credential",
    };
    config[role] = join(scratch, `${role}.json`);
    await writeFile(config[role], JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    run([
      "deploy",
      "--dry-run",
      "--no-bundle",
      "--config",
      config[role],
      "--outdir",
      join(scratch, `${role}-dry-run`),
    ]);
  }
  run([
    "d1",
    "migrations",
    "apply",
    state.resources.catalog.name,
    "--local",
    "--config",
    config.admin,
    "--persist-to",
    persistence,
  ]);
  const seed = join(scratch, "seed.sql");
  await writeFile(
    seed,
    `INSERT INTO flare_installation(singleton,installation_id,state) VALUES(1,'${state.id}','{}');\nINSERT INTO members(email,role) VALUES('${state.owner}','owner');\n`,
  );
  run([
    "d1",
    "execute",
    state.resources.catalog.name,
    "--local",
    "--config",
    config.admin,
    "--persist-to",
    persistence,
    "--file",
    seed,
  ]);
  server = spawn(
    "node",
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      config.runtime,
      "--config",
      config.admin,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--persist-to",
      persistence,
      "--show-interactive-dev-session=false",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (chunk) => {
    log += chunk;
  });
  server.stderr.on("data", (chunk) => {
    log += chunk;
  });
  let base;
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = log.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      base = match[1];
      break;
    }
    if (server.exitCode !== null)
      throw Error("Native platform exited: " + log.slice(-4000));
    await sleep(200);
  }
  assert.ok(base, "Native platform never became ready: " + log.slice(-4000));
  const response = await fetch(base + "/health?ready=1");
  const health = await response.json();
  assert.equal(response.status, 200, JSON.stringify(health) + log.slice(-3000));
  assert.equal(health.version, release.manifest.version);
  assert.equal(health.installationId, state.id);
  assert.equal(health.platformPayload, release.manifest.digest);
  assert.equal(health.readiness, "control-plane-ready");
  assert.equal(health.runtimeAbi, 4);
  // Break the catalogue identity: the same public health probe must fail closed.
  await writeFile(seed, "DELETE FROM flare_installation;");
  // D1 local files are shared by the running workerd; execute uses that same isolated persistence directory.
  run([
    "d1",
    "execute",
    state.resources.catalog.name,
    "--local",
    "--config",
    config.admin,
    "--persist-to",
    persistence,
    "--file",
    seed,
  ]);
  const unready = await fetch(base + "/health?ready=1");
  assert.equal(unready.status, 503);
  assert.equal((await unready.json()).status, "not-ready");
  await writeFile(
    "artifacts/platform-native-acceptance.json",
    JSON.stringify(
      {
        status: "PASS",
        runtime: "local-workerd",
        cloud: "NOT_TESTED",
        version: release.manifest.version,
        checks: [
          "Admin and Runtime production bundles pass Wrangler dry-run",
          "D1 migrations run on isolated native SQLite",
          "Runtime → Admin readiness → Runtime RPC works with real service bindings",
          "Missing catalogue identity fails readiness closed",
        ],
        note: "No cloud resources or operator credentials changed; not independent Cloudflare install/upgrade acceptance.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS: native platform payload/configurations, D1 and mutual Admin/Runtime service readiness",
  );
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise((done) => server.once("exit", done));
    server.kill("SIGTERM");
    await Promise.race([stopped, sleep(5000)]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await stopped;
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
