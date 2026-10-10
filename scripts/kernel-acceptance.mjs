import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes, randomUUID } from "node:crypto";

const remote = process.argv.includes("--cloud");
const base = process.env.FLARED_KERNEL_URL || "http://127.0.0.1:8799";
if (remote && (!process.env.FLARED_KERNEL_URL || !base.startsWith("https://")))
  throw new Error("Cloud test requires FLARED_KERNEL_URL=https://...");
await mkdir(".private", { recursive: true });
await mkdir("artifacts", { recursive: true });
let token;
try {
  token = (await readFile(".private/kernel-token", "utf8")).trim();
} catch {
  token = randomBytes(32).toString("hex");
  await writeFile(".private/kernel-token", token, { mode: 0o600 });
}
const stateDirectory = remote
  ? null
  : await mkdtemp(resolve(".private/kernel-state-"));
const priorDevVars = remote
  ? null
  : await readFile("tests/kernel/.dev.vars").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
const scope = `proof-${randomUUID().slice(0, 8)}/dev`;
const tests = [];
let server,
  socket,
  log = "";
const frames = [];
const socketEvents = [];
const report = {
  runtime: remote ? "cloud" : "local-workerd",
  base,
  scope,
  startedAt: new Date().toISOString(),
  cloudGate: remote
    ? "Workers Paid enabled; real deployment"
    : "NOT_TESTED in this local run",
  tests,
  socketEvents,
};

async function test(name, run) {
  const start = performance.now();
  try {
    await run();
    tests.push({
      name,
      status: "PASS",
      ms: Math.round(performance.now() - start),
    });
    console.log("PASS:", name);
  } catch (error) {
    tests.push({ name, status: "FAIL", error: String(error) });
    throw error;
  }
}
async function command(scope, body) {
  const response = await fetch(
    `${base}/call?scope=${encodeURIComponent(scope)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const value = await response.json();
  return { status: response.status, value };
}
async function call(body, target = scope) {
  const result = await command(target, body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value;
}
async function activate(version, target = scope) {
  const code = await readFile(`artifacts/kernel-v${version}.js`, "utf8");
  const response = await fetch(
    `${base}/bundle?scope=${encodeURIComponent(target)}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: code,
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const bundle = await response.json();
  return call({ op: "release", version, ...bundle }, target);
}
async function start() {
  await writeFile("tests/kernel/.dev.vars", `KERNEL_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "tests/kernel/wrangler.json",
      "--port",
      "8799",
      "--ip",
      "127.0.0.1",
      "--persist-to",
      stateDirectory,
      "--show-interactive-dev-session=false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  server = child;
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error("Local kernel exited: " + log);
    if (log.includes("Ready on ")) {
      try {
        const result = await fetch(`${base}/health`);
        if (result.ok) return;
      } catch {}
    }
    await sleep(100);
  }
  throw new Error("Local kernel startup timeout: " + log);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  server = null;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    sleep(5000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function waitFrame(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    await sleep(25);
  }
  throw new Error(
    `WebSocket frame timeout (state=${socket?.readyState}, events=${JSON.stringify(socketEvents)})`,
  );
}
try {
  if (!remote) await start();
  await test("Unauthenticated operations are denied", async () => {
    const response = await fetch(
      `${base}/call?scope=${encodeURIComponent(scope)}`,
      { method: "POST", body: JSON.stringify({ op: "snapshot" }) },
    );
    assert.equal(response.status, 401);
  });
  await test("R2 bundle hash verified; cold facet starts with isolated SQLite", async () => {
    await activate(1);
    const result = await call({ op: "snapshot" });
    assert.equal(result.value.value, 0);
    assert.equal(result.value.release, 1);
  });
  await test("Supervisor storage and facet egress are inaccessible", async () => {
    const result = await call({ op: "boundaries" });
    assert.equal(result.parentIsolated, true);
    assert.equal(result.egress.denied, true);
  });
  await test("Committed mutation increments durable revision", async () => {
    const value = await call({ op: "mutate" });
    assert.equal(value.value, 1);
    assert.equal(value.revision, 1);
  });
  await test("Asynchronous mutation failure rolls back all SQL", async () => {
    const before = await call({ op: "snapshot" });
    assert.equal(
      (await command(scope, { op: "mutate", fail: true, job: "rollback-job" }))
        .status,
      500,
    );
    const after = await call({ op: "snapshot" });
    assert.deepEqual(after.value, before.value);
  });
  await test("Separate projects and dev/prod have independent databases", async () => {
    const other = `${scope.split("/")[0]}-other/dev`,
      prod = scope.replace("/dev", "/prod");
    await activate(1, other);
    await activate(1, prod);
    assert.equal((await call({ op: "snapshot" }, other)).value.value, 0);
    assert.equal((await call({ op: "snapshot" }, prod)).value.value, 0);
    await call({ op: "mutate" }, other);
    assert.equal((await call({ op: "snapshot" }, prod)).value.value, 0);
    assert.equal((await call({ op: "snapshot" })).value.value, 1);
  });
  await test("Cold native action RPC works without SQL bindings", async () => {
    const result = await call({ op: "action", id: "native-action" });
    assert.deepEqual(result, { id: "native-action", release: 1 });
  });
  await test("Single-use short-lived WebSocket ticket", async () => {
    const { ticket } = await call({ op: "ticket" });
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/live";
    url.searchParams.set("scope", scope);
    url.searchParams.set("ticket", ticket);
    socket = new WebSocket(url);
    socket.addEventListener("message", (event) =>
      frames.push(JSON.parse(event.data)),
    );
    socket.addEventListener("close", (event) =>
      socketEvents.push({
        type: "close",
        code: event.code,
        reason: event.reason,
        at: new Date().toISOString(),
      }),
    );
    socket.addEventListener("error", () =>
      socketEvents.push({ type: "error", at: new Date().toISOString() }),
    );
    await waitFrame((frame) => frame.type === "ready");
    const reused = new WebSocket(url);
    await new Promise((done, fail) => {
      const timeout = setTimeout(() => {
        reused.close();
        fail(new Error("Reused ticket handshake timed out"));
      }, 5000);
      reused.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          reused.close();
          fail(new Error("Reused ticket was accepted"));
        },
        { once: true },
      );
      reused.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          done();
        },
        { once: true },
      );
    });
  });
  await test("Live is delivered after commit, never for rolled-back writes", async () => {
    frames.length = 0;
    const before = (await call({ op: "snapshot" })).value.value;
    await call({ op: "mutate" });
    await waitFrame(
      (frame) => frame.type === "snapshot" && frame.value.value === before + 1,
    );
    await command(scope, { op: "mutate", fail: true });
    await sleep(500);
    assert(!frames.some((frame) => frame.value?.value > before + 1));
  });
  await test("Facet abort/code upgrade preserves SQL and parent WebSocket", async () => {
    const before = await call({ op: "snapshot" });
    await activate(2);
    const after = await call({ op: "snapshot" });
    assert.equal(after.value.value, before.value.value);
    assert.equal(after.value.label, "preserved");
    assert.equal(after.value.release, 2);
    assert.notEqual(after.value.boot, before.value.boot);
    assert.equal(after.parentBoot, before.parentBoot);
    assert.equal(socket.readyState, WebSocket.OPEN);
    frames.length = 0;
    socket.send(JSON.stringify({ type: "snapshot" }));
    await waitFrame((frame) => frame.value?.release === 2);
  });
  await test("Outbox alarm recovers a commit whose response failed", async () => {
    const before = (await call({ op: "snapshot" })).value.value;
    assert.equal(
      (
        await command(scope, {
          op: "mutate",
          job: "recovered-job",
          fault: "afterCommit",
        })
      ).status,
      503,
    );
    const deadline = Date.now() + 20000;
    let receipt;
    while (Date.now() < deadline) {
      receipt = (await call({ op: "receipts" })).find(
        (row) => row.id === "recovered-job",
      );
      if (receipt) break;
      await sleep(250);
    }
    assert(receipt, "Queued native action was not executed");
    assert.equal(receipt.release, 2);
    assert.equal((await call({ op: "snapshot" })).value.value, before + 2);
  });
  await test("Failed candidate Drizzle migration rolls back SQL and restores old release", async () => {
    const before = await call({ op: "snapshot" });
    await assert.rejects(() => activate(3));
    const after = await call({ op: "snapshot" });
    assert.equal(after.value.value, before.value.value);
    assert.equal(after.value.label, "preserved");
    assert.equal(after.value.release, 2);
  });
  await test("Native Scheduler invokes durable registered callback", async () => {
    const before = (await call({ op: "snapshot" })).value.value;
    await call({ op: "schedule", delay: 1, id: randomUUID() });
    await sleep(2200);
    assert.equal((await call({ op: "snapshot" })).value.value, before + 1);
  });
  if (remote) {
    await test("Physical cloud hibernation resumes same WebSocket with new supervisor instance", async () => {
      await sleep(4000);
      frames.length = 0;
      socket.send(JSON.stringify({ type: "snapshot" }));
      const initial = await waitFrame((frame) => frame.type === "snapshot");
      frames.length = 0;
      await sleep(100000);
      socket.send(JSON.stringify({ type: "snapshot" }));
      const resumed = await waitFrame((frame) => frame.type === "snapshot");
      assert.notEqual(resumed.boot, initial.boot);
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.equal(resumed.value.value, initial.value.value);
    });
  } else {
    socket.close();
    socket = null;
    const before = await call({ op: "snapshot" });
    await test("Local process restart preserves release, migration and SQL", async () => {
      await stop();
      log = "";
      await start();
      const after = await call({ op: "snapshot" });
      assert.equal(after.value.value, before.value.value);
      assert.equal(after.value.label, "preserved");
      assert.equal(after.value.release, 2);
      assert.notEqual(after.parentBoot, before.parentBoot);
    });
  }
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (socket) socket.close();
  await stop();
  if (!remote) {
    await rm(stateDirectory, { recursive: true, force: true });
    if (priorDevVars === null)
      await rm("tests/kernel/.dev.vars", { force: true });
    else
      await writeFile("tests/kernel/.dev.vars", priorDevVars, { mode: 0o600 });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(
    `artifacts/kernel-${remote ? "cloud" : "local"}-acceptance.json`,
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    `artifacts/kernel-${remote ? "cloud" : "local"}-${scope.replace("/", "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  if (!remote)
    await writeFile(
      "artifacts/kernel-local.log",
      log.replaceAll(token, "[REDACTED]"),
    );
}
