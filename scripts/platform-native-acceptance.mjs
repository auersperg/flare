import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { loadPlatformRelease } from "../packages/flare/src/cli/platform-release.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";
import { buildApplication } from "../packages/flare/src/cli/build.mjs";
import {
  prepareFeatureProof,
  connectProofSocket,
  waitProof,
} from "./lib/platform-feature-proof.mjs";
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
const project = randomUUID(),
  email = "native-viewer@example.test";
state.config = {
  capabilities: {
    [project + "/dev"]: { outbound: [], secrets: { TEST: "APP_SECRET_TEST" } },
  },
  secrets: [
    {
      binding: "APP_SECRET_TEST",
      store_id: "a".repeat(32),
      secret_name: "flare-fixture",
    },
  ],
};
const proof = await prepareFeatureProof({
  state,
  release,
  scratch,
  project,
  email,
});
const proofConfig = JSON.parse(await readFile(proof.config, "utf8"));
delete proofConfig.account_id;
proofConfig.vars = { KEY: proof.key };
await writeFile(proof.config, JSON.stringify(proofConfig));
const sockets = [];
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
    "secrets-store",
    "secret",
    "create",
    "a".repeat(32),
    "--name",
    "flare-fixture",
    "--scopes",
    "workers",
    "--value",
    "flare-fixture-only-not-a-real-credential",
    "--config",
    config.runtime,
    "--persist-to",
    persistence,
  ]);
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
    `INSERT INTO flare_installation(singleton,installation_id,state) VALUES(1,'${state.id}','{}');\nINSERT INTO members(email,role) VALUES('${state.owner}','owner'),('${email}','viewer');\nINSERT INTO customers VALUES('${project}','Native fixture',0); INSERT INTO projects VALUES('${project}','${project}','Native fixture',0); INSERT INTO environments VALUES('${project}','dev','[]',NULL),('${project}','prod','[]',NULL);\n`,
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
      proof.config,
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
      base = match[1] + "/runtime";
      break;
    }
    if (server.exitCode !== null)
      throw Error("Native platform exited: " + log.slice(-4000));
    await sleep(200);
  }
  assert.ok(base, "Native platform never became ready: " + log.slice(-4000));
  const response = await fetch(base + "/health?ready=1", {
    headers: { authorization: "Bearer " + proof.key },
  });
  assert.equal(
    response.status,
    200,
    (await response.clone().text()) + log.slice(-3000),
  );
  const health = await response.json();
  assert.equal(response.status, 200, JSON.stringify(health) + log.slice(-3000));
  assert.equal(health.version, release.manifest.version);
  assert.equal(health.installationId, state.id);
  assert.equal(health.platformPayload, release.manifest.digest);
  assert.equal(health.readiness, "control-plane-ready");
  assert.equal(health.runtimeAbi, 4);
  const proofBase = base.replace(/\/runtime$/, "");
  const command = async (op, input = {}, which = "dev") => {
    const r = await fetch(proofBase + "/command?env=" + which, {
      method: "POST",
      headers: {
        authorization: "Bearer " + proof.key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op, input }),
    });
    const result = await r.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const bundleDir = join(scratch, "feature-app");
  await buildApplication({
    entry: "tests/fixtures/platform-feature-canary.ts",
    outdir: bundleDir,
  });
  const bundle = {};
  for (const part of ["release", "manifest", "schema", "facet", "action"]) {
    const text = await readFile(
      join(
        bundleDir,
        part + (["facet", "action"].includes(part) ? ".js" : ".json"),
      ),
      "utf8",
    );
    bundle[part] = ["facet", "action"].includes(part) ? text : JSON.parse(text);
  }
  for (const which of ["dev", "prod"]) {
    await command("configure", {}, which);
    await command("deploy", bundle, which);
  }
  const live = connectProofSocket(
    proofBase.replace("http:", "ws:") + "/live",
    proof.key,
  );
  sockets.push(live.ws);
  await waitProof(() => live.frames.some((f) => f.type === "ready"));
  const before = live.frames.filter((f) => f.type === "invalidate").length;
  const mutation = await fetch(base + "/p/" + project + "/dev/v1/call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + proof.key,
    },
    body: JSON.stringify({
      path: "tasks/create",
      kind: "mutation",
      args: { title: "native push" },
    }),
  });
  assert.equal(mutation.status, 200, await mutation.clone().text());
  await waitProof(
    () => live.frames.filter((f) => f.type === "invalidate").length > before,
  );
  const action = async (which) => {
    const r = await fetch(base + "/p/" + project + "/" + which + "/v1/call", {
      method: "POST",
      headers: {
        authorization: "Bearer " + proof.key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "checks/secret", kind: "action", args: {} }),
    });
    return { status: r.status, data: await r.json() };
  };
  const granted = await action("dev");
  assert.equal(granted.status, 200, JSON.stringify(granted));
  assert.equal(granted.data.result, true);
  const denied = await action("prod");
  assert.notEqual(denied.status, 200);
  assert.equal(denied.data.error, "SECRET_NOT_FOUND");
  console.log(
    "PASS: real local Secrets Store binding reaches only its explicitly granted dynamic Action scope",
  );
  const backup = await command("backup-create", { id: randomUUID() });
  const inventory = await command("backup-list");
  assert.equal(inventory.latest.id, backup.id);
  assert.equal(inventory.recoveryPoint, "within-24h");
  await writeFile(seed, `DELETE FROM members WHERE email='${email}';`);
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
  await command("auth-configure", { enabled: true, registration: false });
  await waitProof(() => !!live.closed);
  assert.equal(live.closed.code, 1008);
  assert.equal(live.closed.reason, "Revoked");
  console.log(
    "PASS: physical Dashboard → service fetch → hibernating Supervisor invalidation, real D1 membership revocation and backup freshness",
  );
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
  const unready = await fetch(base + "/health?ready=1", {
    headers: { authorization: "Bearer " + proof.key },
  });
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
          "Physical service-fetch WebSocket receives mutation invalidation",
          "Native Secrets Store binding is available only to the granted Action scope",
          "Real D1 membership revocation closes the channel without another data hint",
          "Legacy-compatible backup inventory reports a verified completed recovery point",
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
  for (const socket of sockets) socket.close();
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
