import ts from "typescript";
// Local-only native container/RPC proof. Never reads a real Codex login.
import { mkdtemp, writeFile, rm, readFile, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const root = resolve(import.meta.dirname, "..");
const dir = await mkdtemp(join(root, ".private-codex-proof-"));
const scope = "00000000-0000-4000-8000-000000000001/dev";
const key = crypto.randomUUID();
const proofName = "flare-codex-local-" + crypto.randomUUID().slice(0, 8);
let worker;
try {
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "fixture-seed",
      refresh_token: "fixture-refresh",
      id_token: "fixture-id",
    },
  });
  await cp(join(root, "packages/codex/run.mjs"), join(dir, "run.mjs"));
  await cp(
    join(root, "tests/fixtures/codex-process.mjs"),
    join(dir, "codex-process.mjs"),
  );
  const docker = await readFile(
    join(root, "packages/codex/Dockerfile"),
    "utf8",
  );
  await writeFile(
    join(dir, "Dockerfile"),
    docker +
      "\nCOPY codex-process.mjs /opt/flare/codex-process.mjs\nRUN chmod +x /opt/flare/codex-process.mjs && ln -sf /opt/flare/codex-process.mjs /usr/local/bin/codex\n",
  );
  await writeFile(
    join(dir, "worker.ts"),
    `
import { CodexSession, CodexService, Outbound } from ${JSON.stringify(join(root, "packages/codex/src/index.ts"))};
import { codexCommand } from ${JSON.stringify(join(root, "packages/core/src/codex.ts"))};
export { CodexService, Outbound };
export class ProofSession extends CodexSession {
  proof() { return { running: this.ctx.container.running, rotated: JSON.parse(this.ctx.storage.kv.get("auth") || "{}").tokens?.access_token === "fixture-rotated" }; }
}
export default { async fetch(req,env,ctx) {
  if(req.headers.get("authorization")!=="Bearer "+env.KEY) return new Response(null,{status:401});
  if(new URL(req.url).pathname==="/proof") return Response.json(await env.SESSION.getByName("codex").proof());
  const {op,input,scope=env.FLARE_SCOPE}=await req.json();
  try { return Response.json(await codexCommand({APP_CAPABILITIES: JSON.stringify({[env.FLARE_SCOPE]: {codex: "APP_CODEX_PROOF"}}), APP_CODEX_PROOF: ctx.exports.CodexService}, scope, op, input)); }
  catch { return new Response("rejected",{status:409}); }
}};`,
  );
  const { config, error } = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile(join(root, "packages/codex/wrangler.jsonc"), "utf8"),
  );
  if (error) throw Error("Invalid runner configuration");
  Object.assign(config, {
    name: proofName,
    main: "worker.ts",
    vars: {
      FLARE_SCOPE: scope,
      AUTH_REVISION: "fixture",
      MCP_URL: "",
      KEY: key,
      CODEX_AUTH_JSON: auth,
    },
    exports: { ProofSession: { type: "durable-object", storage: "sqlite" } },
  });
  delete config.secrets;
  delete config.$schema;
  config.containers[0].class_name = "ProofSession";
  config.durable_objects.bindings[0].class_name = "ProofSession";
  await writeFile(join(dir, "wrangler.json"), JSON.stringify(config));
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  let log = "";
  worker = spawn(
    "node",
    [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      join(dir, "wrangler.json"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [worker.stdout, worker.stderr])
    stream.on("data", (b) => {
      log = (log + b).slice(-12000);
    });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  async function call(op, input, targetScope = scope) {
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ op, input, scope: targetScope }),
    });
    assert.equal(
      response.status,
      200,
      `RPC ${op}: ${await response.clone().text()}`,
    );
    return response.json();
  }
  const deadline = Date.now() + 180000;
  for (;;) {
    try {
      if ((await fetch(base + "/proof", { headers })).ok) break;
    } catch {}
    if (worker.exitCode !== null || Date.now() > deadline)
      throw Error("Local worker did not start\n" + log);
    await new Promise((r) => setTimeout(r, 500));
  }
  async function done(id) {
    const deadline = Date.now() + 90000;
    for (;;) {
      const task = await call("status", { id });
      if (task.state !== "running") return task;
      if (Date.now() > deadline) throw Error("Task did not finish\n" + log);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (const prompt of ["first", "restored", "fail", "wait"]) {
    const input = { id: crypto.randomUUID(), prompt };
    const admitted = await call("start", input);
    assert.equal(admitted.state, "running");
    if (prompt === "wait") await call("cancel", { id: input.id });
    const task = await done(input.id);
    assert.equal(
      task.state,
      prompt === "fail"
        ? "failed"
        : prompt === "wait"
          ? "cancelled"
          : "succeeded",
    );
    assert.deepEqual(await (await fetch(base + "/proof", { headers })).json(), {
      running: false,
      rotated: true,
    });
    assert.deepEqual(await call("start", input), task);
  }
  const forbidden = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: scope.replace("dev", "prod"),
      op: "start",
      input: { id: crypto.randomUUID(), prompt: "no" },
    }),
  });
  assert.equal(forbidden.status, 409);
  console.log(
    "Native Codex runner: RPC, scope isolation, process exit/cancel, auth rotation, cold restart, duplicate suppression and container stop passed (fixture model, no account auth).",
  );
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await new Promise((r) => {
      worker.once("exit", r);
      setTimeout(() => {
        worker.kill("SIGKILL");
        r();
      }, 10000).unref();
    });
  }
  // workerd's Docker network proxy can outlive Wrangler's local process.
  const containers = execFileSync(
    "docker",
    ["ps", "-aq", "--filter", `name=workerd-${proofName}-`],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (containers.length)
    execFileSync("docker", ["rm", "-f", ...containers], { stdio: "ignore" });
  await rm(dir, { recursive: true, force: true });
}
