// Explicit, disposable cloud proof. Never runs in verify/CI or against an existing installation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CloudflareAccount,
  cloudflareToken,
} from "../packages/flare/src/cli/cloudflare-account.mjs";
import { platform } from "../packages/flare/src/cli/platform.mjs";
import {
  InstallationStore,
  validateState,
  configurationDigest,
} from "../packages/flare/src/cli/platform-state.mjs";
import {
  loadPlatformRelease,
  sha256,
} from "../packages/flare/src/cli/platform-release.mjs";

async function inventory(cf) {
  const [workers, databases, queues, r2, apps, domains, subdomain, namespaces] =
    await Promise.all([
      cf.list("workers/scripts"),
      cf.list("d1/database"),
      cf.list("queues"),
      cf.api("r2/buckets?per_page=1000"),
      cf.list("access/apps"),
      cf.list("workers/domains"),
      cf.api("workers/subdomain"),
      cf.list("workers/durable_objects/namespaces"),
    ]);
  // Refuse an incomplete baseline instead of claiming untouched resources from a partial list.
  if (!Array.isArray(r2.buckets) || r2.buckets.length >= 1000)
    throw Error("Disposable cloud proof requires a bounded R2 inventory");
  const fingerprint = (rows, key) =>
    rows
      .map((row) => ({ id: row[key], digest: configurationDigest(row) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return {
    workers: fingerprint(workers, "id"),
    databases: fingerprint(databases, "uuid"),
    queues: fingerprint(queues, "queue_id"),
    buckets: fingerprint(r2.buckets, "name"),
    apps: fingerprint(apps, "id"),
    domains: fingerprint(domains, "id"),
    subdomain,
    namespaces: fingerprint(namespaces, "id"),
  };
}

export async function initializeDisposableCanary(
  cf,
  state,
  release,
  project,
  scratch,
) {
  validateState(state, cf.account, state.name);
  assert.match(state.name, /^proof-[a-f0-9]{8}$/);
  assert.match(project, /^[a-f0-9-]{36}$/);
  const name =
    state.workers.runtime.name.replace(/-runtime$/, "-canary-") +
    project.slice(0, 8);
  assert.ok(
    !(await cf.list("workers/scripts")).some((w) => w.id === name),
    "Canary helper already exists; no implicit replacement",
  );
  const bootstrap = join(release.directory, "dashboard/bootstrap");
  const bundle = {};
  for (const part of ["release", "manifest", "schema", "facet", "action"]) {
    const json = ["release", "manifest", "schema"].includes(part);
    const value = await readFile(
      join(bootstrap, `${part}.${json ? "json" : "js"}`),
      "utf8",
    );
    bundle[part] = json ? JSON.parse(value) : value;
  }
  const key = randomUUID() + randomUUID();
  const main = join(scratch, "canary-bootstrap.mjs"),
    config = join(scratch, "canary-bootstrap.json"),
    secretsFile = join(scratch, "canary-secrets.json");
  // Only the two newly seeded scopes are compiled in. No arbitrary RPC or owner identity.
  await writeFile(
    main,
    `const bundle=${JSON.stringify(bundle)};const scopes=${JSON.stringify([project + "/dev", project + "/prod"])};
  export default {async fetch(req,env){if(req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});if(req.method==="GET")return Response.json({ready:${JSON.stringify(state.id)}},{headers:{"cache-control":"no-store"}});if(req.method!=="POST")return new Response("Method",{status:405});const rpc=async(op,args)=>{const r=await env.RUNTIME.command(op,args);if(!r.ok)throw Error(r.code);return r.value};for(const scope of scopes){await rpc("configure",[{scope,origins:[],oidc:null}]);const health=await rpc("admin",[scope,"health",{}]);if(health.active)throw Error("Refusing to replace initialized canary");await rpc("admin",[scope,"auth-configure",{enabled:true,registration:true}]);await rpc("deploy",[scope,bundle]);}return Response.json({initialized:true,developerToken:await rpc("devIdentity",[scopes[0],"canary@example.test"])})}};`,
  );
  await writeFile(
    config,
    JSON.stringify({
      name,
      account_id: state.account,
      main,
      compatibility_date: release.manifest.compatibilityDate,
      workers_dev: true,
      preview_urls: false,
      services: [
        {
          binding: "RUNTIME",
          service: state.workers.runtime.name,
          entrypoint: "RuntimeControl",
        },
      ],
    }),
    { mode: 0o600 },
  );
  await writeFile(secretsFile, JSON.stringify({ KEY: key }), { mode: 0o600 });
  try {
    await cf.deploy(config, {
      tag: "disposable-canary",
      message: `Flare disposable canary ${state.id}`,
      cwd: scratch,
      secretsFile,
    });
    const url = `https://${name}.${state.addresses.subdomain}.workers.dev`;
    let consecutive = 0;
    for (let attempt = 0; attempt < 30 && consecutive < 3; attempt++) {
      // Probe the exact URL used by POST, not a different query/cache key.
      const r = await fetch(url, {
        headers: {
          authorization: "Bearer " + key,
          "cache-control": "no-cache",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      const result = await r.json().catch(() => null);
      consecutive = r.ok && result?.ready === state.id ? consecutive + 1 : 0;
      await sleep(2000);
    }
    assert.equal(consecutive, 3, "Canary bootstrap route did not propagate");
    // Fresh workers.dev routes can reach different edges for GET and POST.
    // Wait for verified code propagation; never retry the mutating bootstrap.
    await sleep(4000);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + key },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(
      response.status,
      200,
      "Canary bootstrap RPC failed; no automatic write retry",
    );
    const initialized = await response.json();
    assert.equal(initialized.initialized, true);
    return { developerToken: initialized.developerToken };
  } finally {
    if ((await cf.list("workers/scripts")).some((w) => w.id === name))
      await cf.api(`workers/scripts/${name}?force=true`, undefined, "DELETE");
    await rm(secretsFile, { force: true });
  }
}

export async function cleanupDisposableInstallation(cf, state, baseline) {
  validateState(state, cf.account, state.name);
  assert.match(state.name, /^proof-[a-f0-9]{8}$/);
  const prefix = `flare-${state.name}-${state.id.replaceAll("-", "").slice(0, 12)}`;
  assert.equal(state.resources.catalog.name, `flare-${state.name}-catalog`);
  for (const role of ["admin", "runtime"])
    assert.equal(state.workers[role].name, `${prefix}-${role}`);
  for (const key of ["bundles", "files", "jobs", "dlq"])
    assert.equal(state.resources[key].name, `${prefix}-${key}`);
  const workers = await cf.list("workers/scripts");
  const ownWorkers = Object.values(state.workers).map((w) => w.name);
  // Never force-delete a disposable Worker if another installation has bound it.
  for (const worker of workers.filter((w) => !ownWorkers.includes(w.id))) {
    const settings = await cf.api(`workers/scripts/${worker.id}/settings`);
    assert.ok(
      !settings.bindings?.some(
        (b) => b.type === "service" && ownWorkers.includes(b.service),
      ),
      "Another Worker depends on the disposable installation; cleanup stopped",
    );
  }
  const queues = await cf.list("queues");
  for (const key of ["jobs", "dlq"]) {
    const resource = state.resources[key];
    if (!resource.id) continue;
    const queue = queues.find((q) => q.queue_id === resource.id);
    if (!queue) continue;
    assert.equal(queue.queue_name, resource.name);
    assert.ok(!baseline.queues.some((q) => q.id === resource.id));
    const consumers = await cf.api(`queues/${resource.id}/consumers`);
    for (const consumer of consumers) {
      assert.equal(consumer.type, "worker");
      // The live REST response currently uses `script`, while OpenAPI uses
      // `script_name`. Accept either spelling, never a different consumer.
      assert.equal(
        consumer.script ?? consumer.script_name,
        state.workers.runtime.name,
        "Unexpected disposable queue consumer; cleanup stopped",
      );
      await cf.api(
        `queues/${resource.id}/consumers/${consumer.consumer_id}`,
        undefined,
        "DELETE",
      );
    }
  }
  for (const name of ownWorkers) {
    assert.ok(!baseline.workers.some((w) => w.id === name));
    if (workers.some((w) => w.id === name))
      await cf.api(`workers/scripts/${name}?force=true`, undefined, "DELETE");
  }
  if (state.access) {
    const app = await cf.api(`access/apps/${state.access.id}`);
    assert.equal(app.name, `Flare ${state.id}`);
    assert.equal(app.domain, state.addresses.adminHost);
    assert.equal(app.aud, state.access.aud);
    assert.ok(!baseline.apps.some((a) => a.id === app.id));
    await cf.api(`access/apps/${app.id}`, undefined, "DELETE");
  }
  for (const key of ["jobs", "dlq"]) {
    const resource = state.resources[key];
    if (resource.id && queues.some((q) => q.queue_id === resource.id))
      await cf.api(`queues/${resource.id}`, undefined, "DELETE");
  }
  const r2 = await cf.api("r2/buckets?per_page=1000");
  for (const key of ["bundles", "files"]) {
    const resource = state.resources[key];
    if (!resource.id || !r2.buckets.some((b) => b.name === resource.name))
      continue;
    assert.ok(!baseline.buckets.some((b) => b.id === resource.name));
    const objects = await cf.request(
      `r2/buckets/${resource.name}/objects?per_page=1000`,
    );
    assert.ok(
      Array.isArray(objects.result) && !objects.result_info?.is_truncated,
      "Disposable bucket exceeds proof cleanup limit; cleanup stopped",
    );
    for (const object of objects.result) {
      assert.equal(typeof object.key, "string");
      await cf.api(
        `r2/buckets/${resource.name}/objects/${encodeURIComponent(object.key)}`,
        undefined,
        "DELETE",
      );
    }
    await cf.api(`r2/buckets/${resource.name}`, undefined, "DELETE");
  }
  const databases = await cf.list("d1/database");
  const database = databases.find((d) => d.uuid === state.resources.catalog.id);
  if (database) {
    assert.equal(database.name, state.resources.catalog.name);
    assert.ok(!baseline.databases.some((d) => d.id === database.uuid));
    await cf.api(`d1/database/${database.uuid}`, undefined, "DELETE");
  }
}

export async function runLifecycleCloudAcceptance(options, dependencies = {}) {
  if (
    !/^[a-f0-9]{32}$/.test(options.account ?? "") ||
    options.confirm !== options.account ||
    !options.owner
  )
    throw Error(
      "Required: --account ACCOUNT_ID --owner EMAIL --confirm ACCOUNT_ID. This creates and deletes one new disposable installation; never an existing installation.",
    );
  const cf =
    dependencies.cf ??
    new CloudflareAccount(options.account, await cloudflareToken());
  assert.equal(cf.account, options.account);
  const scratch = await mkdtemp(join(tmpdir(), "flare-lifecycle-cloud-"));
  const name = `proof-${randomUUID().slice(0, 8)}`;
  const local = join(scratch, "configuration", "platform");
  const storeOptions = { directory: local };
  const reportPath = resolve(
    options.report ?? "artifacts/platform-lifecycle-cloud-acceptance.json",
  );
  const report = {
    account: options.account,
    name,
    startedAt: new Date().toISOString(),
    tests: [],
    authorization:
      dependencies.authorization ??
      "Cloudflare account token / supported Wrangler auth",
    ownerLogin:
      "NOT_TESTED: sign-in requires the owner; no Access identity is impersonated",
    crossVersionUpdate:
      "NOT_TESTED: no cross-version update completed; provide --from-archive to exercise a declared transition",
    cleanup: "PENDING",
    status: "RUNNING",
    sourceRevision: spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim(),
    sourceState:
      "Working-tree candidate; not an npm publication or production rollout",
  };
  let baseline,
    release,
    targetRelease,
    state,
    client,
    devClient,
    passwordAuth,
    failure;
  let needsCleanup = false;
  const run = (args, env = {}, cwd = scratch) => {
    const result = spawnSync(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 180000,
    });
    // Subprocess output may contain credentials. Keep acceptance diagnostics bounded and secret-free.
    if (result.status !== 0) {
      // Private scratch is retained only if cleanup fails; never print this file or credentials.
      // Useful for local investigation of a failing gate, not a public report artifact.
      const detail = JSON.stringify({
        arguments: args,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      writeFileSync(join(scratch, "subprocess-failure.json"), detail, {
        mode: 0o600,
      });
      throw Error(
        `Acceptance subprocess ${args[0]} failed (${result.status ?? "timeout"}); no credential-bearing output printed`,
      );
    }
    return result.stdout.trim();
  };
  const test = async (title, work) => {
    try {
      await work();
    } catch (error) {
      report.tests.push({ title, status: "FAIL" });
      await saveReport();
      throw error;
    }
    report.tests.push({ title, status: "PASS" });
    console.log(`PASS: ${title}`);
    await saveReport();
  };
  const saveReport = async () => {
    await mkdir(join(reportPath, ".."), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  };
  try {
    baseline = await inventory(cf);
    report.baselineDigest = configurationDigest(baseline);
    await writeFile(join(scratch, "baseline.json"), JSON.stringify(baseline), {
      mode: 0o600,
    });
    report.recoveryDirectory = scratch;
    await saveReport();
    await test("Install immutable npm archive outside the repository", async () => {
      const result = options.archive
        ? null
        : spawnSync(
            process.execPath,
            [
              "pm",
              "pack",
              "--quiet",
              "--ignore-scripts",
              "--destination",
              scratch,
            ],
            {
              cwd: resolve("packages/flare"),
              encoding: "utf8",
              timeout: 120000,
            },
          );
      if (result)
        assert.equal(result.status, 0, "Unable to pack the built release");
      const archive = options.archive
        ? resolve(options.archive)
        : resolve("packages/flare", result.stdout.trim());
      let initialArchive = archive;
      if (options["from-archive"]) {
        initialArchive = resolve(options["from-archive"]);
        const targetDir = join(scratch, "target");
        await mkdir(targetDir);
        await writeFile(
          join(targetDir, "package.json"),
          JSON.stringify({
            name: "flare-upgrade-target",
            private: true,
            type: "module",
            dependencies: { "@auersperg/flare": `file:${archive}` },
          }),
        );
        run(["install", "--ignore-scripts"], {}, targetDir);
        targetRelease = await loadPlatformRelease(
          join(targetDir, "node_modules/@auersperg/flare/dist/platform"),
        );
        report.fromArchiveSha256 = sha256(await readFile(initialArchive));
      }
      report.archiveSha256 = sha256(await readFile(archive));
      await writeFile(
        join(scratch, "package.json"),
        JSON.stringify({
          name: "flare-disposable-proof",
          private: true,
          type: "module",
          dependencies: { "@auersperg/flare": `file:${initialArchive}` },
        }),
      );
      run(["install", "--ignore-scripts"]);
      assert.equal(
        (
          await lstat(join(scratch, "node_modules/@auersperg/flare"))
        ).isSymbolicLink(),
        false,
      );
      release = await loadPlatformRelease(
        join(scratch, "node_modules/@auersperg/flare/dist/platform"),
      );
      if (targetRelease) {
        assert.notEqual(
          targetRelease.manifest.version,
          release.manifest.version,
        );
        assert.ok(
          targetRelease.manifest.upgradeFrom.includes(release.manifest.version),
          "Upgrade source was not declared",
        );
        report.targetVersion = targetRelease.manifest.version;
        report.targetPayloadDigest = targetRelease.manifest.digest;
      }
      report.version = release.manifest.version;
      report.payloadDigest = release.manifest.digest;
    });
    const deps = {
      cf,
      release,
      storeOptions,
      log: (message) => {
        if (message.startsWith("Flare platform:")) console.log(message);
      },
    };
    const install = () =>
      platform(
        {
          operation: "install",
          account: options.account,
          owner: options.owner,
          name,
          confirm: options.confirm,
        },
        deps,
      );
    await test("Read-only install plan has no resources or local checkpoint", async () => {
      const plan = await platform(
        {
          operation: "install",
          account: options.account,
          owner: options.owner,
          name,
          "dry-run": true,
        },
        deps,
      );
      assert.equal(plan.to, release.manifest.version);
      await assert.rejects(
        readFile(join(local, `${options.account}-${name}.json`)),
        { code: "ENOENT" },
      );
      assert.deepEqual(await inventory(cf), baseline);
    });
    await test("Resume final Runtime deployment after a deliberately lost acknowledgement", async () => {
      const deploy = cf.deploy.bind(cf);
      let lost = false;
      cf.deploy = async (...args) => {
        await deploy(...args);
        if (!lost && args[1].tag.includes("-runtime-")) {
          lost = true;
          throw Error("Injected final Runtime acknowledgement loss");
        }
      };
      try {
        needsCleanup = true;
        await assert.rejects(
          install(),
          /Injected final Runtime acknowledgement loss/,
        );
        const interrupted = await platform(
          { operation: "status", account: options.account, name },
          deps,
        );
        assert.equal(interrupted.status, "incomplete");
        assert.equal(interrupted.operation.phase, "runtime");
        const before = await new InstallationStore(
          cf,
          name,
          storeOptions,
        ).discover();
        const version = await cf.currentVersion(
          before.state.workers.runtime.name,
        );
        const result = await install();
        assert.equal(result.status, "installed");
        state = (await new InstallationStore(cf, name, storeOptions).discover())
          .state;
        assert.equal(
          state.versions.runtime,
          version,
          "Recovery redeployed an acknowledged remote version",
        );
        report.installationId = state.id;
        report.workers = Object.values(state.workers).map((w) => w.name);
      } finally {
        cf.deploy = deploy;
      }
    });
    await test("Application deploy and native SQLite canary through the installed CLI/SDK", async () => {
      const project = randomUUID(),
        customer = randomUUID(),
        token = randomUUID() + randomUUID(),
        now = Date.now();
      const db = (sql, params) =>
        cf.sql(state.resources.catalog.id, sql, params);
      await db("INSERT INTO customers VALUES (?,?,?)", [
        customer,
        "Disposable lifecycle canary",
        now,
      ]);
      await db("INSERT INTO projects VALUES (?,?,?,?)", [
        project,
        customer,
        "Lifecycle canary",
        now,
      ]);
      for (const env of ["dev", "prod"])
        await db(
          "INSERT INTO environments(projectId,env,origins) VALUES(?,?,?)",
          [project, env, "[]"],
        );
      await db("INSERT INTO credentials VALUES (?,?,?,?,0)", [
        sha256(Buffer.from(token)),
        project,
        state.owner,
        now + 3600000,
      ]);
      // D1 seeding bypasses dashboard project creation. Reproduce only its
      // empty backend bootstrap through a temporary scoped RPC helper; this
      // is explicitly not a browser/Access login proof.
      const { developerToken } = await initializeDisposableCanary(
        cf,
        state,
        release,
        project,
        scratch,
      );
      await writeFile(
        join(scratch, "app.ts"),
        await readFile("tests/fixtures/platform-canary.ts"),
      );
      const bin = join(
        scratch,
        "node_modules/@auersperg/flare/dist/cli/flare.js",
      );
      const env = { FLARE_DEPLOY_TOKEN: token };
      run([bin, "build", "--entry", "app.ts", "--outdir", "release"], env);
      run(
        [
          bin,
          "link",
          "--platform",
          `https://${state.addresses.runtimeHost}/control`,
          "--project",
          project,
        ],
        env,
      );
      run(
        [
          bin,
          "deploy",
          "--env",
          "prod",
          "--release",
          "release",
          "--confirm",
          project,
        ],
        env,
      );
      run([bin, "deploy", "--env", "dev", "--release", "release"], env);
      const sdk = await import(
        pathToFileURL(
          join(scratch, "node_modules/@auersperg/flare/dist/sdk/client.js"),
        ).href
      );
      client = sdk.createClient({
        url: `https://${state.addresses.runtimeHost}/p/${project}/prod`,
      });
      const create = sdk.reference("tasks/create", "mutation"),
        list = sdk.reference("tasks/list", "query");
      await assert.rejects(
        client.query(sdk.reference("tasks/privateList", "query"), {
          limit: 50,
        }),
        (error) => error.code === "UNAUTHORIZED",
      );
      const id = await client.mutation(create, {
        title: "Retain lifecycle canary",
      });
      assert.ok(
        (await client.query(list, { limit: 50 })).some((r) => r._id === id),
      );
      report.applicationCanary = { project, environment: "prod", id };
      devClient = sdk.createClient({
        url: `https://${state.addresses.runtimeHost}/p/${project}/dev`,
        getToken: () => developerToken,
      });
      await devClient.query(sdk.reference("tasks/privateList", "query"), {
        limit: 50,
      });
      passwordAuth = sdk.createPasswordAuth({
        url: `https://${state.addresses.runtimeHost}/p/${project}/prod`,
      });
      const appUser = await passwordAuth.register(
        "canary-user",
        randomUUID() + "!aA7",
      );
      assert.equal((await passwordAuth.me()).id, appUser.id);
      const management = async (operation, body) => {
        const response = await fetch(
          `https://${state.addresses.runtimeHost}/control/api/projects/${project}/prod/${operation}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
            },
            body:
              body === undefined
                ? undefined
                : JSON.stringify({ ...body, confirm: project }),
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          },
        );
        assert.equal(
          response.status,
          200,
          `Canary management ${operation} failed`,
        );
        return response.json();
      };
      const fileBytes = "Retain lifecycle file";
      const blob = new Blob([fileBytes], { type: "text/plain" });
      const grant = await management("file-upload", {
        name: "canary.txt",
        type: "text/plain",
        size: blob.size,
      });
      const uploaded = await sdk.uploadFile(grant, blob);
      const job = await client.mutation(
        sdk.reference("tasks/schedule", "mutation"),
        {},
      );
      const appBefore = await management("health");
      const resourceIdentities = JSON.stringify(state.resources),
        accessBefore = JSON.stringify(
          await cf.api(`access/apps/${state.access.id}`),
        );

      const versions = { ...state.versions },
        namespace = state.supervisorNamespace;
      const updateDeps = targetRelease
        ? { ...deps, release: targetRelease }
        : deps;
      if (targetRelease) {
        const plan = await platform(
          {
            operation: "update",
            account: options.account,
            name,
            "dry-run": true,
          },
          updateDeps,
        );
        assert.equal(plan.from, release.manifest.version);
        assert.equal(plan.to, targetRelease.manifest.version);
      }
      const result = await platform(
        {
          operation: "update",
          account: options.account,
          name,
          confirm: options.confirm,
        },
        updateDeps,
      );
      assert.equal(result.unchanged, targetRelease ? undefined : true);
      state = (await new InstallationStore(cf, name, storeOptions).discover())
        .state;
      if (targetRelease) {
        assert.notEqual(state.versions.runtime, versions.runtime);
        assert.notEqual(state.versions.admin, versions.admin);
        assert.equal(state.installed.version, targetRelease.manifest.version);
        report.crossVersionUpdate = {
          status: "PASS",
          from: release.manifest.version,
          to: targetRelease.manifest.version,
        };
      } else assert.deepEqual(state.versions, versions);
      assert.equal(state.supervisorNamespace, namespace);
      assert.equal(JSON.stringify(state.resources), resourceIdentities);
      assert.equal(
        JSON.stringify(await cf.api(`access/apps/${state.access.id}`)),
        accessBefore,
      );
      assert.equal((await management("health")).active, appBefore.active);
      await devClient.query(sdk.reference("tasks/privateList", "query"), {
        limit: 50,
      });
      assert.equal((await passwordAuth.me()).id, appUser.id);
      const fileGrant = await management(`file-download?id=${uploaded.id}`);
      assert.equal(
        await (await fetch(fileGrant.url, { redirect: "error" })).text(),
        fileBytes,
      );
      assert.ok((await management("jobs")).pending.some((j) => j.id === job));
      report.preservation = {
        data: true,
        namespace: true,
        resources: true,
        appRelease: true,
        accessPolicy: true,
        signingKey: true,
        passwordSession: true,
        file: true,
        pendingJob: true,
      };
      assert.ok(
        (await client.query(list, { limit: 50 })).some((r) => r._id === id),
      );
    });
    if (dependencies.productionAcceptance) {
      await test("Production workload, scoped recovery and external compiled CLI", async () => {
        report.production = await dependencies.productionAcceptance({
          cf,
          state,
          release: targetRelease ?? release,
          scratch,
          run,
          configurationHome: join(scratch, "configuration"),
          initialize: initializeDisposableCanary,
          packageDirectory: targetRelease
            ? join(scratch, "target/node_modules/@auersperg/flare")
            : join(scratch, "node_modules/@auersperg/flare"),
        });
      });
    }
    await test("Discover installation from D1 without the local cache", async () => {
      await rm(local, { recursive: true, force: true });
      const result = await platform(
        { operation: "status", account: options.account, name },
        deps,
      );
      assert.equal(result.id, state.id);
      assert.equal(result.status, "installed");
    });
    if (dependencies.verifyOwnerLogin) {
      await test("Owner Access sign-in", () =>
        dependencies.verifyOwnerLogin(state));
      report.ownerLogin = "PASS";
    }
    report.status = "PASS";
  } catch (error) {
    failure = error;
    report.status = "FAIL";
    report.error = error.message.slice(0, 1000);
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? ""))
      report.errorCode = error.code;
  } finally {
    client?.dispose();
    devClient?.dispose();
    passwordAuth?.dispose();
    // Preserve secret-free hook evidence even when it throws and scratch cleanup succeeds.
    if (dependencies.productionAcceptance) {
      try {
        report.production = JSON.parse(
          await readFile(join(scratch, "production-acceptance.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          failure ??= error;
          report.status = "FAIL";
          report.error = "Unable to preserve production acceptance evidence";
        }
      }
    }
    if (baseline && needsCleanup) {
      try {
        state ??= (
          await new InstallationStore(cf, name, storeOptions).discover()
        ).state;
        if (state) await cleanupDisposableInstallation(cf, state, baseline);
        const after = await inventory(cf);
        report.finalInventoryDigest = configurationDigest(after);
        assert.deepEqual(
          after,
          baseline,
          "Account baseline differs after disposable cleanup",
        );
        report.cleanup = "PASS";
        report.tests.push({
          title:
            "Remove only disposable resources and compare original account inventory",
          status: "PASS",
        });
      } catch (error) {
        report.cleanup = "FAIL";
        report.cleanupError = error.message.slice(0, 1000);
        failure ??= error;
        report.status = "FAIL";
      }
    } else report.cleanup = "NO_WRITES";
    report.finishedAt = new Date().toISOString();
    await saveReport();
    if (report.cleanup === "PASS" || report.cleanup === "NO_WRITES")
      await rm(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(
    `PASS: disposable platform lifecycle ${report.version}; cleanup verified; see the report for cross-version update and owner login status`,
  );
  return report;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      account: { type: "string" },
      owner: { type: "string" },
      confirm: { type: "string" },
      report: { type: "string" },
      "from-archive": { type: "string" },
      archive: { type: "string" },
      production: { type: "boolean", default: false },
    },
    strict: true,
  });
  await runLifecycleCloudAcceptance(
    values,
    values.production
      ? {
          productionAcceptance: (await import("./production-acceptance.mjs"))
            .productionAcceptance,
        }
      : {},
  );
}
