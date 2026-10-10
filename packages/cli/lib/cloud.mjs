import { readFile, mkdir, writeFile, access, watch } from "node:fs/promises";
import { resolve, join } from "node:path";
const allowedUrl = (value) => {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw Error("Platform must be an HTTPS management URL");
  return u.href.replace(/\/$/, "");
};
async function request(platform, path, body) {
  const token = process.env.FLARED_DEPLOY_TOKEN;
  if (!token)
    throw Error(
      "Set FLARED_DEPLOY_TOKEN to a project-scoped credential from the online dashboard",
    );
  const r = await fetch(allowedUrl(platform) + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  const result = await r.json();
  if (!r.ok)
    throw Error(
      `${result.error ?? "Deployment failed"} (HTTP ${r.status}); writes are not automatically retried`,
    );
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
  await mkdir(".flared", { recursive: true });
  await writeFile(
    ".flared/project.json",
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
export async function deploy(options) {
  const config = JSON.parse(await readFile(".flared/project.json", "utf8"));
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
    migrations: JSON.parse(await read("migrations.json")),
    facet: await read("facet.js"),
    action: await read("action.js"),
  };
  return request(
    config.platform,
    `/api/projects/${config.project}/${env}/deploy`,
    { bundle, confirm: options.confirm },
  );
}
export async function dev(options) {
  if (options.env && options.env !== "dev")
    throw Error("Watch publishes only to dev; use deploy for production");
  if (!options.entry || !options.migrations)
    throw Error("Required: --entry <app.ts> --migrations <directory>");
  await access(".flared/project.json");
  const { buildApplication } = await import("./build.mjs");
  let busy = false,
    pending = false,
    timer,
    hash;
  const publish = async () => {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      const outdir = resolve(".flared/releases/" + Date.now());
      const release = await buildApplication({
        entry: options.entry,
        migrations: options.migrations,
        outdir,
      });
      if (release.hash !== hash) {
        const data = await deploy({ env: "dev", release: outdir });
        hash = release.hash;
        console.log(`Dev release ${hash}\n${data.url}`);
      }
    } catch (e) {
      console.error(e.message);
    } finally {
      busy = false;
      if (pending) {
        pending = false;
        void publish();
      }
    }
  };
  await publish();
  console.log(
    "Watching application code; backend runs in Cloudflare dev. Start your frontend with its own dev server.",
  );
  for await (const event of watch(process.cwd(), { recursive: true })) {
    const file = event.filename?.toString() ?? "";
    if (
      /(^|\/)(node_modules|\.flared|\.git|dist)(\/|$)/.test(file) ||
      !/\.(ts|tsx|js|mjs|sql|json)$/.test(file)
    )
      continue;
    clearTimeout(timer);
    timer = setTimeout(() => void publish(), 400);
  }
}
