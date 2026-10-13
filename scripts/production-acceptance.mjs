// Explicit hook for the disposable lifecycle proof, never verify/CI/production.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { validateState } from "../packages/flare/src/cli/platform-state.mjs";

export const productionProfile = Object.freeze({
  clients: 10,
  subscriptions: 20,
  queryPerSecond: 5,
  mutationPerSecond: 1,
  durationSeconds: 600,
  p95Milliseconds: 1000,
  rpoSeconds: 86400,
  rtoSeconds: 3600,
});

export async function productionAcceptance({
  cf,
  state,
  release,
  scratch,
  run,
  configurationHome,
  packageDirectory,
  initialize,
  mode = "full",
}) {
  validateState(state, cf.account, state.name);
  assert.match(state.name, /^proof-[a-f0-9]{8}$/);
  assert.ok(["full", "recovery-only"].includes(mode));
  const report = {
    status: "RUNNING",
    mode,
    profile: productionProfile,
    tests: [],
    startedAt: new Date().toISOString(),
    faultInjection:
      "Local native workerd crash cases are separate evidence; no fault hooks in platform Workers",
    recoveryPolicy:
      "RPO 24h / RTO 1h; daily operator backup cadence, not an installed automatic timer",
  };
  const reportPath = join(scratch, "production-acceptance.json");
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  const test = async (title, fn) => {
    try {
      await fn();
    } catch (error) {
      report.tests.push({ title, status: "FAIL" });
      await save();
      throw error;
    }
    report.tests.push({ title, status: "PASS" });
    console.log("PASS: " + title);
    await save();
  };
  const sdk = await import(
    pathToFileURL(join(packageDirectory, "dist/sdk/client.js")).href
  );
  const bin = join(packageDirectory, "dist/cli/flare.js"),
    project = randomUUID(),
    customer = randomUUID(),
    deployToken = randomUUID() + randomUUID();
  const clients = [],
    stops = [];
  let helper;
  const delay = (ms) => Bun.sleep(ms);
  const wait = async (fn, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn()) return;
      await delay(150);
    }
    throw Error("Production fixture condition timed out");
  };
  const reference = (path, kind) => sdk.reference(path, kind);
  const url = (env) =>
    `https://${state.addresses.runtimeHost}/p/${project}/${env}`;
  const request = async (env, op, body) => {
    const r = await fetch(
      `https://${state.addresses.runtimeHost}/control/api/projects/${project}/${env}/${op}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + deployToken,
          "content-type": "application/json",
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify({ ...body, confirm: project }),
        redirect: "error",
        signal: AbortSignal.timeout(120000),
      },
    );
    return { status: r.status, data: await r.json() };
  };
  const management = async (env, op, body) => {
    const r = await request(env, op, body);
    assert.equal(
      r.status,
      200,
      `Fixture management ${op}: ${r.data.error ?? r.status}`,
    );
    return r.data;
  };
  try {
    await test("External compiled platform CLI: status, read-only update and confirmed no-op", async () => {
      const env = {
        CLOUDFLARE_API_TOKEN: cf.token,
        FLARE_CONFIG_HOME: configurationHome,
      };
      const args = ["--account", cf.account, "--name", state.name];
      const versions = await Promise.all(
        Object.values(state.workers).map((w) => cf.currentVersion(w.name)),
      );
      const status = JSON.parse(run([bin, "platform", "status", ...args], env));
      assert.equal(status.installed.digest, release.manifest.digest);
      assert.equal(
        JSON.parse(run([bin, "platform", "update", ...args, "--dry-run"], env))
          .unchanged,
        true,
      );
      assert.equal(
        JSON.parse(
          run(
            [bin, "platform", "update", ...args, "--confirm", cf.account],
            env,
          ),
        ).unchanged,
        true,
      );
      assert.deepEqual(
        await Promise.all(
          Object.values(state.workers).map((w) => cf.currentVersion(w.name)),
        ),
        versions,
      );
    });
    await test("Initialize only new fixture scopes and deploy through installed application CLI", async () => {
      const now = Date.now(),
        db = (q, p) => cf.sql(state.resources.catalog.id, q, p);
      await db("INSERT INTO customers VALUES (?,?,?)", [
        customer,
        "Production acceptance fixture",
        now,
      ]);
      await db("INSERT INTO projects VALUES (?,?,?,?)", [
        project,
        customer,
        "Production acceptance fixture",
        now,
      ]);
      for (const env of ["dev", "prod"])
        await db(
          "INSERT INTO environments(projectId,env,origins) VALUES(?,?,?)",
          [project, env, "[]"],
        );
      const hash = (
        await import("../packages/flare/src/cli/platform-release.mjs")
      ).sha256;
      await db("INSERT INTO credentials VALUES (?,?,?,?,0)", [
        hash(Buffer.from(deployToken)),
        project,
        state.owner,
        now + 3600000,
      ]);
      await initialize(cf, state, release, project, scratch);
      await writeFile(
        join(scratch, "production-app.ts"),
        await readFile("tests/fixtures/production-app.ts"),
      );
      const env = { FLARE_DEPLOY_TOKEN: deployToken };
      run(
        [
          bin,
          "build",
          "--entry",
          "production-app.ts",
          "--outdir",
          "production-release",
        ],
        env,
      );
      run(
        [
          bin,
          "link",
          "--platform",
          `https://${state.addresses.runtimeHost}/control`,
          "--project",
          project,
        ],
        env,
      );
      for (const which of ["dev", "prod"])
        run(
          [
            bin,
            "deploy",
            "--env",
            which,
            "--release",
            "production-release",
            "--confirm",
            project,
          ],
          env,
        );
    });
    const passwords = [randomUUID() + "!aA7", randomUUID() + "!bB7"];
    const auth = [
      sdk.createPasswordAuth({ url: url("prod") }),
      sdk.createPasswordAuth({ url: url("prod") }),
    ];
    const users = [
      await auth[0].register("production-a", passwords[0]),
      await auth[1].register("production-b", passwords[1]),
    ];
    for (let i = 0; i < productionProfile.clients; i++)
      clients.push(
        sdk.createClient({ url: url("prod"), getToken: auth[i % 2].getToken }),
      );
    const write = reference("load/write", "mutation"),
      list = reference("load/list", "query"),
      get = reference("load/get", "query");
    const records = [[], []],
      snapshots = new Map(),
      liveErrors = [];
    await test("Two-user and cross-environment ownership refusal", async () => {
      const id = await clients[0].mutation(write, {
        value: "ownership proof",
        seq: -1,
      });
      records[0].push(id);
      await assert.rejects(
        clients[1].query(get, { ids: [id] }),
        (e) => e.code === "FORBIDDEN",
      );
      await assert.rejects(
        clients[1].mutation(reference("load/patch", "mutation"), {
          id,
          value: "MUST_NOT_WRITE",
        }),
        (e) => e.code === "FORBIDDEN",
      );
      const other = sdk.createClient({
        url: url("dev"),
        getToken: auth[0].getToken,
      });
      try {
        await assert.rejects(other.query(list, { limit: 25 }), (e) =>
          ["UNAUTHORIZED", "AUTH_EXPIRED"].includes(e.code),
        );
      } finally {
        other.dispose();
      }
      assert.equal(
        (await clients[0].query(get, { ids: [id] }))[0].value,
        "ownership proof",
      );
    });
    await test("Twenty live subscriptions carry only their own identity", async () => {
      for (let i = 0; i < clients.length; i++)
        for (const limit of [25, 50]) {
          const key = i + ":" + limit;
          stops.push(
            clients[i].onUpdate(
              list,
              { limit },
              (rows) => {
                if (rows.some((row) => row.owner !== users[i % 2].id))
                  liveErrors.push("Cross-user live result");
                snapshots.set(key, rows);
              },
              (error) => liveErrors.push(error.code),
            ),
          );
        }
      await wait(() => snapshots.size === productionProfile.subscriptions);
      const health = await management("prod", "health");
      assert.equal(health.subscriptions, productionProfile.subscriptions);
      assert.equal(health.connections, productionProfile.clients);
    });
    if (mode === "recovery-only") {
      await test("Seed an equivalent bounded recovery dataset; do not claim a repeated load test", async () => {
        for (let batch = 0; batch < 6; batch++) {
          const who = batch % 2;
          records[who].push(
            ...(await clients[who].mutation(
              reference("load/seed", "mutation"),
              { count: 100, offset: batch * 100 },
            )),
          );
          await delay(1000);
        }
        report.workload = { status: "NOT_RUN", recoverySeedRecords: 600 };
      });
    } else
      await test("Declared ten-minute concurrent workload and committed-record preservation", async () => {
        const q = [],
          m = [],
          errors = [],
          pending = new Set();
        const start = performance.now();
        const spawn = (promise, samples) => {
          const at = performance.now();
          let task;
          task = promise
            .then(
              () => samples.push(performance.now() - at),
              (e) => errors.push(e.code ?? "REQUEST_FAILED"),
            )
            .finally(() => pending.delete(task));
          pending.add(task);
        };
        for (
          let tick = 0;
          tick <
          productionProfile.durationSeconds * productionProfile.queryPerSecond;
          tick++
        ) {
          await delay(Math.max(0, start + tick * 200 - performance.now()));
          assert.ok(
            pending.size < 20,
            "Workload exceeded bounded client concurrency",
          );
          spawn(clients[tick % clients.length].query(list, { limit: 50 }), q);
          if (tick % 5 === 0) {
            const seq = tick / 5,
              who = seq % 2;
            spawn(
              clients[who]
                .mutation(write, { value: "load-" + seq, seq })
                .then((id) => records[who].push(id)),
              m,
            );
          }
          if (tick && tick % 300 === 0)
            console.log(
              `Production workload ${tick / 5}s: ${q.length} queries, ${m.length} mutations`,
            );
        }
        await delay(
          Math.max(
            0,
            start +
              productionProfile.durationSeconds * 1000 -
              performance.now(),
          ),
        );
        await Promise.all([...pending]);
        const stats = (values) => {
          values.sort((a, b) => a - b);
          return {
            count: values.length,
            p95: values[Math.ceil(values.length * 0.95) - 1],
            max: values.at(-1),
          };
        };
        report.workload = {
          elapsedMilliseconds: performance.now() - start,
          query: stats(q),
          mutation: stats(m),
          unexpectedErrors: errors.length,
          liveErrors: liveErrors.length,
        };
        await save();
        assert.deepEqual(errors, []);
        assert.deepEqual(liveErrors, []);
        assert.equal(q.length, 3000);
        assert.equal(m.length, 600);
        assert.ok(
          report.workload.query.p95 < productionProfile.p95Milliseconds,
          "Query p95 threshold failed",
        );
        assert.ok(
          report.workload.mutation.p95 < productionProfile.p95Milliseconds,
          "Mutation p95 threshold failed",
        );
        for (let who = 0; who < 2; who++)
          for (let offset = 0; offset < records[who].length; offset += 100) {
            const ids = records[who].slice(offset, offset + 100),
              rows = await clients[who].query(get, { ids });
            assert.deepEqual(
              rows.map((r) => r._id),
              ids,
            );
            assert.ok(rows.every((r) => r.owner === users[who].id));
          }
        await wait(() =>
          [0, 1].every((who) =>
            [25, 50].every((limit) =>
              snapshots
                .get(who + ":" + limit)
                ?.some((r) => r._id === records[who].at(-1)),
            ),
          ),
        );
      });
    const expectedRecords = [[], []];
    for (let who = 0; who < 2; who++) {
      // The ownership refusal check commits one additional record for user A.
      assert.equal(records[who].length, 300 + (who === 0 ? 1 : 0));
      for (let offset = 0; offset < records[who].length; offset += 100) {
        expectedRecords[who].push(
          ...(await clients[who].query(get, {
            ids: records[who].slice(offset, offset + 100),
          })),
        );
      }
    }
    await test("Read-after-unknown mutation outcome does not blindly retry the write", async () => {
      let calls = 0;
      const ambiguous = sdk.createClient({
        url: url("prod"),
        getToken: auth[0].getToken,
        fetch: async (input, init) => {
          calls++;
          const r = await fetch(input, init);
          assert.ok(r.ok);
          await r.body?.cancel();
          throw Error("Injected lost response after server commit");
        },
      });
      try {
        await assert.rejects(
          ambiguous.mutation(write, { value: "ambiguous-commit", seq: -3 }),
          (e) => e.ambiguous === true,
        );
      } finally {
        ambiguous.dispose();
      }
      assert.equal(calls, 1);
      const rows = await clients[0].query(list, { limit: 25 });
      assert.equal(
        rows.filter((r) => r.value === "ambiguous-commit").length,
        1,
      );
    });
    await test("Running action blocks activation without losing admitted work", async () => {
      const key = "busy-" + randomUUID(),
        busy = clients[0].action(reference("load/busy", "action"), { key });
      let done = false;
      busy.then(
        () => (done = true),
        () => (done = true),
      );
      await wait(async () =>
        (await clients[0].query(list, { limit: 25 })).some(
          (r) => r.value === key,
        ),
      );
      assert.equal(done, false);
      const health = await management("prod", "health"),
        result = await request("prod", "release-rollback", {
          hash: health.active,
          expected: health.active,
        });
      assert.equal(result.status, 409);
      assert.equal(result.data.error, "CONFLICT");
      assert.equal(await busy, true);
    });
    await test("Reconnect resync and logout revoke live reads without mixing users", async () => {
      const first = clients[0];
      first.dispose();
      clients[0] = sdk.createClient({
        url: url("prod"),
        getToken: auth[0].getToken,
      });
      let received;
      const stop = clients[0].onUpdate(
        list,
        { limit: 25 },
        (rows) => (received = rows),
        (error) => liveErrors.push(error.code),
      );
      await wait(() => received !== undefined);
      assert.ok(received.every((r) => r.owner === users[0].id));
      stop();
      await auth[0].logout();
      await wait(() =>
        liveErrors.some((code) =>
          ["UNAUTHORIZED", "AUTH_EXPIRED"].includes(code),
        ),
      );
      await assert.rejects(first.query(list, { limit: 25 }));
      await assert.rejects(
        clients[0].query(list, { limit: 25 }),
        (e) => e.code === "UNAUTHORIZED",
      );
      assert.ok(
        (await clients[1].query(list, { limit: 25 })).every(
          (r) => r.owner === users[1].id,
        ),
      );
      for (const stop of stops.splice(0)) stop();
      for (const c of clients) c.dispose();
      await auth[0].login("production-a", passwords[0]);
      clients[0] = sdk.createClient({
        url: url("prod"),
        getToken: auth[0].getToken,
      });
    });
    const effectKey = randomUUID(),
      jobId = await clients[0].mutation(
        reference("load/schedule", "mutation"),
        { key: effectKey },
      );
    const pendingJob = (await management("prod", "jobs")).pending.find(
      (j) => j.id === jobId,
    );
    assert.ok(pendingJob, "Fixture job was not checkpointed before enqueue");
    const fileBytes = "Flare production fixture file",
      blob = new Blob([fileBytes], { type: "text/plain" });
    const grant = await management("prod", "file-upload", {
      name: "production-proof.txt",
      type: "text/plain",
      size: blob.size,
    });
    await sdk.uploadFile(grant, blob);
    const backup = randomUUID(),
      backupFile = `backups/${project}/prod/${backup}/files/${grant.id}`;
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    jwk.kid = "production-expiry";
    jwk.alg = "RS256";
    jwk.use = "sig";
    helper = {
      name: state.workers.runtime.name.replace(
        /-runtime$/,
        "-production-" + project.slice(0, 8),
      ),
      key: randomUUID() + randomUUID(),
      nonce: randomUUID(),
    };
    const source = join(scratch, "production-helper.mjs"),
      config = join(scratch, "production-helper.json"),
      secret = join(scratch, "production-helper-secrets.json");
    // All scope/job/backup addresses compiled in. No arbitrary RPC, SQL, owner identity or account credential.
    await writeFile(
      source,
      `export default {async fetch(req,env){const path=new URL(req.url).pathname;if(path==="/jwks")return Response.json({keys:[${JSON.stringify(jwk)}]});if(req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});if(req.method==="GET")return Response.json({ready:${JSON.stringify(helper.nonce)}});if(req.method!=="POST")return new Response("Method",{status:405});if(path==="/replay"){const r=await env.SUPERVISORS.getByName(${JSON.stringify(project + "/prod")}).dispatch("job",[${JSON.stringify(pendingJob)}]);return Response.json(r);}if(path==="/corrupt"||path==="/repair"){await env.BUNDLES.put(${JSON.stringify(backupFile)},path==="/repair"?${JSON.stringify(fileBytes)}:"corrupt-fixture-only");return Response.json({written:true});}return new Response("Not found",{status:404});}};`,
    );
    await writeFile(
      config,
      JSON.stringify({
        name: helper.name,
        account_id: state.account,
        main: source,
        find_additional_modules: false,
        compatibility_date: release.manifest.compatibilityDate,
        workers_dev: true,
        preview_urls: false,
        durable_objects: {
          bindings: [
            {
              name: "SUPERVISORS",
              class_name: "EnvironmentSupervisor",
              script_name: state.workers.runtime.name,
            },
          ],
        },
        r2_buckets: [
          { binding: "BUNDLES", bucket_name: state.resources.bundles.name },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(secret, JSON.stringify({ KEY: helper.key }), {
      mode: 0o600,
    });
    await cf.deploy(config, {
      tag: "production-disposable-helper",
      message: "Fixed-scope production acceptance helper",
      cwd: scratch,
      secretsFile: secret,
    });
    helper.url = `https://${helper.name}.${state.addresses.subdomain}.workers.dev`;
    await wait(async () => {
      const r = await fetch(helper.url, {
        headers: { authorization: "Bearer " + helper.key },
        signal: AbortSignal.timeout(15000),
      });
      return r.ok && (await r.json()).ready === helper.nonce;
    }, 90000);
    const helperCall = async (path) => {
      const r = await fetch(helper.url + path, {
        method: "POST",
        headers: { authorization: "Bearer " + helper.key },
        signal: AbortSignal.timeout(120000),
      });
      assert.ok(r.ok);
      return r.json();
    };
    await test("Native Queue retry and exact duplicate delivery preserve an idempotent fixture effect", async () => {
      try {
        await wait(async () => {
          const result = await clients[0].query(
            reference("effects/status", "query"),
            { key: effectKey },
          );
          return result?.applications === 1;
        }, 180000);
      } catch (error) {
        const jobs = await management("prod", "jobs");
        report.queueDiagnostic = {
          effect: await clients[0].query(reference("effects/status", "query"), {
            key: effectKey,
          }),
          events: jobs.recent.filter((row) => row.id === jobId),
          pending: jobs.pending.some((row) => row.id === jobId),
          receipt: jobs.receipts.some((row) => row.id === jobId),
        };
        throw error;
      }
      const before = await clients[0].query(
        reference("effects/status", "query"),
        { key: effectKey },
      );
      assert.ok(before.attempts >= 2);
      assert.equal(before.applications, 1);
      assert.equal((await helperCall("/replay")).ok, true);
      assert.deepEqual(
        await clients[0].query(reference("effects/status", "query"), {
          key: effectKey,
        }),
        before,
      );
      report.delivery = {
        nativeQueueRetried: true,
        duplicateReceiptPreserved: true,
        fixtureEffectApplications: 1,
        guarantee:
          "at-least-once; fixture idempotency, not generic exactly-once",
      };
    });
    await test("Real short-lived JWT expiry closes authenticated live results", async () => {
      const issuer = helper.url,
        audience = "production-" + project;
      await management("prod", "settings", {
        origins: [],
        oidc: { issuer, audience, jwks: issuer + "/jwks" },
      });
      const encode = (value) =>
          Buffer.from(JSON.stringify(value)).toString("base64url"),
        header = encode({ alg: "RS256", kid: jwk.kid }),
        payload = encode({
          iss: issuer,
          aud: audience,
          sub: "fixture-expiry",
          exp: Math.floor(Date.now() / 1000) + 10,
        });
      const signature = Buffer.from(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          pair.privateKey,
          new TextEncoder().encode(header + "." + payload),
        ),
      ).toString("base64url");
      const jwt = header + "." + payload + "." + signature,
        c = sdk.createClient({ url: url("prod"), getToken: () => jwt });
      let value, error;
      const stop = c.onUpdate(
        reference("load/identity", "query"),
        {},
        (v) => (value = v),
        (e) => (error = e.code),
      );
      try {
        await wait(() => value !== undefined);
        assert.equal(value, "fixture-expiry");
        await wait(() => error !== undefined, 25000);
        assert.ok(["AUTH_EXPIRED", "UNAUTHORIZED"].includes(error));
        await assert.rejects(c.query(reference("load/identity", "query"), {}));
      } finally {
        stop();
        c.dispose();
        await management("prod", "settings", { origins: [], oidc: null });
      }
    });
    await test("Corrupted file fences real restore; repairing that exact capsule completes recovery", async () => {
      const jobs = await management("prod", "jobs");
      assert.equal(jobs.pending.length, 0);
      assert.ok(jobs.receipts.some((r) => r.id === jobId));
      const before = await management("prod", "health"),
        started = performance.now();
      const summary = await management("prod", "backup-create", { id: backup });
      assert.equal(summary.files, 1);
      assert.equal(summary.hash, before.active);
      await helperCall("/corrupt");
      const failed = await request("dev", "backup-restore", {
        id: backup,
        sourceEnv: "prod",
      });
      assert.notEqual(failed.status, 200);
      const fenced = await management("dev", "backup-status");
      assert.equal(fenced.status, "restoring");
      assert.equal(fenced.id, backup);
      const anonymous = sdk.createClient({ url: url("dev") });
      try {
        await assert.rejects(
          anonymous.query(reference("load/list", "query"), { limit: 25 }),
          (e) => ["RESTORE_IN_PROGRESS", "UNAUTHORIZED"].includes(e.code),
        );
      } finally {
        anonymous.dispose();
      }
      await helperCall("/repair");
      const restored = await management("dev", "backup-restore", {
        id: backup,
        sourceEnv: "prod",
      });
      assert.equal(restored.status, "completed");
      const targetAuth = sdk.createPasswordAuth({ url: url("dev") });
      try {
        for (let who = 0; who < 2; who++) {
          assert.equal(
            (
              await targetAuth.login(
                ["production-a", "production-b"][who],
                passwords[who],
              )
            ).id,
            users[who].id,
          );
          const target = sdk.createClient({
            url: url("dev"),
            getToken: targetAuth.getToken,
          });
          try {
            for (let offset = 0; offset < records[who].length; offset += 100) {
              assert.deepEqual(
                await target.query(get, {
                  ids: records[who].slice(offset, offset + 100),
                }),
                expectedRecords[who].slice(offset, offset + 100),
              );
            }
          } finally {
            target.dispose();
            await targetAuth.logout();
          }
        }
      } finally {
        targetAuth.dispose();
      }
      const download = await management("dev", `file-download?id=${grant.id}`);
      assert.equal(
        await (await fetch(download.url, { redirect: "error" })).text(),
        fileBytes,
      );
      assert.equal((await management("dev", "health")).active, before.active);
      assert.equal((await management("dev", "jobs")).pending.length, 0);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < productionProfile.rtoSeconds * 1000);
      report.recovery = {
        status: "PASS",
        milliseconds: elapsed,
        rows: summary.rows,
        files: summary.files,
        userIdsPreserved: true,
        verifiedUsers: 2,
        verifiedDocuments: expectedRecords.reduce(
          (count, rows) => count + rows.length,
          0,
        ),
        corruptionFence: true,
        exactCapsuleRetry: true,
        rpo: "Daily operator backups required; this proves the selected capsule, not an automatic daily schedule",
      };
    });
    report.status = "PASS";
    return report;
  } catch (error) {
    report.status = "FAIL";
    report.error = error.code ?? error.message;
    throw error;
  } finally {
    for (const stop of stops) stop();
    for (const c of clients) c.dispose();
    if (helper) {
      try {
        if (
          (await cf.list("workers/scripts")).some((w) => w.id === helper.name)
        )
          await cf.api(`workers/scripts/${helper.name}`, undefined, "DELETE");
        report.helperRemoved = true;
      } catch {
        report.helperRemoved = false;
        report.status = "FAIL";
        throw Error(
          "Production helper cleanup failed; scoped recovery required",
        );
      }
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
}
