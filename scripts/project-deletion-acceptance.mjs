// Explicit real-cloud deletion proof. Only newly generated IDs are ever admitted.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildApplication } from "../packages/cli/lib/build.mjs";
import {
  createClient,
  reference,
  uploadFile,
} from "../packages/sdk/dist/client.js";
import { cleanupCloudScopes } from "./lib/cloud-cleanup.mjs";
const install = JSON.parse(
  await readFile(".private/flared-install.json", "utf8"),
);
const oauth = (
  await readFile(
    process.env.HOME + "/Library/Preferences/.wrangler/config/default.toml",
    "utf8",
  )
).match(/oauth_token\s*=\s*"([^"]+)"/)[1];
const account = `https://api.cloudflare.com/client/v4/accounts/${install.account}`;
const id = randomUUID(),
  customer = randomUUID(),
  token = randomBytes(32).toString("hex"),
  key = randomBytes(32).toString("hex");
const name = "Deletion acceptance",
  alias = "delete-proof-" + id.slice(0, 8),
  worker = "flared-delete-proof-" + id.slice(0, 8);
const dir = await mkdtemp(join(tmpdir(), worker));
const report = {
  scope: id,
  customer,
  revision: spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim(),
  startedAt: new Date().toISOString(),
  tests: [],
  status: "RUNNING",
};
let created = false,
  uploaded = false,
  deleted = false,
  url,
  client;
async function cf(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${account}/${path}`, {
    method,
    headers: {
      authorization: "Bearer " + oauth,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const x = await r.json();
  if (!x.success) throw Error(JSON.stringify(x.errors));
  return x.result;
}
const db = (sql, params = []) =>
  cf(`d1/database/${install.database}/query`, { sql, params });
async function command(env, op, body) {
  const r = await fetch(
    `${install.runtimeUrl}/control/api/projects/${id}/${env}/${op}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify({ confirm: id, ...body }) : undefined,
    },
  );
  const x = await r.json();
  assert.equal(r.status, 200, env + "/" + op + " " + JSON.stringify(x));
  return x;
}
async function operate(actor, input) {
  let r;
  for (let attempt = 0; attempt < 8; attempt++) {
    r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ actor, input }),
    });
    if (r.status !== 404) break;
    await r.body?.cancel();
    await Bun.sleep(2000);
  }
  return { status: r.status, value: await r.json() };
}
async function test(name, fn) {
  await fn();
  report.tests.push({ name, status: "PASS" });
  console.log("PASS:", name);
}
try {
  await db("INSERT INTO customers VALUES (?,?,?)", [
    customer,
    name,
    Date.now(),
  ]);
  created = true;
  await db("INSERT INTO projects VALUES (?,?,?,?)", [
    id,
    customer,
    name,
    Date.now(),
  ]);
  for (const env of ["dev", "prod"])
    await db(
      "INSERT INTO environments (projectId,env,origins) VALUES (?,?,?)",
      [id, env, "[]"],
    );
  await db("INSERT INTO credentials VALUES (?,?,?,?,0)", [
    createHash("sha256").update(token).digest("hex"),
    id,
    install.owner,
    Date.now() + 3600000,
  ]);
  await db(
    "INSERT INTO project_aliases (alias,projectId,published) VALUES (?,?,1)",
    [alias, id],
  );
  const fixture = join(
    process.cwd(),
    ".private",
    "delete-native-entry-" + id + ".ts",
  );
  await writeFile(
    fixture,
    (await readFile("tests/fixtures/native-app.ts", "utf8"))
      .replaceAll(
        "../../packages/sdk/src/",
        join(process.cwd(), "packages/sdk/dist") + "/",
      )
      .replace(
        'from "zod"',
        "from " + JSON.stringify(Bun.resolveSync("zod", process.cwd())),
      ),
  );
  await buildApplication({
    entry: fixture,
    outdir: join(dir, "release"),
  });
  const json = async (f) =>
    JSON.parse(await readFile(join(dir, "release", f), "utf8"));
  const bundle = {
    release: await json("release.json"),
    schema: await json("schema.json"),
    manifest: await json("manifest.json"),
    facet: await readFile(join(dir, "release/facet.js"), "utf8"),
    action: await readFile(join(dir, "release/action.js"), "utf8"),
  };
  for (const env of ["dev", "prod"]) {
    await command(env, "settings", { origins: [], oidc: null });
    await command(env, "deploy", { bundle });
  }
  client = createClient({ url: `${install.runtimeUrl}/p/${id}/dev` });
  await client.mutation(reference("tasks/create", "mutation"), {
    title: "Delete fixture",
  });
  await client.mutation(reference("tasks/delay", "mutation"), {
    title: "Never execute after deletion",
  });
  const blob = new Blob(["Disposable file"]),
    grant = await command("dev", "file-upload", {
      name: "delete.txt",
      type: "application/octet-stream",
      size: blob.size,
    });
  await uploadFile(grant, blob);
  const source = `import {authorizeProjectDeletion,deleteProject} from ${JSON.stringify(resolve("packages/core/src/project-deletion.ts"))};export default {async fetch(req,env){if(req.method!=="POST"||req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});try {const x=await req.json();authorizeProjectDeletion(x.actor,{id:${JSON.stringify(id)},name:${JSON.stringify(name)}},x.input);if(x.input.inspect){const scopes=${JSON.stringify([id + "/dev", id + "/prod"])};let objects=0;for(const scope of scopes){for(const prefix of ["releases/"+scope+"/","backups/"+scope+"/"])objects+=(await env.BUNDLES.list({prefix,limit:1})).objects.length;objects+=(await env.FILES.list({prefix:"files/"+scope+"/",limit:1})).objects.length;}return Response.json({objects});}const runtime={prepareDestroy:async(scope)=>{const r=await env.RUNTIME.command("prepareDestroy",[scope]);if(!r.ok)throw Error(r.code);},destroy:async(scope)=>{const r=await env.RUNTIME.command("destroy",[scope]);if(!r.ok)throw Error(r.code);}};return Response.json(await deleteProject(env.CATALOG,runtime,${JSON.stringify(id)}));}catch(e){return Response.json({error:e.code||e.message},{status:400});}}}`;
  const entry = join(dir, "proof.ts");
  await writeFile(entry, source);
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: true,
  });
  assert(built.success, String(built.logs));
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "proof.js",
      compatibility_date: "2026-10-10",
      bindings: [
        {
          type: "service",
          name: "RUNTIME",
          service: "flared-runtime",
          entrypoint: "RuntimeControl",
        },
        { type: "d1", name: "CATALOG", id: install.database },
        { type: "r2_bucket", name: "BUNDLES", bucket_name: "flared-builds" },
        { type: "r2_bucket", name: "FILES", bucket_name: "flared-files" },
        { type: "secret_text", name: "KEY", text: key },
      ],
    }),
  );
  form.set(
    "proof.js",
    new Blob([await built.outputs[0].text()], {
      type: "application/javascript+module",
    }),
    "proof.js",
  );
  const result = await (
    await fetch(`${account}/workers/scripts/${worker}`, {
      method: "PUT",
      headers: { authorization: "Bearer " + oauth },
      body: form,
    })
  ).json();
  assert(result.success, JSON.stringify(result.errors));
  uploaded = true;
  await cf(`workers/scripts/${worker}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });
  url = `https://${worker}.${(await cf("workers/subdomain")).subdomain}.workers.dev`;
  await Bun.sleep(3000);
  await test("Production authorizer rejects viewer/editor/scoped credentials and wrong confirmation", async () => {
    for (const actor of [
      { role: "viewer", projectId: null },
      { role: "editor", projectId: null },
      { role: "owner", projectId: id },
    ])
      assert.equal(
        (await operate(actor, { confirm: id, name })).value.error,
        "FORBIDDEN",
      );
    assert.equal(
      (
        await operate(
          { role: "owner", projectId: null },
          { confirm: id, name: "Wrong" },
        )
      ).value.error,
      "INVALID_CONFIRMATION",
    );
    assert.equal((await command("dev", "health")).status, "ready");
  });
  await test("Owner deletion removes both catalog environments and revokes credentials; repeated cleanup is safe", async () => {
    client.dispose();
    const input = { confirm: id, name },
      actor = { role: "owner", projectId: null };
    assert.equal((await operate(actor, input)).value.deleted, true);
    deleted = true;
    assert.equal((await operate(actor, input)).value.deleted, true);
    for (const table of ["projects", "environments", "credentials"]) {
      const rows = await db(
        `SELECT * FROM ${table} WHERE ${table === "projects" ? "id" : "projectId"}=?`,
        [id],
      );
      assert.equal(rows[0].results.length, 0);
    }
    const reservation = (
      await db("SELECT published FROM project_aliases WHERE alias=?", [alias])
    )[0].results[0];
    assert.equal(reservation.published, 0);
    for (const env of ["dev", "prod"]) {
      const r = await fetch(`${install.runtimeUrl}/p/${id}/${env}/v1/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "tasks/list", kind: "query", args: {} }),
      });
      assert(!r.ok, "Old project URL must not resurrect data");
    }
  });
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  console.error(error.stack);
  process.exitCode = 1;
  console.error(String(error));
} finally {
  client?.dispose();
  try {
    if (created && !deleted)
      await cleanupCloudScopes({
        account,
        oauth,
        scopes: [id + "/dev", id + "/prod"],
      });
    if (created) {
      for (const table of [
        "credentials",
        "environments",
        "project_aliases",
        "audit",
        "project_deletions",
      ])
        await db(`DELETE FROM ${table} WHERE projectId=?`, [id]);
      await db("DELETE FROM projects WHERE id=?", [id]);
      await db("DELETE FROM customers WHERE id=?", [customer]);
    }
    report.resourcesCleaned = true;
  } catch (error) {
    report.cleanupError = String(error);
    report.status = "FAIL";
    process.exitCode = 1;
  }
  if (uploaded) await cf(`workers/scripts/${worker}`, undefined, "DELETE");
  report.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/project-deletion-cloud-acceptance.json",
    JSON.stringify(report, null, 2),
  );
  await rm(dir, { recursive: true, force: true });
  await rm(
    join(process.cwd(), ".private", "delete-native-entry-" + id + ".ts"),
    { force: true },
  );
}
