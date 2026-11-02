// A bounded client of the official Codex app-server, not another agent loop.
import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  appendFile,
  rename,
  stat,
} from "node:fs/promises";
import { Redactor, secretsFrom, EVENT_BYTES } from "./events.mjs";
const dir = "/run/flare";
const input = JSON.parse(await readFile(`${dir}/input.json`, "utf8"));
const authPath = `${dir}/codex/auth.json`;
const secrets = secretsFrom(
  JSON.parse(await readFile(authPath, "utf8")),
  process.env.FLARE_MCP_TOKEN,
);
const redact = new Redactor(secrets),
  deltas = new Map();
let seq = 0,
  bytes = 0,
  truncated = false;
async function emit(event) {
  if (truncated) return;
  let line = JSON.stringify({ ...event, seq: seq + 1, at: Date.now() }) + "\n";
  if (bytes + Buffer.byteLength(line) > EVENT_BYTES - 256 || seq >= 4095) {
    truncated = true;
    line =
      JSON.stringify({ seq: seq + 1, at: Date.now(), type: "truncated" }) +
      "\n";
  }
  seq++;
  bytes += Buffer.byteLength(line);
  await appendFile(`${dir}/events.ndjson`, line, { mode: 0o600 });
}
await writeFile(`${dir}/pid`, String(process.pid), { mode: 0o600 });
await writeFile(`${dir}/events.ndjson`, "", { mode: 0o600 });
await emit({ type: "status", text: "starting" });
const args = [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  "analytics.enabled=false",
  "-c",
  "check_for_update_on_startup=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.apps=false",
];
if (input.mcpUrl)
  args.push(
    "-c",
    `mcp_servers.flare={url=${JSON.stringify(input.mcpUrl)},bearer_token_env_var="FLARE_MCP_TOKEN"}`,
  );
const child = spawn("codex", args, {
  cwd: "/workspace",
  detached: true,
  env: { ...process.env, CODEX_HOME: `${dir}/codex` },
  stdio: ["pipe", "pipe", "ignore"],
});
let reason,
  killTimer,
  completed = false,
  finalText = "",
  turnStatus;
let resolveExit;
const exited = new Promise((r) => {
  resolveExit = r;
});
function stop(value) {
  if (reason) return;
  reason = value;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 3000);
}
const timeout = setTimeout(() => stop("TIMEOUT"), input.timeoutMs);
const cancel = setInterval(async () => {
  if (await stat(`${dir}/cancel`).catch(() => null)) stop("CANCELLED");
}, 500);
let requestId = 0;
const requests = new Map();
function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    requests.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
child.stdin.on("error", () => stop("PROTOCOL_FAILED"));
child.once("error", () => {
  stop("START_FAILED");
  for (const p of requests.values()) p.reject(Error("Start failed"));
  requests.clear();
  resolveExit(-1);
});
child.once("exit", (code) => {
  for (const p of requests.values()) p.reject(Error("Exited"));
  requests.clear();
  resolveExit(code ?? -1);
});
async function event(message) {
  if (message.id !== undefined && !message.method) {
    const pending = requests.get(message.id);
    requests.delete(message.id);
    if (message.error) pending?.reject(Error("Codex request failed"));
    else pending?.resolve(message.result);
    return;
  }
  // Interactive approvals/tool requests must never silently auto-approve. This runner has no such UI.
  if (message.id !== undefined) {
    send({
      id: message.id,
      error: { code: -32601, message: "Unsupported interactive request" },
    });
    stop("INTERACTION_REQUIRED");
    return;
  }
  const p = message.params ?? {},
    item = p.item;
  const method = message.method;
  if (
    method === "item/agentMessage/delta" ||
    method === "item/commandExecution/outputDelta"
  ) {
    if (typeof p.itemId !== "string" || typeof p.delta !== "string") return;
    const key = method + ":" + p.itemId;
    let r = deltas.get(key);
    if (!r) {
      if (deltas.size >= 256) return;
      deltas.set(key, (r = new Redactor(redact.secrets)));
    }
    const text = r.delta(p.delta);
    for (let i = 0; i < text.length; i += 2048)
      await emit({
        type: method.includes("agentMessage") ? "text" : "output",
        itemId: p.itemId.slice(0, 128),
        text: text.slice(i, i + 2048),
      });
  } else if (
    (method === "item/started" || method === "item/completed") &&
    item
  ) {
    if (
      ![
        "agentMessage",
        "commandExecution",
        "fileChange",
        "mcpToolCall",
      ].includes(item.type)
    )
      return;
    // Refresh the exact-token denylist before processing command output after a native OAuth rotation.
    const fresh = secretsFrom(
      JSON.parse(await readFile(authPath, "utf8")),
      process.env.FLARE_MCP_TOKEN,
    );
    redact.secrets = [
      ...new Set([
        ...redact.secrets,
        ...fresh.filter((x) => typeof x === "string" && x.length > 5),
      ]),
    ];
    for (const r of deltas.values()) r.secrets = redact.secrets;
    for (const [key, r] of deltas)
      if (key.endsWith(":" + item.id) && method === "item/completed") {
        const text = r.delta("", true);
        if (text)
          await emit({
            type: key.startsWith("item/agentMessage") ? "text" : "output",
            itemId: item.id,
            text,
          });
        deltas.delete(key);
      }
    await emit({
      type: "item",
      itemId: String(item.id).slice(0, 128),
      kind: item.type,
      state: method === "item/started" ? "started" : "completed",
      ...(item.type === "commandExecution"
        ? {
            text: redact.text(String(item.command ?? "")).slice(0, 4096),
            exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
          }
        : {}),
      ...(item.type === "mcpToolCall"
        ? { text: redact.text(`${item.server}/${item.tool}`).slice(0, 256) }
        : {}),
    });
    if (item.type === "agentMessage" && method === "item/completed") {
      const text = redact.text(String(item.text ?? ""));
      if (Buffer.byteLength(text) > 65536) {
        stop("OUTPUT_TOO_LARGE");
        return;
      }
      if (item.phase === "final_answer" || item.phase == null) finalText = text;
    }
  } else if (method === "turn/started")
    await emit({ type: "status", text: "running" });
  else if (method === "turn/completed") {
    completed = true;
    turnStatus = p.turn?.status;
    await emit({
      type: "status",
      text: turnStatus === "completed" ? "finishing" : "failed",
    });
    child.stdin.end();
    // Codex gets a graceful shutdown, bounded independently of the browser connection.
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, 3000);
  } else if (method === "error")
    await emit({ type: "status", text: "provider_retry_or_error" });
}
const pump = (async () => {
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024) {
      stop("PROTOCOL_TOO_LARGE");
      break;
    }
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line) await event(JSON.parse(line));
    }
  }
})().catch(() => stop("PROTOCOL_FAILED"));
try {
  await request("initialize", {
    clientInfo: { name: "flare_codex_runner", version: "0.3.12" },
  });
  send({ method: "initialized", params: {} });
  const started = await request("thread/start", {
    cwd: "/workspace",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceName: "flare",
  });
  await request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
  });
} catch {
  if (!reason) stop("START_FAILED");
}
const exitCode = await exited;
await pump;
clearTimeout(timeout);
clearInterval(cancel);
clearTimeout(killTimer);
try {
  process.kill(-child.pid, "SIGKILL");
} catch {}
if (completed && turnStatus === "completed" && !reason)
  await writeFile(`${dir}/result.txt`, finalText, { mode: 0o600 });
await writeFile(
  `${dir}/outcome.tmp`,
  JSON.stringify({
    exitCode:
      completed && turnStatus === "completed" && !reason ? 0 : exitCode || 1,
    reason,
  }),
  { mode: 0o600 },
);
await rename(`${dir}/outcome.tmp`, `${dir}/outcome.json`);
