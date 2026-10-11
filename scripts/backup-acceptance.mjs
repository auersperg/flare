// Explicit cloud proof on disposable resources. Never reads or resets Local/test data.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApplication } from "../packages/cli/lib/build.mjs";
import {
  createClient,
  reference,
  uploadFile,
  createPasswordAuth,
} from "../packages/sdk/dist/client.js";
const install = JSON.parse(
  await readFile(".private/flared-install.json", "utf8"),
);
const auth = await readFile(
  process.env.HOME + "/Library/Preferences/.wrangler/config/default.toml",
  "utf8",
);
const oauth = auth.match(/oauth_token\s*=\s*"([^"]+)"/)[1];
const account = `https://api.cloudflare.com/client/v4/accounts/${install.account}`;
const id = randomUUID(),
  customer = randomUUID(),
  token = randomUUID() + randomUUID(),
  operatorKey = randomBytes(32).toString("hex");
const operator = "flared-backup-proof-" + id.slice(0, 8),
  dir = await mkdtemp(join(tmpdir(), "flared-backup-proof-"));
const report = {
  id,
  customer,
  tests: [],
  startedAt: new Date().toISOString(),
  scope: "disposable cloud project only",
  status: "RUNNING",
};
let operatorCreated = false,
  created = false;
const clients = [];
async function cf(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(account + "/" + path, {
    method,
    headers: {
      authorization: "Bearer " + oauth,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  if (!v.success) throw Error(JSON.stringify(v.errors));
  return v.result;
}
async function db(sql, params = []) {
  return cf(`d1/database/${install.database}/query`, { sql, params });
}
async function request(env, op, body) {
  const r = await fetch(
    `${install.runtimeUrl}/control/api/projects/${id}/${env}/${op}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify({ confirm: id, ...body }) : undefined,
    },
  );
  return { status: r.status, value: await r.json() };
}
async function command(env, op, body) {
  const r = await request(env, op, body);
  assert.equal(r.status, 200, JSON.stringify(r.value));
  return r.value;
}
async function bundle(
  entry = "tests/fixtures/native-app.ts",
  name = "release",
) {
  const out = join(dir, name);
  await buildApplication({
    entry,
    outdir: out,
  });
  const json = async (file) =>
    JSON.parse(await readFile(join(out, file), "utf8"));
  return {
    release: await json("release.json"),
    schema: await json("schema.json"),
    manifest: await json("manifest.json"),
    facet: await readFile(join(out, "facet.js"), "utf8"),
    action: await readFile(join(out, "action.js"), "utf8"),
  };
}
async function test(name, fn) {
  await fn();
  report.tests.push({ name, status: "PASS" });
  console.log("PASS:", name);
}
let operatorUrl;
async function operate(op, backup, file) {
  const r = await fetch(operatorUrl, {
    method: "POST",
    headers: {
      authorization: "Bearer " + operatorKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ op, backup, file }),
  });
  if (!r.ok)
    throw Error(
      "Operator HTTP " + r.status + " " + (await r.text()).slice(0, 400),
    );
  return r.json();
}
async function rows(env) {
  const result = [];
  let cursor;
  do {
    const data = await command(
      env,
      "data?table=tasks&limit=100" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    result.push(...data.rows);
    cursor = data.next;
  } while (cursor);
  return result;
}
try {
  await db("INSERT INTO customers VALUES (?,?,?)", [
    customer,
    "Flared backup acceptance",
    Date.now(),
  ]);
  created = true;
  await db("INSERT INTO projects VALUES (?,?,?,?)", [
    id,
    customer,
    "Backup acceptance",
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
  const source = `export default {async fetch(req,env){if(req.method!=="POST"||req.headers.get("authorization")!=="Bearer "+env.KEY)return new Response("Unauthorized",{status:401});const x=await req.json();if(["auth-configure","auth-password","auth-disable","auth-revoke","auth-users"].includes(x.op)){const r=await env.RUNTIME.command("admin",["${id}/dev",x.op,x.backup||{}]);if(!r.ok)return Response.json({error:r.code},{status:400});return Response.json(r.value);}if(x.op==="cleanup"){for(const scope of ["${id}/prod","${id}/dev"]){const r=await env.RUNTIME.command("destroy",[scope]);if(!r.ok)throw Error(r.code);}return Response.json({cleaned:true});}if(!/^[0-9a-f-]{36}$/.test(x.backup)||!/^[0-9a-f-]{36}$/.test(x.file)||!["corrupt","repair"].includes(x.op))return new Response("Invalid",{status:400});await env.BUNDLES.put("backups/${id}/dev/"+x.backup+"/files/"+x.file,x.op==="repair"?"Cloud backup bytes":"corrupt");return Response.json({done:true});}}`;
  new Bun.Transpiler({ loader: "js" }).transformSync(source);
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
        { type: "r2_bucket", name: "BUNDLES", bucket_name: "flared-builds" },
        { type: "secret_text", name: "KEY", text: operatorKey },
      ],
    }),
  );
  form.set(
    "proof.js",
    new Blob([source], { type: "application/javascript+module" }),
    "proof.js",
  );
  const uploaded = await fetch(account + "/workers/scripts/" + operator, {
    method: "PUT",
    headers: { authorization: "Bearer " + oauth },
    body: form,
  });
  const upload = await uploaded.json();
  assert(upload.success, JSON.stringify(upload.errors));
  operatorCreated = true;
  await cf(`workers/scripts/${operator}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });
  operatorUrl = `https://${operator}.${(await cf("workers/subdomain")).subdomain}.workers.dev`;
  const release = await bundle();
  for (const env of ["dev", "prod"]) {
    await command(env, "settings", {
      origins: ["http://127.0.0.1:4321"],
      oidc: null,
    });
    await command(env, "deploy", { bundle: release });
  }
  const dev = createClient({ url: install.runtimeUrl + "/p/" + id + "/dev" }),
    prod = createClient({ url: install.runtimeUrl + "/p/" + id + "/prod" });
  clients.push(dev, prod);
  for (let n = 0; n < 111; n++)
    await dev.mutation(reference("tasks/create", "mutation"), {
      title: "Backup document " + n,
    });
  const blob = new Blob(["Cloud backup bytes"], { type: "text/plain" });
  const grant = await command("dev", "file-upload", {
    name: "backup.txt",
    type: "text/plain",
    size: blob.size,
  });
  await uploadFile(grant, blob);
  const backup = randomUUID(),
    before = await rows("dev");
  await test("Backup management rejects anonymous, cross-project and unconfirmed prod requests", async () => {
    const base = install.runtimeUrl + "/control/api/projects/";
    assert.equal((await fetch(base + id + "/dev/backups")).status, 401);
    assert.equal(
      (
        await fetch(base + randomUUID() + "/dev/backups", {
          headers: { authorization: "Bearer " + token },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("prod", "backup-create", {
          id: randomUUID(),
          confirm: "wrong",
        })
      ).status,
      400,
    );
  });
  await test("Private cloud R2 backup captures 111 native documents, one file and exact backend release", async () => {
    const value = await command("dev", "backup-create", { id: backup });
    assert.equal(value.rows, 111);
    assert.equal(value.files, 1);
    assert.equal(value.hash, release.release.hash);
    report.backup = value;
    assert.equal(
      (await command("dev", "backup-create", { id: backup })).hash,
      value.hash,
    );
    assert.equal((await command("dev", "backups")).page[0].id, backup);
  });
  await test("Restore rejects an occupied target without overwriting its data", async () => {
    const doc = await prod.mutation(reference("tasks/create", "mutation"), {
      title: "Keep existing",
    });
    assert.equal(
      (
        await request("prod", "backup-restore", {
          id: backup,
          sourceEnv: "dev",
        })
      ).status,
      409,
    );
    assert.equal((await rows("prod"))[0].title, "Keep existing");
    const page = await command("prod", "data?table=tasks");
    await command("prod", "edit", {
      table: "tasks",
      operation: "delete",
      key: doc,
      expectedRevision: page.revision,
    });
  });
  await command("dev", "file-delete", { id: grant.id });
  await test("Corrupt backup files fail closed and pin the backup against deletion", async () => {
    await operate("corrupt", backup, grant.id);
    const failed = await request("prod", "backup-restore", {
      id: backup,
      sourceEnv: "dev",
    });
    assert.equal(failed.value.error, "INVALID_BACKUP");
    assert.equal((await command("prod", "health")).status, "restoring");
    await assert.rejects(
      prod.query(reference("tasks/list", "query"), {}),
      (e) => e.code === "RESTORE_IN_PROGRESS",
    );
    assert.equal(
      (await request("dev", "backup-delete", { id: backup })).status,
      409,
    );
    assert.equal(
      (await request("prod", "deploy", { bundle: release })).status,
      503,
    );
  });
  await test("Retry restores identical IDs, timestamps, file bytes and leaves origins unchanged", async () => {
    await operate("repair", backup, grant.id);
    await command("prod", "backup-restore", { id: backup, sourceEnv: "dev" });
    assert.equal(
      (
        await command("prod", "backup-restore", {
          id: backup,
          sourceEnv: "dev",
        })
      ).unchanged,
      true,
    );
    assert.deepEqual(await rows("prod"), before);
    assert.equal(
      (await command("prod", "health")).active,
      release.release.hash,
    );
    assert.deepEqual((await command("prod", "settings")).origins, [
      "http://127.0.0.1:4321",
    ]);
    const file = await command("prod", "file-download?id=" + grant.id);
    assert.equal(await (await fetch(file.url)).text(), "Cloud backup bytes");
    await prod.mutation(reference("tasks/create", "mutation"), {
      title: "Works after restore",
    });
    assert.equal((await rows("prod")).length, 112);
    await command("dev", "backup-delete", { id: backup });
    assert.equal((await command("dev", "backups")).page.length, 0);
  });
  await test("Cloud native scrypt, public registration, user context and administrator password reset", async () => {
    const url = install.runtimeUrl + "/p/" + id + "/dev",
      password = "Six73!";
    const auth = createPasswordAuth({ url }),
      client = createClient({ url, getToken: auth.getToken });
    clients.push(client);
    await operate("auth-configure", { enabled: true, registration: true });
    const user = await auth.register("acceptance-user", password);
    assert.equal((await auth.me()).id, user.id);
    assert.equal(
      await client.query(reference("lab/identity", "query"), {}),
      user.id,
    );
    assert.equal(
      await client.action(reference("lab/privateEcho", "action"), {}),
      user.id,
    );
    const frames = [],
      errors = [];
    const stop = client.onUpdate(
      reference("lab/identity", "query"),
      {},
      (v) => frames.push(v),
      (e) => errors.push(e.code),
    );
    try {
      const until = Date.now() + 15000;
      while (!frames.length && Date.now() < until) await Bun.sleep(50);
      assert.equal(frames[0], user.id);
      const r = await request("dev", "auth-password", {
        id: user.id,
        password: password + "reset",
      });
      assert.equal(r.status, 403); // Project CLI credentials cannot manage end-user passwords.
      const listed = await operate("auth-users", {});
      assert(!JSON.stringify(listed).includes("scrypt$"));
      await operate("auth-password", {
        id: user.id,
        password: password + "reset",
      });
      await assert.rejects(
        client.query(reference("lab/identity", "query"), {}),
      );
      const revokedUntil = Date.now() + 15000;
      while (!errors.length && Date.now() < revokedUntil) await Bun.sleep(50);
      assert(errors.length > 0);
      await assert.rejects(auth.login("acceptance-user", password));
      await auth.login("acceptance-user", password + "reset");
      client.refreshAuth();
      assert.equal((await auth.me()).id, user.id);
      const cross = await fetch(
        install.runtimeUrl + "/p/" + id + "/prod/v1/auth/me",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + auth.getToken(),
          },
          body: "{}",
        },
      );
      assert.equal(cross.status, 403);
      await operate("auth-disable", { id: user.id, disabled: true });
      await assert.rejects(auth.me());
    } finally {
      stop();
      client.dispose();
      await operate("auth-configure", { enabled: false, registration: false });
    }
  });
  await test("Five successful cloud builds, exact-hash promotion and rollback preserve production data", async () => {
    const entry = join(
      process.cwd(),
      ".private",
      "release-versions-" + id + ".ts",
    );
    const source = (await readFile("tests/fixtures/native-app.ts", "utf8"))
      .replaceAll(
        "../../packages/sdk/src/",
        join(process.cwd(), "packages/sdk/src") + "/",
      )
      .replace(
        'from "zod"',
        "from " + JSON.stringify(Bun.resolveSync("zod", process.cwd())),
      );
    const versions = [];
    for (let n = 1; n <= 6; n++) {
      await writeFile(
        entry,
        source.replace("let reads = 0;", "let reads = " + n + ";"),
      );
      const version = await bundle(entry, "version-" + n);
      versions.push(version);
      await command("dev", "deploy", { bundle: version });
    }
    const history = await command("dev", "history");
    assert.equal(history.length, 5);
    assert(!history.some((x) => x.hash === versions[0].release.hash));
    const before = await rows("prod"),
      current = (await command("prod", "health")).active;
    await command("prod", "release-promote", {
      hash: versions[3].release.hash,
      expected: current,
    });
    assert.equal(
      (await command("prod", "health")).active,
      versions[3].release.hash,
    );
    assert.deepEqual(await rows("prod"), before);
    assert.equal(
      (
        await request("prod", "release-promote", {
          hash: versions[4].release.hash,
          expected: current,
        })
      ).status,
      409,
    );
    await command("prod", "release-rollback", {
      hash: current,
      expected: versions[3].release.hash,
    });
    assert.deepEqual(await rows("prod"), before);
    await writeFile(
      entry,
      source.replace(
        "done: z.boolean().default(false)",
        "done: z.boolean().default(false), required: z.string()",
      ),
    );
    const invalid = await bundle(entry, "invalid-version");
    assert.notEqual(
      (await request("dev", "deploy", { bundle: invalid })).status,
      200,
    );
    assert(
      !(await command("dev", "history")).some(
        (x) => x.hash === invalid.release.hash,
      ),
    );
    assert.equal(
      (
        await request("prod", "release-promote", {
          hash: invalid.release.hash,
          expected: current,
        })
      ).status,
      404,
    );
    const details = await command(
      "dev",
      "release?hash=" + versions[3].release.hash,
    );
    assert.equal(details.release.hash, versions[3].release.hash);
  });
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
  console.error(String(error));
} finally {
  clients.forEach((c) => c.dispose());
  if (operatorCreated) {
    try {
      await operate("cleanup");
      report.resourcesCleaned = true;
    } catch (e) {
      report.cleanupError = String(e);
      process.exitCode = 1;
    }
    await cf(`workers/scripts/${operator}`, undefined, "DELETE");
  }
  if (created && (!operatorCreated || report.resourcesCleaned)) {
    for (const table of [
      "credentials",
      "environments",
      "project_aliases",
      "audit",
    ])
      await db(`DELETE FROM ${table} WHERE projectId=?`, [id]);
    await db("DELETE FROM projects WHERE id=?", [id]);
    await db("DELETE FROM customers WHERE id=?", [customer]);
  }
  report.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/backup-cloud-acceptance.json",
    JSON.stringify(report, null, 2),
  );
  await rm(dir, { recursive: true, force: true });
  await rm(join(process.cwd(), ".private", "release-versions-" + id + ".ts"), {
    force: true,
  });
  console.log("Report: artifacts/backup-cloud-acceptance.json");
}
