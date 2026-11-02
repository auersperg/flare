#!/usr/bin/env node
// Official app-server wire shape, deterministic fixture. Never calls a model.
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (
  args[0] !== "app-server" ||
  !args.includes("features.apps=false") ||
  !args.includes('forced_login_method="chatgpt"')
)
  process.exit(3);
const send = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params }) + "\n");
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ id, result }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "initialize") reply(m.id, {});
  if (m.method === "thread/start")
    reply(m.id, { thread: { id: "fixture-thread" } });
  if (m.method !== "turn/start") continue;
  reply(m.id, { turn: { id: "fixture-turn" } });
  const prompt = m.params.input[0].text;
  const path = `${process.env.CODEX_HOME}/auth.json`;
  const auth = JSON.parse(await readFile(path, "utf8"));
  if (prompt === "restored" && auth.tokens.access_token !== "fixture-rotated")
    process.exit(2);
  auth.tokens.access_token = "fixture-rotated";
  await writeFile(path, JSON.stringify(auth));
  send("turn/started", {});
  send("item/started", {
    item: {
      id: "command-1",
      type: "commandExecution",
      command: "echo safe",
      status: "inProgress",
    },
  });
  send("item/commandExecution/outputDelta", {
    itemId: "command-1",
    delta: "fixture-",
  });
  await new Promise((r) => setTimeout(r, 200));
  send("item/commandExecution/outputDelta", {
    itemId: "command-1",
    delta: "rotated\nsafe output\n",
  });
  if (prompt === "wait") await new Promise(() => setInterval(() => {}, 1000));
  await new Promise((r) => setTimeout(r, 3000));
  send("item/completed", {
    item: {
      id: "command-1",
      type: "commandExecution",
      command: "echo safe",
      exitCode: 0,
      aggregatedOutput: "first buffered output\nfixture-rotated\nsafe output\n",
      status: "completed",
    },
  });
  send("item/started", {
    item: { id: "answer", type: "agentMessage", text: "" },
  });
  send("item/agentMessage/delta", { itemId: "answer", delta: "fixture " });
  await new Promise((r) => setTimeout(r, 100));
  send("item/agentMessage/delta", { itemId: "answer", delta: "OK" });
  send("item/completed", {
    item: {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "fixture OK",
    },
  });
  send("turn/completed", {
    turn: {
      id: "fixture-turn",
      items: [],
      status: prompt === "fail" ? "failed" : "completed",
    },
  });
}
