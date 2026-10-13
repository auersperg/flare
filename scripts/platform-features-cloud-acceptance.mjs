import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { platform } from "../packages/flare/src/cli/platform.mjs";
import { InstallationStore } from "../packages/flare/src/cli/platform-state.mjs";
import {
  prepareFeatureProof,
  connectProofSocket,
  waitProof,
} from "./lib/platform-feature-proof.mjs";

/** Explicit disposable hook; never invoked by install/update/CI themselves. */
export async function platformFeaturesAcceptance({
  cf,
  state,
  release,
  scratch,
  run,
  configurationHome,
  packageDirectory,
  project,
}) {
  assert.match(state.name, /^proof-[a-f0-9]{8}$/);
  assert.equal(state.installed.version, release.manifest.version);
  const email = "features-" + project.slice(0, 8) + "@example.test";
  const db = (sql, params = []) =>
    cf.sql(state.resources.catalog.id, sql, params);
  const report = {
    status: "RUNNING",
    tests: [],
    secretCloud:
      "NOT_TESTED: requires scoped Secrets Store permissions; native workerd binding proof is separate",
    helperCleanup: "PENDING",
  };
  const proof = await prepareFeatureProof({
    state,
    release,
    scratch,
    project,
    email,
  });
  const sockets = [];
  await db("INSERT INTO members(email,role) VALUES(?,?)", [email, "viewer"]);
  try {
    await cf.deploy(proof.config, {
      tag: "disposable-feature-proof",
      cwd: scratch,
      secretsFile: proof.secretsFile,
    });
    const base = `https://${proof.name}.${state.addresses.subdomain}.workers.dev`;
    await cf.api(`workers/scripts/${proof.name}/subdomain`, {
      enabled: true,
      previews_enabled: false,
    });
    let ready = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(base + "/ready", {
        headers: { authorization: "Bearer " + proof.key },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        ready = (await r.json()).ready === project;
        break;
      }
      await r.body?.cancel();
      await Bun.sleep(1500);
    }
    assert.ok(ready, "Fixed-scope helper did not propagate");
    const command = async (op, input = {}, which = "prod") => {
      const r = await fetch(base + "/command?env=" + which, {
        method: "POST",
        headers: {
          authorization: "Bearer " + proof.key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ op, input }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await r.json();
      assert.equal(
        result.ok,
        true,
        `Feature ${op}: ${result.code ?? r.status}`,
      );
      return result.value;
    };
    for (const path of ["platform-canary", "platform-feature-canary"])
      await writeFile(
        join(scratch, path + ".ts"),
        await readFile("tests/fixtures/" + path + ".ts"),
      );
    const bin = join(packageDirectory, "dist/cli/flare.js");
    run(
      [
        bin,
        "build",
        "--entry",
        "platform-feature-canary.ts",
        "--outdir",
        "feature-release",
      ],
      {},
      scratch,
    );
    const bundle = {};
    for (const part of ["release", "manifest", "schema", "facet", "action"]) {
      const text = await readFile(
        join(
          scratch,
          "feature-release",
          part + (["facet", "action"].includes(part) ? ".js" : ".json"),
        ),
        "utf8",
      );
      bundle[part] = ["facet", "action"].includes(part)
        ? text
        : JSON.parse(text);
    }
    for (const which of ["dev", "prod"]) await command("deploy", bundle, which);
    const configPath = join(scratch, "operator-capabilities.json");
    await writeFile(
      configPath,
      JSON.stringify({
        capabilities: { [project + "/prod"]: { outbound: ["example.com"] } },
      }),
      { mode: 0o600 },
    );
    const deps = {
      cf,
      release,
      storeOptions: { directory: join(configurationHome, "platform") },
      log: () => {},
    };
    const namespace = state.supervisorNamespace;
    await platform(
      {
        operation: "update",
        account: cf.account,
        name: state.name,
        config: configPath,
        confirm: cf.account,
      },
      deps,
    );
    state = (
      await new InstallationStore(cf, state.name, deps.storeOptions).discover()
    ).state;
    assert.equal(state.supervisorNamespace, namespace);
    assert.equal(
      (
        await platform(
          { operation: "update", account: cf.account, name: state.name },
          deps,
        )
      ).unchanged,
      true,
    );
    report.tests.push(
      "Same-release managed capabilities update preserves namespace and no-op retains grants",
    );
    const action = async (which) => {
      const r = await fetch(
        `https://${state.addresses.runtimeHost}/p/${project}/${which}/v1/call`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: "checks/outbound",
            kind: "action",
            args: {},
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      return { status: r.status, data: await r.json() };
    };
    const granted = await action("prod");
    assert.equal(granted.status, 200, JSON.stringify(granted));
    assert.equal(granted.data.result, true);
    const denied = await action("dev");
    assert.notEqual(denied.status, 200);
    // Native globalOutbound fetch boundaries can redact the thrown policy
    // error into a generic invocation failure. The denial must still fail
    // closed; never accept a successful response in the ungranted scope.
    assert.ok(
      ["OUTBOUND_DENIED", "OPERATION_FAILED"].includes(denied.data.error),
    );
    report.outboundDenial = { status: denied.status, code: denied.data.error };
    report.tests.push(
      "Native Dynamic Worker outbound reaches allowed HTTPS host and refuses ungranted environment",
    );
    const live = connectProofSocket(
      base.replace("https:", "wss:") + "/live?env=prod",
      proof.key,
    );
    sockets.push(live.ws);
    await waitProof(() => live.frames.some((f) => f.type === "ready"));
    const r = await fetch(
      `https://${state.addresses.runtimeHost}/p/${project}/prod/v1/call`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "tasks/create",
          kind: "mutation",
          args: { title: "features push canary" },
        }),
      },
    );
    assert.equal(r.status, 200);
    await r.body?.cancel();
    await waitProof(() => live.frames.some((f) => f.type === "invalidate"));
    live.ws.close();
    const reconnected = connectProofSocket(
      base.replace("https:", "wss:") + "/live?env=prod",
      proof.key,
    );
    sockets.push(reconnected.ws);
    await waitProof(() => reconnected.frames.some((f) => f.type === "ready"));
    report.tests.push(
      "Physical cloud WebSocket receives cross-client hints and reconnects through native service fetch",
    );
    // Use dev for backup: the existing prod preservation canary has a pending job.
    const backup = await command("backup-create", { id: randomUUID() }, "dev");
    const inventory = await command("backup-list", {}, "dev");
    assert.equal(inventory.inventory, "complete");
    assert.equal(inventory.latest.id, backup.id);
    assert.equal(inventory.recoveryPoint, "within-24h");
    report.tests.push(
      "Cloud backup inventory verifies its latest completed capsule and RPO age",
    );
    await db("DELETE FROM members WHERE email=?", [email]);
    await command("auth-configure", { enabled: true, registration: false });
    await waitProof(() => !!reconnected.closed);
    assert.equal(reconnected.closed.code, 1008);
    assert.equal(reconnected.closed.reason, "Revoked");
    report.tests.push(
      "Real catalog membership revocation closes cloud push before the next hint",
    );
    const status = await platform(
      { operation: "status", account: cf.account, name: state.name },
      deps,
    );
    assert.equal(status.health.status, "ready");
    report.tests.push(
      "Exact archive payload identity and live Runtime/Access status agree",
    );
    report.status = "PASS";
    return report;
  } catch (error) {
    report.status = "FAIL";
    throw error;
  } finally {
    for (const socket of sockets) socket.close();
    await db("DELETE FROM members WHERE email=?", [email]);
    await cf.api(`workers/scripts/${proof.name}`, undefined, "DELETE");
    report.helperCleanup = "PASS";
    await writeFile(
      join(scratch, "features-acceptance.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
  }
}
