import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { WRANGLER_VERSION } from "./platform-release.mjs";

export class CloudflareError extends Error {
  constructor(path, status, codes, ambiguous = false) {
    super(
      `Cloudflare ${path.split("?")[0]} failed (${status || "network"}${codes.length ? "; codes " + codes.join(",") : ""}).${ambiguous ? " Outcome is unknown; inspect platform status before resuming." : " Check account permissions and service activation."}`,
    );
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export async function runWrangler(args, { token, cwd, capture = false } = {}) {
  // Download only the pinned tool, lazily. No Wrangler dependency enters SDK imports.
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  delete env.CLOUDFLARE_API_KEY;
  delete env.CLOUDFLARE_EMAIL;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.WRANGLER_CI_OVERRIDE_NAME;
  const child = spawn(
    process.execPath,
    ["x", `wrangler@${WRANGLER_VERSION}`, ...args],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    oversized = false,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const collect = (which) => (bytes) => {
    if (stdout.length + stderr.length > 1024 * 1024) {
      oversized = true;
      child.kill("SIGTERM");
      return;
    }
    if (which === "out") stdout += bytes;
    else stderr += bytes;
  };
  child.stdout.on("data", collect("out"));
  child.stderr.on("data", collect("err"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(Error("Unable to start pinned Wrangler")),
      );
      child.once("close", resolve);
    });
    if (code !== 0 || oversized || interrupted) {
      // auth token stdout is never included in diagnostics.
      throw Error(
        `Wrangler ${args[0]} failed (${code ?? "terminated"}).${capture ? "" : " Inspect platform status before resuming; no stderr containing possible credentials was printed."}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

export async function cloudflareToken(run = runWrangler) {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim())
    return process.env.CLOUDFLARE_API_TOKEN.trim();
  let credential;
  try {
    credential = JSON.parse(
      await run(["auth", "token", "--json"], { capture: true }),
    );
  } catch {
    throw Error(
      "Cloudflare authentication required. Set CLOUDFLARE_API_TOKEN with Workers, D1, R2, Queues and Access permissions, or sign in with Wrangler. FLARE_DEPLOY_TOKEN cannot install a platform.",
    );
  }
  if (
    !["api_token", "oauth"].includes(credential.type) ||
    typeof credential.token !== "string" ||
    !credential.token.trim()
  )
    throw Error(
      "Use a scoped Cloudflare API token or Wrangler OAuth, not a global API key.",
    );
  return credential.token;
}

export class CloudflareAccount {
  constructor(
    account,
    token,
    { fetch: fetcher = globalThis.fetch, run = runWrangler, wait = sleep } = {},
  ) {
    if (
      !/^[a-f0-9]{32}$/.test(account) ||
      typeof token !== "string" ||
      !token ||
      /[\r\n]/.test(token)
    )
      throw Error("Invalid Cloudflare account or credential");
    this.account = account;
    this.token = token;
    this.fetcher = fetcher;
    this.run = run;
    this.wait = wait;
  }
  async request(
    path,
    body,
    method = body === undefined ? "GET" : "POST",
    global = false,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(path, body, method, global);
      } catch (error) {
        // Only idempotent account reads. Never replay SQL POSTs, resource writes
        // or unknown deployment outcomes, even if their intent seems harmless.
        if (
          method !== "GET" ||
          !(error instanceof CloudflareError) ||
          ![0, 408, 429, 500, 502, 503, 504].includes(error.status) ||
          attempt >= 2
        )
          throw error;
        await this.wait(250 * 2 ** attempt);
      }
    }
  }
  async requestOnce(path, body, method, global) {
    if (
      !/^[a-zA-Z0-9_/?=&.%:-]+$/.test(path) ||
      path.includes("..") ||
      path.startsWith("/")
    )
      throw Error("Invalid Cloudflare API path");
    const write = method !== "GET";
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    let response, data;
    try {
      response = await this.fetcher(
        `https://api.cloudflare.com/client/v4/${global ? "" : `accounts/${this.account}/`}${path}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: encoded,
        },
      );
      if (response.status === 204 && method === "DELETE")
        return { success: true, result: null };
      data = await response.json();
    } catch {
      throw new CloudflareError(
        path,
        response?.status ?? 0,
        [],
        write && (!response || response.ok || response.status >= 500),
      );
    }
    if (!response.ok || !data.success) {
      const codes = (Array.isArray(data.errors) ? data.errors : [])
        .map((e) => Number(e.code))
        .filter(Number.isSafeInteger);
      throw new CloudflareError(
        path,
        response.status,
        codes,
        write && response.status >= 500,
      );
    }
    return data;
  }
  async api(path, body, method, global = false) {
    return (await this.request(path, body, method, global)).result;
  }
  async list(path, { global = false, perPage = 100 } = {}) {
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 1000)
      throw Error("Invalid Cloudflare inventory page size");
    const values = [];
    let page = 1;
    while (page <= 100) {
      const data = await this.request(
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`,
        undefined,
        "GET",
        global,
      );
      if (!Array.isArray(data.result))
        throw Error("Unexpected Cloudflare resource inventory");
      values.push(...data.result);
      const totalPages =
        data.result_info?.total_pages ??
        (data.result_info?.total_count && data.result_info?.per_page
          ? Math.ceil(data.result_info.total_count / data.result_info.per_page)
          : 1);
      if (page >= totalPages) return values;
      page++;
    }
    throw Error("Cloudflare resource inventory exceeds supported pagination");
  }
  async sql(database, sql, params = []) {
    if (!/^[a-f0-9-]{36}$/.test(database))
      throw Error("Invalid D1 database ID");
    const result = await this.api(`d1/database/${database}/query`, {
      sql,
      params,
    });
    if (!Array.isArray(result) || result.some((r) => r.success === false))
      throw Error(
        "Cloudflare D1 statement failed; no automatic retry was made",
      );
    return result[0] ?? { results: [], meta: { changes: 0 } };
  }
  async deploy(config, context) {
    await this.run(
      [
        "deploy",
        "--config",
        config,
        "--no-bundle",
        "--strict",
        "--tag",
        context.tag,
        "--message",
        context.message,
        ...(context.secretsFile ? ["--secrets-file", context.secretsFile] : []),
      ],
      { token: this.token, cwd: context.cwd },
    );
  }
  async migrations(config, database, cwd) {
    await this.run(
      ["d1", "migrations", "apply", database, "--remote", "--config", config],
      { token: this.token, cwd },
    );
  }
  async currentVersion(name) {
    const response = await this.api(`workers/scripts/${name}/deployments`);
    const deployments = response.deployments ?? response;
    if (!Array.isArray(deployments) || !deployments.length)
      throw Error("Worker has no deployed version: " + name);
    const latest = [...deployments].sort((a, b) =>
      String(b.created_on).localeCompare(String(a.created_on)),
    )[0];
    if (latest.versions?.length !== 1 || latest.versions[0].percentage !== 100)
      throw Error(
        "Split Worker deployment is not supported by the platform updater",
      );
    return latest.versions[0].version_id;
  }
  async versionTag(name, id) {
    const version = await this.api(`workers/scripts/${name}/versions/${id}`);
    return (
      version.annotations?.["workers/tag"] ??
      version.metadata?.annotations?.["workers/tag"]
    );
  }
}
