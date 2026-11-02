// A single process supervisor, not an agent loop. Codex owns tools and OAuth.
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, stat } from "node:fs/promises";

const dir = "/run/flare";
const input = JSON.parse(await readFile(`${dir}/input.json`, "utf8"));
const args = [
  "exec",
  "--ephemeral",
  "--skip-git-repo-check",
  // The private container and outbound entrypoint are the outer sandbox.
  "--dangerously-bypass-approvals-and-sandbox",
  "--output-last-message",
  `${dir}/result.txt`,
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
args.push("--", input.prompt);
const child = spawn("codex", args, {
  cwd: "/workspace",
  detached: true,
  env: { ...process.env, CODEX_HOME: `${dir}/codex` },
  // No raw model/tool output or auth errors in Worker/container logs.
  stdio: "ignore",
});
let reason, killTimer;
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
const exitCode = await new Promise((resolve) => {
  child.once("error", () => resolve(-1));
  child.once("exit", (code) => resolve(code ?? -1));
});
clearTimeout(timeout);
clearInterval(cancel);
clearTimeout(killTimer);
// Stop any child left behind before the Worker checkpoints the final auth file.
try {
  process.kill(-child.pid, "SIGKILL");
} catch {}
await writeFile(`${dir}/outcome.tmp`, JSON.stringify({ exitCode, reason }), {
  mode: 0o600,
});
await rename(`${dir}/outcome.tmp`, `${dir}/outcome.json`);
