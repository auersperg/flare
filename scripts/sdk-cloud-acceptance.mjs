import { bundle } from "../packages/cli/lib/bundle.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
await mkdir("artifacts", { recursive: true });
const base = process.env.FLARED_KERNEL_URL;
const local = process.argv.includes("--local");
if (
  !base ||
  (local
    ? !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)
    : !base.startsWith("https://"))
)
  throw new Error("Provide FLARED_KERNEL_URL for the private kernel");
const token = (await readFile(".private/kernel-token", "utf8")).trim();
const scope = `sdk-${crypto.randomUUID().slice(0, 8)}/dev`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const report = {
  runtime: local ? "local-workerd" : "cloud",
  scope,
  tests: [],
  startedAt: new Date().toISOString(),
};
const result = await bundle({
  entrypoints: ["tests/fixtures/sdk-facet.ts"],
  format: "esm",
  target: "browser",
  external: ["cloudflare:workers"],
});
const upload = await fetch(`${base}/bundle?scope=${scope}`, {
  method: "PUT",
  headers,
  body: await result.outputs[0].text(),
});
assert.equal(upload.status, 200);
const artifact = await upload.json();
async function request(body) {
  const response = await fetch(`${base}/?scope=${scope}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, ...data };
}
async function invoke(path, kind, args = {}, auth = null) {
  return request({ op: "sdk", call: { path, kind, args, auth } });
}
async function test(name, fn) {
  try {
    await fn();
    report.tests.push({ name, status: "PASS" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    report.tests.push({ name, status: "FAIL", message: String(error) });
    throw error;
  }
}
try {
  await test("SDK facet initializes with native SQLite document schema", async () => {
    assert.equal(
      (await request({ op: "release", ...artifact, version: 1 })).status,
      200,
    );
    assert.equal((await invoke("get", "query")).result, 0);
  });
  await test("Mutation input validation occurs before SQL", async () => {
    assert.equal(
      (await invoke("increment", "mutation", { fail: "wrong" })).status,
      500,
    );
    assert.equal((await invoke("get", "query")).result, 0);
  });
  await test("Successful mutation commits durable revision", async () => {
    const value = await invoke("increment", "mutation");
    assert.equal(value.result, 1);
    assert.equal(value.revision, 1);
  });
  await test("Async handler error rolls back SQL and scheduled outbox", async () => {
    assert.equal(
      (await invoke("increment", "mutation", { fail: true, job: true })).status,
      500,
    );
    assert.equal((await invoke("get", "query")).result, 1);
    assert.equal((await request({ op: "sdkPending" })).length, undefined);
    const response = await fetch(`${base}/?scope=${scope}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "sdkPending" }),
    });
    assert.deepEqual(await response.json(), []);
  });
  await test("Invalid output rolls back SQL and revision", async () => {
    assert.equal(
      (await invoke("increment", "mutation", { failOutput: true })).status,
      500,
    );
    const value = await invoke("get", "query");
    assert.equal(value.result, 1);
    assert.equal(value.revision, 1);
  });
  await test("Data RPC rejects actions and wrong function kinds", async () => {
    assert.equal((await invoke("send", "action", { value: 1 })).status, 500);
    assert.equal((await invoke("increment", "query")).status, 500);
  });
  await test("Required/expired identity cannot read protected functions", async () => {
    assert.equal((await invoke("privateGet", "query")).status, 500);
    assert.equal(
      (
        await invoke(
          "privateGet",
          "query",
          {},
          { subject: "test", issuer: "test", expiresAt: 0, claims: {} },
        )
      ).status,
      500,
    );
  });
  await test("Verified parent identity reaches protected function", async () => {
    assert.equal(
      (
        await invoke(
          "privateGet",
          "query",
          {},
          {
            subject: "test",
            issuer: "test",
            expiresAt: Date.now() + 60000,
            claims: {},
          },
        )
      ).result,
      1,
    );
  });
  await test("Read-only capability forbids writes through the public native data API", async () => {
    assert.equal((await invoke("badQuery", "query")).status, 500);
    assert.equal((await invoke("get", "query")).result, 1);
    assert.equal((await invoke("increment", "mutation")).result, 2);
  });
  await test("Outbox records release and auth in same commit", async () => {
    assert.equal(
      (await invoke("increment", "mutation", { job: true })).result,
      3,
    );
    const response = await fetch(`${base}/?scope=${scope}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "sdkPending" }),
    });
    const jobs = await response.json();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].release, artifact.hash);
    assert.equal(jobs[0].path, "send");
  });
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  process.exitCode = 1;
  console.error(String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    `artifacts/sdk-${local ? "local" : "cloud"}-acceptance.json`,
    JSON.stringify(report, null, 2),
  );
}
