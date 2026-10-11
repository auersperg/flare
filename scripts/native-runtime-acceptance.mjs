import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHmac } from "node:crypto";
import { buildApplication } from "../packages/cli/lib/build.mjs";
import {
  createClient,
  reference,
  uploadFile,
  createPasswordAuth,
} from "../packages/sdk/dist/client.js";
const base = process.env.FLARED_KERNEL_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? ""))
  throw Error(
    "This proof requires the local private kernel, never a cloud endpoint",
  );
const token = (await readFile(".private/kernel-token", "utf8")).trim();
const scope = crypto.randomUUID() + "/dev",
  url = base + "/p/" + scope;
const directory = await mkdtemp(resolve(".private/native-runtime-"));
const report = {
  runtime: "local-workerd",
  scope,
  tests: [],
  startedAt: new Date().toISOString(),
};
let client, stop;
async function control(op, ...args) {
  const response = await fetch(base + "/core", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ op, args }),
  });
  assert.equal(
    response.status,
    200,
    (await response.clone().text())
      .replaceAll(token, "[REDACTED]")
      .slice(0, 512),
  );
  const result = await response.json();
  if (!result.ok) throw Error(result.code);
  return result.value;
}
async function build(entry, outdir) {
  await buildApplication({ entry, outdir });
  const json = async (file) =>
    JSON.parse(await readFile(join(outdir, file), "utf8"));
  return {
    release: await json("release.json"),
    manifest: await json("manifest.json"),
    schema: await json("schema.json"),
    facet: await readFile(join(outdir, "facet.js"), "utf8"),
    action: await readFile(join(outdir, "action.js"), "utf8"),
  };
}
async function wait(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  throw Error("Native core timed out");
}
async function test(name, fn) {
  await fn();
  report.tests.push({ name, status: "PASS" });
  console.log("PASS:", name);
}
const admin = (op, input = {}) => control("admin", scope, op, input);
const call = (path, kind, args = {}) =>
  client[kind](reference(path, kind), args);
try {
  await test("Privileged test control endpoint requires authentication", async () => {
    assert.equal(
      (
        await fetch(base + "/core", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "configure", args: [] }),
        })
      ).status,
      401,
    );
  });
  await test("Native core cold deployment and typed document schema", async () => {
    await control("configure", { scope, origins: [base], oidc: null });
    await control(
      "deploy",
      scope,
      await build("tests/fixtures/native-app.ts", join(directory, "v1")),
    );
    client = createClient({ url });
    assert.deepEqual(await call("tasks/list", "query"), []);
    assert.deepEqual(await call("jobs/objectReport", "action"), {
      stats: { count: 1, nested: { ok: true } },
    });
    const schema = await admin("schema");
    assert.deepEqual(schema.tables.find((t) => t.name === "tasks").indexes, {
      by_done: ["done"],
    });
  });
  const frames = [];
  await test("Live commits, default values and table-aware invalidation", async () => {
    stop = client.onUpdate(
      reference("tasks/snapshot", "query"),
      {},
      (v) => frames.push(v),
      (e) => {
        throw e;
      },
    );
    await wait(() => frames.length === 1);
    const state = await control("kernelState", scope);
    assert.equal(
      state.jobs.some((job) => job.fn === "expire"),
      false,
      "An anonymous subscription must not schedule periodic auth expiry",
    );
    assert.equal(
      state.alarm,
      null,
      "An idle public socket must be able to hibernate",
    );
    const id = await call("tasks/create", "mutation", { title: "Native core" });
    await wait(() => frames.at(-1).rows.some((row) => row._id === id));
    assert.equal(frames.at(-1).rows[0].done, false);
    const count = frames.length;
    await call("notes/add", "mutation", { body: "Unrelated table" });
    await Bun.sleep(300);
    assert.equal(
      frames.length,
      count,
      "An unrelated write reran the instrumented live handler",
    );
  });
  await test("Successful HTTP queries preserve bounded invocation diagnostics", async () => {
    await call("tasks/list", "query");
    const before = await admin("health");
    for (let i = 0; i < 5; i++) await call("tasks/list", "query");
    const after = await admin("health");
    assert.equal(after.bootId, before.bootId);
    const logs = await admin("logs");
    assert(logs.some((row) => row.kind === "query" && row.status === "ok"));
    assert(logs.length <= 100);
  });
  await test("Unawaited invalid jobs and failed mutations roll back atomically", async () => {
    const before = await admin("schema"),
      count = frames.length;
    await assert.rejects(call("tasks/badJob", "mutation"));
    await assert.rejects(call("tasks/rollback", "mutation"));
    assert.equal((await admin("schema")).revision, before.revision);
    assert.equal((await call("tasks/list", "query")).length, 1);
    assert.equal(frames.length, count);
    assert.equal((await admin("jobs")).pending.length, 0);
  });
  await test("Dashboard CRUD and app mutations share validators and conflict checks", async () => {
    const before = await admin("data", { table: "tasks" }),
      id = before.rows[0]._id;
    await assert.rejects(
      admin("edit", {
        table: "tasks",
        operation: "update",
        key: id,
        values: { done: "false" },
        expectedRevision: before.revision,
      }),
    );
    await admin("edit", {
      table: "tasks",
      operation: "update",
      key: id,
      values: { title: "Dashboard" },
      expectedRevision: before.revision,
    });
    await wait(() => frames.at(-1).rows[0].title === "Dashboard");
    await assert.rejects(
      admin("edit", {
        table: "tasks",
        operation: "delete",
        key: id,
        expectedRevision: before.revision,
      }),
    );
  });
  await test("Separate native action and Queues consumer execute scoped capabilities", async () => {
    assert.equal(
      await call("lab/echo", "action", { message: "native" }),
      "native",
    );
    const job = await call("tasks/job", "mutation", { title: "From Queue" });
    await wait(
      async () => (await admin("jobs")).receipts.some((row) => row.id === job),
      25000,
    );
    assert(
      (await call("tasks/list", "query")).some(
        (row) => row.title === "From Queue",
      ),
    );
    assert.equal((await admin("jobs")).pending.length, 0);
  });
  await test("Native Queue batches acknowledge every job and clear the transactional outbox", async () => {
    const ids = await call("tasks/batch", "mutation", { count: 12 });
    assert.equal(new Set(ids).size, 12);
    await wait(async () => {
      const jobs = await admin("jobs");
      return ids.every((id) => jobs.receipts.some((row) => row.id === id));
    }, 25000);
    assert.equal((await admin("jobs")).pending.length, 0);
    const rows = await call("tasks/list", "query");
    for (let i = 0; i < 12; i++)
      assert.equal(rows.filter((row) => row.title === `Batch ${i}`).length, 1);
  });
  await test("Native R2 streaming roundtrip and one-use upload grants", async () => {
    const blob = new Blob(["Native file bytes"], { type: "text/plain" });
    const grant = await admin("file-upload", {
      name: "proof.txt",
      type: "text/plain",
      size: blob.size,
    });
    await uploadFile(grant, blob);
    await assert.rejects(uploadFile(grant, blob));
    const files = await admin("files");
    assert.equal(files.page.find((f) => f.id === grant.id).state, "ready");
    const download = await admin("file-download", { id: grant.id });
    assert.equal(await (await fetch(download.url)).text(), "Native file bytes");
    await admin("file-delete", { id: grant.id });
    assert.equal((await admin("files")).page.length, 0);
  });
  await test("Delayed-job references block removal; cancellation clears only pending outbox jobs", async () => {
    const delayed = await call("tasks/delay", "mutation", { title: "Delayed" });
    const original = await readFile("tests/fixtures/native-app.ts", "utf8");
    const entry = join(directory, "removed.ts");
    await writeFile(
      entry,
      original
        .replaceAll(
          '"../../packages/',
          JSON.stringify(resolve("packages") + "/").slice(0, -1),
        )
        .replace(/jobs:\s*{/g, "removedJobs:{"),
    );
    await assert.rejects(
      control("deploy", scope, await build(entry, join(directory, "removed"))),
      /INVALID_RELEASE/,
    );
    assert.equal(await call("tasks/cancel", "mutation", { id: delayed }), true);
    assert.equal(
      await call("tasks/cancel", "mutation", { id: delayed }),
      false,
    );
    const another = await call("tasks/delay", "mutation", {
      title: "Dashboard cancel",
    });
    assert.deepEqual(await admin("job-cancel", { id: another }), {
      cancelled: true,
    });
    assert.equal((await admin("jobs")).pending.length, 0);
  });
  await test("Schema defaults activate atomically without replacing the persistent facet", async () => {
    const original = await readFile("tests/fixtures/native-app.ts", "utf8");
    const entry = join(directory, "next.ts");
    const source = original
      .replaceAll(
        '"../../packages/',
        JSON.stringify(resolve("packages") + "/").slice(0, -1),
      )
      .replace(
        /done:\s*z\.boolean\(\)\.default\(false\)/,
        "done:z.boolean().default(false),priority:z.number().default(1)",
      );
    await writeFile(entry, source);
    await control("deploy", scope, await build(entry, join(directory, "v2")));
    const data = await admin("data", { table: "tasks" });
    assert(data.rows.length >= 2);
    assert(data.rows.every((row) => row.priority === 1));
    assert.equal((await admin("health")).connections, 1);
    const invalid = source.replace(
      "priority:z.number().default(1)",
      "priority:z.number() , required:z.string()",
    );
    await writeFile(entry, invalid);
    await assert.rejects(
      control("deploy", scope, await build(entry, join(directory, "invalid"))),
    );
    assert.equal(
      (await admin("data", { table: "tasks" })).rows.length,
      data.rows.length,
    );
    assert.equal(
      await call("lab/echo", "action", { message: "still works" }),
      "still works",
    );
  });
  await test("Five successful releases, exact promote and schema-checked rollback preserve data", async () => {
    const project = crypto.randomUUID(),
      dev = project + "/dev",
      prod = project + "/prod";
    const entry = join(directory, "versions.ts");
    const baseSource = (
      await readFile("tests/fixtures/native-app.ts", "utf8")
    ).replaceAll("../../packages/sdk/src/", resolve("packages/sdk/src") + "/");
    try {
      for (const env of [dev, prod])
        await control("configure", { scope: env, origins: [], oidc: null });
      const versions = [];
      for (let n = 0; n < 6; n++) {
        await writeFile(
          entry,
          baseSource.replace("let reads = 0;", "let reads = " + n + ";"),
        );
        const bundle = await build(entry, join(directory, "release-" + n));
        versions.push(bundle);
        await control("deploy", dev, bundle);
        if (n === 0) {
          await control("deploy", prod, bundle);
          const proof = createClient({ url: base + "/p/" + dev });
          try {
            await proof.mutation(reference("tasks/create", "mutation"), {
              title: "Retained",
            });
          } finally {
            proof.dispose();
          }
        }
      }
      const op = (env, name, input = {}) => control("admin", env, name, input);
      const history = await op(dev, "history");
      assert.equal(history.length, 5);
      assert(!history.some((x) => x.hash === versions[0].release.hash));
      const before = await op(dev, "data", { table: "tasks" });
      const target = (await op(prod, "health")).active;
      await op(prod, "release-promote", {
        hash: versions[3].release.hash,
        expected: target,
      });
      assert.equal((await op(prod, "health")).active, versions[3].release.hash);
      assert.equal((await op(prod, "data", { table: "tasks" })).rows.length, 0);
      await assert.rejects(
        op(prod, "release-promote", {
          hash: versions[4].release.hash,
          expected: target,
        }),
      );
      await op(dev, "release-rollback", {
        hash: versions[2].release.hash,
        expected: versions[5].release.hash,
      });
      assert.deepEqual(
        (await op(dev, "data", { table: "tasks" })).rows,
        before.rows,
      );
      await writeFile(
        entry,
        baseSource.replace(
          "done: z.boolean().default(false)",
          "done: z.boolean().default(false), required: z.string()",
        ),
      );
      const invalid = await build(entry, join(directory, "release-invalid"));
      await assert.rejects(control("deploy", dev, invalid));
      assert(
        !(await op(dev, "history")).some(
          (x) => x.hash === invalid.release.hash,
        ),
      );
      await assert.rejects(
        op(prod, "release-promote", {
          hash: invalid.release.hash,
          expected: versions[3].release.hash,
        }),
      );
    } finally {
      await control("destroy", prod);
      await control("destroy", dev);
    }
  });
  await test("Activation journal recovers forced crashes before and after facet schema commit", async () => {
    const target = crypto.randomUUID() + "/dev";
    const entry = join(directory, "crash-release.ts");
    const source = (
      await readFile("tests/fixtures/native-app.ts", "utf8")
    ).replaceAll("../../packages/sdk/src/", resolve("packages/sdk/src") + "/");
    const proof = createClient({ url: base + "/p/" + target });
    try {
      await control("configure", { scope: target, origins: [], oidc: null });
      await writeFile(entry, source);
      await control(
        "deploy",
        target,
        await build(entry, join(directory, "crash-initial")),
      );
      const id = await proof.mutation(reference("tasks/create", "mutation"), {
        title: "Preserved through crash",
      });
      for (const afterFacet of [false, true]) {
        await writeFile(
          entry,
          source.replace(
            "let reads = 0;",
            `let reads = ${afterFacet ? 72 : 71};`,
          ),
        );
        const release = await build(
          entry,
          join(directory, "crash-" + afterFacet),
        );
        assert.equal(
          (await control("kernelCrashRelease", target, release, afterFacet))
            .crashed,
          true,
        );
        // Fresh instance follows the real native activation/recovery path, not a test repair.
        const interrupted = await control("admin", target, "health", {});
        assert.equal(interrupted.status, "activating");
        assert.equal(interrupted.candidate, release.release.hash);
        const rows = await proof.query(reference("tasks/list", "query"), {});
        assert.equal(rows.length, 1);
        assert.equal(rows[0]._id, id);
        const recovered = await control("admin", target, "health", {});
        assert.equal(recovered.active, release.release.hash);
        assert.equal(recovered.candidate, null);
        assert.equal(recovered.status, "ready");
        assert(
          (await control("admin", target, "history", {})).some(
            (x) => x.hash === release.release.hash,
          ),
        );
      }
    } finally {
      proof.dispose();
      await control("destroy", target);
    }
  });
  await test("Native password registration, context isolation and immediate live session revocation", async () => {
    const target = crypto.randomUUID() + "/dev",
      other = target.replace("/dev", "/prod");
    const url = base + "/p/" + target,
      password = "Native private acceptance passphrase 73!";
    const alice = createPasswordAuth({ url }),
      bob = createPasswordAuth({ url });
    let ca, cb, unsubscribe;
    try {
      await control("configure", {
        scope: target,
        origins: [base],
        oidc: null,
      });
      await control("configure", { scope: other, origins: [base], oidc: null });
      await control(
        "deploy",
        target,
        await build(
          "tests/fixtures/native-app.ts",
          join(directory, "password-auth"),
        ),
      );
      await control("admin", target, "auth-configure", {
        enabled: true,
        registration: true,
      });
      const a = await alice.register("alice", password),
        b = await bob.register("bob", password);
      ca = createClient({ url, getToken: alice.getToken });
      cb = createClient({ url, getToken: bob.getToken });
      assert.equal(
        await ca.query(reference("lab/identity", "query"), {}),
        a.id,
      );
      assert.equal(
        await cb.action(reference("lab/privateEcho", "action"), {}),
        b.id,
      );
      const frames = [],
        errors = [];
      unsubscribe = ca.onUpdate(
        reference("lab/identity", "query"),
        {},
        (v) => frames.push(v),
        (e) => errors.push(e.code),
      );
      await wait(() => frames.length === 1);
      assert.equal(frames[0], a.id);
      const bad = await fetch(url + "/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ login: "alice", password }),
      });
      assert.equal(bad.status, 403);
      const cross = await fetch(base + "/p/" + other + "/v1/auth/me", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + alice.getToken(),
        },
        body: "{}",
      });
      assert.equal(cross.status, 403); // Other environment has authentication disabled.
      const list = await control("admin", target, "auth-users", {});
      assert.equal(list.users.length, 2);
      assert(!JSON.stringify(list).includes("scrypt$"));
      await control("admin", target, "auth-password", {
        id: a.id,
        password: password + "reset",
      });
      await assert.rejects(ca.query(reference("lab/identity", "query"), {}));
      await wait(() => errors.length > 0); // Socket close/reconnect cannot regain the revoked identity.
      assert.equal(
        await cb.query(reference("lab/identity", "query"), {}),
        b.id,
      );
      await assert.rejects(alice.login("alice", password));
      await alice.login("alice", password + "reset");
      ca.refreshAuth();
      assert.equal(
        await ca.query(reference("lab/identity", "query"), {}),
        a.id,
      );
      await alice.logout();
      await assert.rejects(ca.query(reference("lab/identity", "query"), {}));
      await control("admin", target, "auth-disable", {
        id: b.id,
        disabled: true,
      });
      await assert.rejects(cb.query(reference("lab/identity", "query"), {}));
    } finally {
      unsubscribe?.();
      ca?.dispose();
      cb?.dispose();
      await control("destroy", other);
      await control("destroy", target);
    }
  });
  await test("Real JWT expiry stops authenticated snapshots without expiring public sockets", async () => {
    const kernel = JSON.parse(
      await readFile("tests/kernel/wrangler.json", "utf8"),
    );
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: kernel.vars.RUNTIME_URL,
        aud: scope,
        sub: "expiry-proof",
        exp: Math.floor(Date.now() / 1000) + 4,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", token)
      .update(header + "." + payload)
      .digest("base64url");
    const authenticated = createClient({
      url,
      getToken: () => `${header}.${payload}.${signature}`,
    });
    const values = [],
      errors = [];
    const unsubscribe = authenticated.onUpdate(
      reference("tasks/list", "query"),
      {},
      (value) => values.push(value),
      (error) => errors.push(error.code),
    );
    try {
      await wait(() => values.length === 1);
      assert(
        (await control("kernelState", scope)).jobs.some(
          (job) => job.fn === "expire",
        ),
      );
      await wait(() => errors.includes("AUTH_EXPIRED"), 10000);
    } finally {
      unsubscribe();
      authenticated.dispose();
    }
    await wait(async () => (await admin("health")).connections === 1);
    const id = await call("tasks/create", "mutation", {
      title: "Public socket survives JWT expiry",
    });
    await wait(() => frames.at(-1).rows.some((row) => row._id === id));
    assert.equal(
      (await control("kernelState", scope)).jobs.some(
        (job) => job.fn === "expire",
      ),
      false,
    );
  });
  await test("Logical backup restores native documents, release and R2 bytes; retry recovers a fenced failure", async () => {
    const id = crypto.randomUUID(),
      target = scope.replace("/dev", "/prod");
    await control("configure", { scope: target, origins: [base], oidc: null });
    await control(
      "deploy",
      target,
      await build(
        "tests/fixtures/native-app.ts",
        join(directory, "restore-target"),
      ),
    );
    const body = new Blob(["Backup file bytes"], { type: "text/plain" });
    const grant = await admin("file-upload", {
      name: "backup.txt",
      type: "text/plain",
      size: body.size,
    });
    await uploadFile(grant, body);
    const before = await admin("data", { table: "tasks", limit: 100 });
    const accountPassword = "Backup account private passphrase 73!";
    const account = await admin("auth-create", {
      login: "backup-user",
      password: accountPassword,
    });
    const saved = await admin("backup-create", { id });
    assert.equal(saved.files, 1);
    assert.equal((await admin("backup-create", { id })).hash, saved.hash);
    assert.equal((await admin("backup-list")).page[0].id, id);
    // Prove restoration does not depend on the live source file.
    await admin("file-delete", { id: grant.id });
    // Fault injection exists only in this authenticated test harness, never core.
    await control("backupBytes", scope, id, grant.id, "corrupted");
    const input = { id, source: scope };
    await assert.rejects(
      control("admin", target, "backup-restore", input),
      /INVALID_BACKUP/,
    );
    assert.equal(
      (await control("admin", target, "health", {})).status,
      "restoring",
    );
    const oldBoot = (await control("admin", target, "health", {})).bootId;
    await control("kernelAbort", target);
    const rebooted = await control("admin", target, "health", {});
    assert.notEqual(rebooted.bootId, oldBoot);
    assert.equal(rebooted.status, "restoring");
    const restored = createClient({ url: base + "/p/" + target });
    try {
      await assert.rejects(
        restored.query(reference("tasks/list", "query"), {}),
        (e) => e.code === "RESTORE_IN_PROGRESS",
      );
      await assert.rejects(
        control(
          "deploy",
          target,
          await build(
            "tests/fixtures/native-app.ts",
            join(directory, "fenced-deploy"),
          ),
        ),
        /RESTORE_IN_PROGRESS/,
      );
      await control("backupBytes", scope, id, grant.id, "Backup file bytes");
      await control("admin", target, "backup-restore", input);
      assert.equal(
        (await control("admin", target, "backup-restore", input)).unchanged,
        true,
      );
      assert.equal(
        (await control("admin", target, "health", {})).active,
        saved.hash,
      );
      assert.equal(
        (await control("admin", target, "auth-users", {})).users[0].id,
        account.id,
      );
      await control("admin", target, "auth-configure", {
        enabled: true,
        registration: false,
      });
      const recoveredAuth = createPasswordAuth({ url: base + "/p/" + target });
      assert.equal(
        (await recoveredAuth.login("backup-user", accountPassword)).id,
        account.id,
      );
      await recoveredAuth.logout();
      assert.deepEqual(
        (await control("admin", target, "data", { table: "tasks", limit: 100 }))
          .rows,
        before.rows,
      );
      const download = await control("admin", target, "file-download", {
        id: grant.id,
      });
      assert.equal(
        await (await fetch(download.url)).text(),
        "Backup file bytes",
      );
      await restored.mutation(reference("tasks/create", "mutation"), {
        title: "Works after restore",
      });
      await assert.rejects(
        control("admin", target, "backup-restore", {
          id: crypto.randomUUID(),
          source: scope,
        }),
        /NOT_FOUND/,
      );
    } finally {
      restored.dispose();
    }
    await admin("backup-delete", { id });
    assert.equal((await admin("backup-list")).page.length, 0);
    await control("prepareDestroy", target);
    await control("kernelAbort", target);
    await assert.rejects(control("admin", target, "health", {}), /NOT_FOUND/);
    await control("destroy", target);
    await control("kernelAbort", target);
    assert.equal((await control("destroy", target)).deleted, true);
    await assert.rejects(control("admin", target, "health", {}), /NOT_FOUND/);
    await assert.rejects(
      control("configure", { scope: target, origins: [], oidc: null }),
      /NOT_FOUND/,
    );
  });
  await test("Idle environment has no recurring alarm after live disconnect", async () => {
    stop();
    client.dispose();
    await wait(async () => {
      const state = await control("kernelState", scope);
      return state.alarm === null && state.jobs.length === 0;
    }, 20000);
  });
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  stop?.();
  client?.dispose();
  report.finishedAt = new Date().toISOString();
  await writeFile(
    "artifacts/native-runtime-local-acceptance.json",
    JSON.stringify(report, null, 2),
  );
  await rm(directory, { recursive: true, force: true });
}
