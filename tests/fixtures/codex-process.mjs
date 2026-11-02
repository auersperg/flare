#!/usr/bin/env node
// No model/network calls. Exercises the production process supervisor in Linux.
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const prompt = args.at(-1);
if (
  !args.includes("features.apps=false") ||
  !args.includes('forced_login_method="chatgpt"')
)
  process.exit(3);
const path = `${process.env.CODEX_HOME}/auth.json`;
const auth = JSON.parse(await readFile(path, "utf8"));
if (prompt === "restored" && auth.tokens.access_token !== "fixture-rotated")
  process.exit(2);
auth.tokens.access_token = "fixture-rotated";
await writeFile(path, JSON.stringify(auth));
if (prompt === "wait") await new Promise(() => setInterval(() => {}, 1000));
if (prompt === "fail") process.exit(1);
await writeFile(args[args.indexOf("--output-last-message") + 1], "fixture OK");
