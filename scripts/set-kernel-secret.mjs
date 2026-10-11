import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const config = process.env.FLARE_KERNEL_CONFIG;
if (!config)
  throw new Error(
    "Set FLARE_KERNEL_CONFIG to an explicit cloud test configuration",
  );
const token = (await readFile(".private/kernel-token", "utf8")).trim();
const child = spawn(
  "node",
  [
    "node_modules/wrangler/bin/wrangler.js",
    "secret",
    "put",
    "KERNEL_TOKEN",
    "--config",
    config,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
child.stdin.end(token);
process.exitCode = await new Promise((resolve) => child.on("exit", resolve));
