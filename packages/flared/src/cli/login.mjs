import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  randomBytes,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  constants,
} from "node:crypto";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const credentialDirectory = () =>
  join(process.env.FLARED_CONFIG_HOME ?? join(homedir(), ".config", "flared"));
export async function storedToken(platform, project) {
  const key = createHash("sha256")
    .update(platform + "/" + project)
    .digest("hex");
  const record = JSON.parse(
    await readFile(join(credentialDirectory(), key + ".json"), "utf8").catch(
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return "null";
      },
    ),
  );
  if (record && record.expiresAt > Date.now()) return record.token;
  return null;
}
export async function connect() {
  if (!process.stdin.isTTY)
    throw Error(
      "First run needs an interactive terminal: run flared dev to sign in. CI can use FLARED_DEPLOY_TOKEN with a linked project.",
    );
  let dashboard, platform;
  const existing = JSON.parse(
    await readFile(".flared/project.json", "utf8").catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return "null";
    }),
  );
  if (existing) platform = new URL(new URL(existing.platform).origin);
  else {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      platform = new URL(
        await prompt.question("Runtime URL (shown in dashboard Health): "),
      );
    } finally {
      prompt.close();
    }
  }
  if (
    platform.protocol !== "https:" ||
    platform.username ||
    platform.password ||
    platform.search ||
    platform.hash ||
    platform.pathname !== "/"
  )
    throw Error("Enter a plain HTTPS origin without a path or credentials.");
  platform = platform.origin + "/control";
  const secret = randomBytes(32).toString("hex"),
    secretHash = createHash("sha256").update(secret).digest("hex");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  async function post(path, body) {
    const response = await fetch(platform + "/api/cli/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(
        `CLI login ${data.error ?? response.status}. The platform must have the CLI login update installed.`,
      );
    return data;
  }
  const session = await post("start", {
    secretHash,
    publicKey: publicKey.export({ format: "jwk" }),
  });
  dashboard = new URL(session.dashboard);
  if (
    dashboard.protocol !== "https:" ||
    dashboard.username ||
    dashboard.password ||
    dashboard.pathname !== "/" ||
    dashboard.search ||
    dashboard.hash
  )
    throw Error("Invalid dashboard URL returned by installation");
  const url = dashboard.origin + "/?cli=" + encodeURIComponent(session.id);
  console.log(`Confirm code ${session.code} in your dashboard:\n${url}`);
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? null
        : "xdg-open";
  if (opener) {
    const child = spawn(opener, [url], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
  const end = Date.now() + Math.min(session.expiresIn, 600) * 1000;
  while (Date.now() < end) {
    await sleep(3000);
    const result = await post("poll", { id: session.id, secret });
    if (result.pending) continue;
    if (result.platform !== platform || !/^[a-f0-9-]{36}$/.test(result.project))
      throw Error("Unexpected platform/project in login response");
    const token = privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(result.encrypted, "base64"),
    ).toString();
    const directory = credentialDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256")
      .update(platform + "/" + result.project)
      .digest("hex");
    await writeFile(
      join(directory, key + ".json"),
      JSON.stringify({ token, expiresAt: result.expiresAt }) + "\n",
      { mode: 0o600 },
    );
    // The token lives outside the application. link writes public configuration only.
    process.env.FLARED_DEPLOY_TOKEN = token;
    const { link } = await import("./cloud.mjs");
    return link({ platform, project: result.project });
  }
  throw Error("Login expired. Run flared dev again.");
}
