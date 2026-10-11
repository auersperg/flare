import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (a, x, i, all) =>
        i % 2 === 0 ? [...a, [x.replace(/^--/, ""), all[i + 1]]] : a,
      [],
    ),
);
const { account, owner, subdomain } = args;
if (
  !/^[a-f0-9]{32}$/.test(account ?? "") ||
  !/^\S+@\S+\.\S+$/.test(owner ?? "") ||
  !/^[a-z0-9-]+$/.test(subdomain ?? "")
)
  throw Error(
    "Required: --account <ID> --owner <email> --subdomain <workers.dev prefix>",
  );
const auth = await readFile(
  `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`,
  "utf8",
);
const token = auth.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw Error("Sign in with Wrangler first");
async function cf(path, body, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const x = await r.json();
  if (!x.success)
    throw Error(`Cloudflare ${path}: ${JSON.stringify(x.errors)}`);
  return x.result;
}
await mkdir(".private", { recursive: true });
const accountFile = ".private/flared-install.json";
let previous;
try {
  previous = JSON.parse(await readFile(accountFile, "utf8"));
  if (previous.account !== account)
    throw Error("Refusing to reuse resources from another account");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const dbName = "flared-catalog",
  bucket = "flared-builds",
  queue = "flared-jobs",
  dlq = "flared-jobs-dlq";
let database = (await cf("d1/database")).find((x) => x.name === dbName);
if (!database) database = await cf("d1/database", { name: dbName });
const buckets = await cf("r2/buckets");
for (const name of [bucket, "flared-files"])
  if (!buckets.buckets.some((x) => x.name === name))
    await cf("r2/buckets", { name });
const queues = await cf("queues");
for (const name of [queue, dlq])
  if (!queues.some((x) => x.queue_name === name))
    await cf("queues", { queue_name: name });
const runtimeUrl =
    previous?.runtimeUrl ?? `https://flared-runtime.${subdomain}.workers.dev`,
  adminUrl =
    previous?.adminUrl ?? `https://flared-admin.${subdomain}.workers.dev`;
// Re-running setup must not remove an installation's custom domains or change
// the issuer of outstanding 15-minute developer identities.
const savedConfig = async (file, name) => {
  if (!previous) return {};
  const config = JSON.parse(await readFile(file, "utf8"));
  if (config.account_id !== account || config.name !== name)
    throw Error("Configuration belongs to another installation");
  return config;
};
const savedRuntime = await savedConfig(
  "runtime.wrangler.json",
  "flared-runtime",
);
const savedAdmin = await savedConfig("admin.wrangler.json", "flared-admin");
let app;
if (previous?.accessApp) {
  try {
    app = await cf("access/apps/" + previous.accessApp);
  } catch (error) {
    // Wrangler OAuth may not read native Worker Access apps. Preserve the confirmed
    // checkpoint rather than duplicating its app or resetting the audience.
    if (!String(error).includes("1010") && !String(error).includes("403"))
      throw error;
    const config = JSON.parse(await readFile("admin.wrangler.json", "utf8"));
    if (
      config.account_id !== account ||
      config.vars?.RUNTIME_URL !== runtimeUrl ||
      !config.vars?.ACCESS_AUD ||
      previous.owner !== owner ||
      !previous.issuer
    )
      throw error;
    app = { id: previous.accessApp, aud: config.vars.ACCESS_AUD };
  }
} else
  app = (await cf("access/apps")).find(
    (x) => x.name === "Flared dashboard" && x.domain === new URL(adminUrl).host,
  );
if (!app && args["defer-access"] !== "yes")
  app = await cf("access/apps", {
    name: "Flared dashboard",
    type: "self_hosted",
    domain: new URL(adminUrl).host,
    session_duration: "8h",
    policies: [
      {
        name: "Flared owner",
        decision: "allow",
        include: [{ email: { email: owner } }],
      },
    ],
  });
if (!app) app = { aud: "", id: null };
const actual = await cf("workers/subdomain");
if (actual.subdomain !== subdomain)
  throw Error("Subdomain does not match the account: " + actual.subdomain);
const common = {
  account_id: account,
  compatibility_date: "2026-10-10",
  compatibility_flags: ["nodejs_compat"],
  preview_urls: false,
  observability: { enabled: true, head_sampling_rate: 1 },
  limits: { cpu_ms: 1000 },
};
const runtime = {
  ...common,
  name: "flared-runtime",
  ...(savedRuntime.routes
    ? { routes: savedRuntime.routes, workers_dev: savedRuntime.workers_dev }
    : {}),
  main: "packages/core/dist/runtime.js",
  worker_loaders: [{ binding: "LOADER" }],
  durable_objects: {
    bindings: [{ name: "SUPERVISORS", class_name: "EnvironmentSupervisor" }],
  },
  exports: {
    EnvironmentSupervisor: { type: "durable-object", storage: "sqlite" },
  },
  r2_buckets: [
    { binding: "BUNDLES", bucket_name: bucket },
    { binding: "FILES", bucket_name: "flared-files" },
  ],
  queues: {
    producers: [{ binding: "JOBS", queue }],
    consumers: [
      {
        queue,
        max_batch_size: 10,
        max_concurrency: 4,
        max_batch_timeout: 1,
        max_retries: 3,
        dead_letter_queue: dlq,
      },
    ],
  },
  ratelimits: [
    {
      name: "RATE_LIMITER",
      namespace_id: "17916201",
      simple: { limit: 600, period: 60 },
    },
  ],
  vars: {
    RUNTIME_URL: runtimeUrl,
    DASHBOARD_URL: adminUrl,
    DEV_TOKEN_ISSUER:
      savedRuntime.vars?.DEV_TOKEN_ISSUER ??
      savedRuntime.vars?.RUNTIME_URL ??
      runtimeUrl,
  },
  services: [
    {
      binding: "ADMIN_API",
      service: "flared-admin",
      entrypoint: "AdminControl",
    },
  ],
};
const admin = {
  ...common,
  name: "flared-admin",
  ...(savedAdmin.routes
    ? { routes: savedAdmin.routes, workers_dev: savedAdmin.workers_dev }
    : {}),
  main: "packages/core/dist/admin.js",
  assets: {
    directory: "packages/core/dist/dashboard",
    binding: "ASSETS",
    run_worker_first: ["/*", "!/_astro/*"],
  },
  d1_databases: [
    {
      binding: "CATALOG",
      database_name: dbName,
      database_id: database.uuid,
      migrations_dir: "packages/core/migrations",
    },
  ],
  services: [
    {
      binding: "RUNTIME",
      service: "flared-runtime",
      entrypoint: "RuntimeControl",
    },
  ],
  vars: {
    RUNTIME_URL: runtimeUrl,
    DASHBOARD_URL: adminUrl,
    ACCESS_ISSUER: previous?.issuer ?? "",
    ACCESS_AUD: app.aud,
  },
};
await writeFile(
  "runtime.wrangler.json",
  JSON.stringify(runtime, null, 2) + "\n",
);
await writeFile("admin.wrangler.json", JSON.stringify(admin, null, 2) + "\n");
const boot = { ...runtime, services: [] };
await writeFile(
  ".private/runtime-boot.json",
  JSON.stringify(
    { ...boot, main: "../packages/core/dist/runtime.js" },
    null,
    2,
  ),
);
const run = (args, stdin) =>
  new Promise((done, reject) => {
    const child = spawn(
      "node",
      ["node_modules/wrangler/bin/wrangler.js", ...args],
      {
        stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      },
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    child.on("exit", (code) =>
      code === 0 ? done() : reject(Error("Wrangler command failed")),
    );
  });
await run([
  "d1",
  "migrations",
  "apply",
  dbName,
  "--remote",
  "--config",
  "admin.wrangler.json",
]);
await cf(`d1/database/${database.uuid}/query`, {
  sql: "INSERT OR IGNORE INTO members (email,role) VALUES (?,?)",
  params: [owner.toLowerCase(), "owner"],
});
if (!previous) {
  await run(["deploy", "--config", ".private/runtime-boot.json"]);
}
let secret;
try {
  secret = await readFile(".private/flared-dev-key", "utf8");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  secret = randomBytes(48).toString("hex");
  await writeFile(".private/flared-dev-key", secret, { mode: 0o600 });
}
await run(
  ["secret", "put", "DEV_SIGNING_KEY", "--config", "runtime.wrangler.json"],
  secret.trim(),
);
await run(["deploy", "--config", "admin.wrangler.json"]);
const r = await fetch(adminUrl, { redirect: "manual" });
const location = r.headers.get("location");
const issuer = previous?.issuer ?? (location ? new URL(location).origin : null);
if (!issuer || !issuer.endsWith(".cloudflareaccess.com")) {
  if (args["defer-access"] === "yes") {
    await run(["deploy", "--config", "runtime.wrangler.json"]);
    await writeFile(
      accountFile,
      JSON.stringify(
        {
          ...previous,
          account,
          owner,
          adminUrl,
          runtimeUrl,
          database: database.uuid,
          accessApp: null,
          issuer: null,
          accessPending: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        adminUrl,
        runtimeUrl,
        status: "Access pending; admin fail-closed",
      }),
    );
    process.exit(0);
  }
  throw Error(
    "Access issuer could not be confirmed; admin remains fail-closed",
  );
}
admin.vars.ACCESS_ISSUER = issuer;
await writeFile("admin.wrangler.json", JSON.stringify(admin, null, 2) + "\n");
await run(["deploy", "--config", "runtime.wrangler.json"]);
await run(["deploy", "--config", "admin.wrangler.json"]);
await writeFile(
  accountFile,
  JSON.stringify(
    {
      ...previous,
      account,
      owner,
      adminUrl,
      runtimeUrl,
      database: database.uuid,
      accessApp: app.id,
      issuer,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      adminUrl,
      runtimeUrl,
      owner,
      access: "email allowlist; server verifies signature/issuer/audience",
    },
    null,
    2,
  ),
);
