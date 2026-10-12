import { randomUUID } from "node:crypto";
import {
  readFile,
  mkdir,
  writeFile,
  access,
  mkdtemp,
  watch,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
const allowedUrl = (value) => {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw Error("Platform must be an HTTPS management URL");
  return u.href.replace(/\/$/, "");
};
async function request(platform, path, body) {
  let token = process.env.FLARE_DEPLOY_TOKEN;
  if (!token) {
    const config = JSON.parse(
      await readFile(".flare/project.json", "utf8").catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return "null";
      }),
    );
    if (config) {
      const { storedToken } = await import("./login.mjs");
      token = await storedToken(platform, config.project);
    }
  }
  if (!token)
    throw Error("Sign in with flare dev; CI can set FLARE_DEPLOY_TOKEN");
  const url = allowedUrl(platform) + path;
  const write = body !== undefined;
  const encoded = write ? JSON.stringify(body) : undefined;
  let r;
  try {
    r = await fetch(url, {
      method: write ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(write ? { "content-type": "application/json" } : {}),
      },
      body: encoded,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    const error = Error(
      write
        ? "Management write outcome is unknown; inspect current state before retrying. Writes are not automatically retried."
        : "Management request interrupted or timed out",
    );
    error.ambiguous = write;
    throw error;
  }
  let result;
  try {
    result = await r.json();
  } catch {
    const error = Error(
      `Invalid management response (HTTP ${r.status}); ${write && (r.ok || r.status >= 500) ? "write outcome is unknown; inspect current state before retrying" : "check platform availability and authorization"}`,
    );
    error.status = r.status;
    error.ambiguous = write && (r.ok || r.status >= 500);
    throw error;
  }
  if (!r.ok) {
    const code =
      typeof result?.error === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error)
        ? result.error
        : "Management request failed";
    const error = Error(
      `${code} (HTTP ${r.status}); writes are not automatically retried`,
    );
    error.status = r.status;
    error.ambiguous = write && r.status >= 500;
    throw error;
  }
  return result;
}
export async function link(options) {
  if (
    !options.platform ||
    !options.project ||
    !/^[0-9a-f-]{36}$/.test(options.project)
  )
    throw Error("Required: --platform <management URL> --project <ID>");
  const platform = allowedUrl(options.platform);
  const data = await request(platform, `/api/projects/${options.project}`);
  await mkdir(".flare", { recursive: true });
  await writeFile(
    ".flare/project.json",
    JSON.stringify(
      {
        platform,
        project: options.project,
        runtime: data.runtime,
        urls: data.urls,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return { project: options.project, runtime: data.runtime, urls: data.urls };
}
export async function deploy(options = {}) {
  if (!options.release) {
    const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
    const env = options.env ?? "prod";
    if (!["dev", "prod"].includes(env))
      throw Error("Environment must be dev or prod");
    if (env === "prod" && options.confirm !== config.project) {
      if (!process.stdin.isTTY)
        throw Error("Production requires --confirm <project ID> in CI");
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        if (
          (await prompt.question(
            `Deploy to production ${config.project}? Type yes: `,
          )) !== "yes"
        )
          throw Error("Deployment cancelled");
      } finally {
        prompt.close();
      }
    }
    const { prepare, generateApi } = await import("./project.mjs");
    const { buildApplication } = await import("./build.mjs");
    const source = await prepare(),
      directory = resolve(".flare/releases/" + randomUUID());
    try {
      await buildApplication({ ...source, outdir: directory });
      const result = await deploy({
        env,
        release: directory,
        confirm: env === "prod" ? config.project : undefined,
        cmd: options.cmd,
      });
      await generateApi(directory);
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
  const env = options.env ?? "dev";
  if (!["dev", "prod"].includes(env) || !options.release)
    throw Error("Required: --env dev|prod --release <built directory>");
  if (env === "prod" && options.confirm !== config.project)
    throw Error("Production requires --confirm <project ID>");
  const directory = resolve(options.release);
  const read = async (file) => readFile(join(directory, file), "utf8");
  const bundle = {
    release: JSON.parse(await read("release.json")),
    manifest: JSON.parse(await read("manifest.json")),
    schema: JSON.parse(await read("schema.json")),
    facet: await read("facet.js"),
    action: await read("action.js"),
  };
  const health = await request(
    config.platform,
    `/api/projects/${config.project}/${env}/health`,
  );
  const expected = health?.active;
  if (!/^[a-f0-9]{64}$/.test(expected ?? ""))
    throw Error(
      "Environment has no active backend; inspect dashboard Health before deploying",
    );
  if (options.cmd) {
    const { withGeneratedApi } = await import("./project.mjs");
    await withGeneratedApi(directory, () =>
      frontendBuild(config, env, options.cmd),
    );
  }
  return request(
    config.platform,
    `/api/projects/${config.project}/${env}/deploy`,
    { bundle, confirm: options.confirm, expected },
  );
}
export async function dev(options = {}) {
  if (options.env && options.env !== "dev")
    throw Error("Watch publishes only to dev; use deploy for production");
  const simple = !options.entry;
  if (simple) {
    const { scaffold } = await import("./project.mjs");
    await scaffold();
    try {
      await access(".flare/project.json");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const { connect } = await import("./login.mjs");
      await connect();
    }
  }
  await access(".flare/project.json");
  if (simple) {
    const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
    try {
      await request(config.platform, `/api/projects/${config.project}`);
    } catch (e) {
      if (
        process.env.FLARE_DEPLOY_TOKEN ||
        (e.status !== 401 && !e.message.startsWith("Sign in"))
      )
        throw e;
      const { connect } = await import("./login.mjs");
      await connect();
    }
  }
  const { buildApplication } = await import("./build.mjs");
  let busy = false,
    pending = false,
    timer,
    hash;
  const publish = async (initial = false) => {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      const outdir = resolve(".flare/releases/" + randomUUID());
      try {
        const { prepare, generateApi, frontendEnvironment } =
          await import("./project.mjs");
        const source = simple ? await prepare() : { entry: options.entry };
        const release = await buildApplication({ ...source, outdir });
        if (release.hash !== hash) {
          const data = await deploy({ env: "dev", release: outdir });
          if (simple) {
            await generateApi(outdir);
            await frontendEnvironment(data.url);
          }
          hash = release.hash;
          console.log(`Dev release ${hash}\n${data.url}`);
        }
      } finally {
        await rm(outdir, { recursive: true, force: true });
      }
    } catch (e) {
      if (initial) throw e;
      console.error(e.message);
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void publish();
      }
    }
  };
  await publish(true);
  console.log(
    "Watching application code; backend runs in Cloudflare dev. Start your frontend with its own dev server.",
  );
  for await (const event of watch(simple ? resolve("flare") : process.cwd(), {
    recursive: true,
  })) {
    const file = event.filename?.toString() ?? "";
    if (
      /(^|\/)(node_modules|\.flare|\.git|dist|_generated)(\/|$)/.test(file) ||
      !/\.(ts|tsx|js|mjs|sql|json)$/.test(file)
    )
      continue;
    clearTimeout(timer);
    timer = setTimeout(() => void publish(), 400);
  }
}

export async function backup(options = {}) {
  const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
  const operation = options.operation ?? "list",
    env = options.env ?? "prod";
  if (
    !["dev", "prod"].includes(env) ||
    !["create", "list", "restore", "delete", "status"].includes(operation)
  )
    throw Error("Use backup create|list|restore|delete|status --env dev|prod");
  const path = `/api/projects/${config.project}/${env}/`;
  if (operation === "list")
    return request(
      config.platform,
      path +
        "backups" +
        (options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""),
    );
  if (operation === "status")
    return request(config.platform, path + "backup-status");
  const id = options.id ?? (operation === "create" ? randomUUID() : null);
  if (!id || !/^[0-9a-f-]{36}$/.test(id))
    throw Error("Required: --id <backup ID>");
  if (
    operation === "restore" &&
    (!["dev", "prod"].includes(options.from) || options.from === env)
  )
    throw Error(
      "Restore requires --from dev|prod to a different empty environment of this project",
    );
  if (options.confirm !== config.project) {
    if (!process.stdin.isTTY)
      throw Error("Backup writes require --confirm <project ID> in CI");
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (
        (await prompt.question(
          `${operation} backup ${id} · ${config.project}/${env}? Type yes: `,
        )) !== "yes"
      )
        throw Error("Cancelled");
    } finally {
      prompt.close();
    }
  }
  // Print the ID before sending so a disconnected request can be inspected/retried explicitly.
  console.error(`Backup operation ${operation}: ${id}`);
  return request(config.platform, path + "backup-" + operation, {
    id,
    sourceEnv: options.from,
    confirm: config.project,
  });
}

async function frontendBuild(config, env, command) {
  if (typeof command !== "string" || !command.trim())
    throw Error("Empty build command");
  const settings = await request(
    config.platform,
    `/api/projects/${config.project}/${env}/settings`,
  );
  const url = allowedUrl(settings.url);
  const { $ } = await import("bun");
  // Only the child process receives this target URL. Never overwrite .env.local.
  await $`${{ raw: command }}`.env({
    ...process.env,
    FLARE_URL: url,
    PUBLIC_FLARE_URL: url,
    VITE_FLARE_URL: url,
    NEXT_PUBLIC_FLARE_URL: url,
    EXPO_PUBLIC_FLARE_URL: url,
  });
}
async function releaseOperation(options, operation) {
  const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
  const env = options.env ?? "prod";
  if (
    !["dev", "prod"].includes(env) ||
    !/^[a-f0-9]{64}$/.test(options.hash ?? "")
  )
    throw Error(
      "Required: --hash <64-character release hash> and --env dev|prod",
    );
  if (operation === "promote" && env !== "prod")
    throw Error("Promote targets production only");
  if (options.confirm !== config.project) {
    if (!process.stdin.isTTY)
      throw Error("Release switch requires --confirm <project ID> in CI");
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (
        (await prompt.question(
          `${operation} ${options.hash} into ${env}? Type yes: `,
        )) !== "yes"
      )
        throw Error("Cancelled");
    } finally {
      prompt.close();
    }
  }
  const path = `/api/projects/${config.project}/${env}/`;
  const health = await request(config.platform, path + "health");
  if (options.cmd) {
    const source = operation === "promote" ? "dev" : env;
    const bundle = await request(
      config.platform,
      `/api/projects/${config.project}/${source}/release-bundle?hash=${options.hash}`,
    );
    if (bundle.release.hash !== options.hash)
      throw Error("Release hash mismatch");
    const { generateReferences } = await import("./build.mjs");
    const { withGeneratedApi } = await import("./project.mjs");
    await mkdir(".flare", { recursive: true });
    const directory = await mkdtemp(resolve(".flare/release-contract-"));
    try {
      await writeFile(
        join(directory, "api.ts"),
        await generateReferences(bundle.manifest),
      );
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(bundle.manifest),
      );
      await withGeneratedApi(directory, () =>
        frontendBuild(config, env, options.cmd),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return request(config.platform, path + "release-" + operation, {
    hash: options.hash,
    expected: health.active,
    confirm: config.project,
  });
}
export const promote = (options = {}) => releaseOperation(options, "promote");
export const rollback = (options = {}) => releaseOperation(options, "rollback");
export async function releases(options = {}) {
  const config = JSON.parse(await readFile(".flare/project.json", "utf8"));
  const env = options.env ?? "dev";
  if (!["dev", "prod"].includes(env))
    throw Error("Environment must be dev or prod");
  return request(
    config.platform,
    `/api/projects/${config.project}/${env}/history`,
  );
}
