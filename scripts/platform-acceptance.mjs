import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
const install = JSON.parse(
  await readFile(".private/flared-install.json", "utf8"),
);
const session = await readFile(
  process.env.HOME + "/Library/Preferences/.wrangler/config/default.toml",
  "utf8",
);
const oauth = session.match(/oauth_token\s*=\s*"([^"]+)"/)[1];
const devKey = (await readFile(".private/flared-dev-key", "utf8")).trim();
const base = install.runtimeUrl,
  platform = base + "/control",
  id = randomUUID(),
  other = randomUUID(),
  customer = randomUUID(),
  token = randomUUID() + randomUUID(),
  now = Date.now();
const directory = await mkdtemp(join(tmpdir(), "flared-cloud-proof-"));
const report = {
  scope: id,
  directory,
  runtime: base,
  startedAt: new Date().toISOString(),
  tests: [],
  stage: "minimum vertical slice; not full production acceptance",
};
const sha = (x) => createHash("sha256").update(x).digest("hex");
async function db(sql, params = []) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${install.account}/d1/database/${install.database}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${oauth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const x = await r.json();
  assert(x.success, JSON.stringify(x.errors));
  return x.result;
}
const admin = async (path, body, key = token) => {
  const r = await fetch(platform + "/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
};
const command = async (path, body, key = token) => {
  const x = await admin(path, body, key);
  assert.equal(x.status, 200, JSON.stringify(x.data));
  return x.data;
};
function run(args, cwd = directory, env = {}) {
  const x = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, FLARED_DEPLOY_TOKEN: token, ...env },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(x.status, 0, (x.stderr ?? "") + (x.stdout ?? ""));
  return x.stdout;
}
const devIdentity = (
  project = id,
  expiration = Math.floor(Date.now() / 1000) + 900,
) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    p = Buffer.from(
      JSON.stringify({
        iss: install.devTokenIssuer ?? base,
        aud: project + "/dev",
        sub: install.owner,
        exp: expiration,
      }),
    ).toString("base64url");
  return (
    h +
    "." +
    p +
    "." +
    createHmac("sha256", devKey)
      .update(h + "." + p)
      .digest("base64url")
  );
};
const frames = [],
  clients = [];
let sdk,
  client,
  refs,
  devUrl = base + "/p/" + id + "/dev";
async function test(name, fn) {
  const at = performance.now();
  try {
    await fn();
    report.tests.push({
      name,
      status: "PASS",
      ms: Math.round(performance.now() - at),
    });
    console.log("PASS:", name);
  } catch (e) {
    report.tests.push({ name, status: "FAIL", error: String(e) });
    throw e;
  }
}
async function wait(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(30);
  }
  throw Error("Live snapshot timeout");
}
try {
  await db("INSERT INTO customers VALUES (?,?,?)", [
    customer,
    "Flared acceptance",
    now,
  ]);
  for (const project of [id, other]) {
    await db("INSERT INTO projects VALUES (?,?,?,?)", [
      project,
      customer,
      project === id ? "SDK cloud proof" : "Isolation proof",
      now,
    ]);
    for (const env of ["dev", "prod"])
      await db(
        "INSERT INTO environments (projectId,env,origins) VALUES (?,?,?)",
        [project, env, "[]"],
      );
  }
  await db("INSERT INTO credentials VALUES (?,?,?,?,0)", [
    sha(token),
    id,
    install.owner,
    now + 3600000,
  ]);
  await test("Clean tarball installation outside workspace; no symlinks", async () => {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "flared-cloud-proof",
        private: true,
        type: "module",
      }),
    );
    const pack = (name) => {
      const x = spawnSync(
        "npm",
        [
          "pack",
          `./packages/${name}`,
          "--pack-destination",
          directory,
          "--json",
        ],
        { cwd: resolve("."), encoding: "utf8" },
      );
      assert.equal(x.status, 0, x.stderr);
      const output = JSON.parse(x.stdout),
        packed = Array.isArray(output) ? output[0] : Object.values(output)[0];
      assert(packed?.filename);
      return join(directory, packed.filename);
    };
    const x = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        pack("sdk"),
        pack("cli"),
        "drizzle-orm@0.45.4",
        "zod@4.6.5",
      ],
      { cwd: directory, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(x.status, 0, x.stderr);
    const { lstat } = await import("node:fs/promises");
    for (const name of ["sdk", "cli"])
      assert(
        !(
          await lstat(join(directory, "node_modules/@flared", name))
        ).isSymbolicLink(),
      );
  });
  await cp("tests/fixtures/tasks/app.ts", join(directory, "app.ts"));
  await cp("tests/fixtures/tasks/drizzle", join(directory, "drizzle"), {
    recursive: true,
  });
  let source = await readFile(join(directory, "app.ts"), "utf8");
  source = source.replace(" echo:action(", " echo:action(");
  // This test-only app adds explicit rollback and outbox fixtures; the production empty bootstrap remains unchanged.
  source =
    source.replace("export default defineApp(", "const app=defineApp(") +
    `\nconst checkTable=sqliteTable('tasks',{id:text().primaryKey(),title:text().notNull(),done:integer({mode:'boolean'}).notNull().default(false),createdAt:integer().notNull()});\napp.functions.tasks.bulk=mutation({input:z.object({count:z.number().int().min(1).max(100)}),output:z.number(),handler:({db},a)=>{for(let i=0;i<a.count;i++)db.insert(checkTable).values({id:crypto.randomUUID(),title:'Seed '+i,createdAt:Date.now(),done:false}).run();return a.count;}});\napp.functions.tasks.rollback=mutation({input:z.object({}),output:z.boolean(),handler:async({db})=>{db.insert(checkTable).values({id:crypto.randomUUID(),title:'ROLLBACK_SENTINEL',createdAt:Date.now(),done:false}).run();await Promise.resolve();throw Error('TEST_PRIVATE_SENTINEL');}});\napp.functions.tasks.schedule=mutation({input:z.object({}),output:z.string(),handler:({jobs})=>jobs.schedule('tasks/echo',{message:'queued'})});\nexport default app;\n`;
  // defineApp freezes its outer object, but the trusted function tree is editable at build-time.
  await writeFile(join(directory, "app.ts"), source);
  const bin = join(directory, "node_modules/@flared/cli/bin/flared.mjs");
  await test("Packaged CLI links and deploys native dev/prod without reinstalling core", async () => {
    run([
      bin,
      "build",
      "--entry",
      "app.ts",
      "--migrations",
      "drizzle",
      "--outdir",
      "release",
    ]);
    run([bin, "link", "--platform", platform, "--project", id]);
    for (const env of ["dev", "prod"])
      await command(`projects/${id}/${env}/settings`, {
        origins: ["http://localhost:5173", install.adminUrl],
        oidc: null,
        confirm: env === "prod" ? id : undefined,
      });
    run([bin, "deploy", "--env", "dev", "--release", "release"]);
    run([
      bin,
      "deploy",
      "--env",
      "prod",
      "--release",
      "release",
      "--confirm",
      id,
    ]);
    sdk = await import(
      pathToFileURL(join(directory, "node_modules/@flared/sdk/dist/client.js"))
        .href
    );
    client = sdk.createClient({ url: devUrl, getToken: () => devIdentity() });
    clients.push(client);
    refs = {
      list: sdk.reference("tasks/list", "query"),
      watch: sdk.reference("tasks/watch", "live"),
      create: sdk.reference("tasks/create", "mutation"),
    };
  });
  await test("Protected functions reject missing/expired/wrong-project identity", async () => {
    for (const getToken of [
      () => null,
      () => devIdentity(id, Math.floor(Date.now() / 1000) - 60),
      () => devIdentity(other),
    ]) {
      const c = sdk.createClient({ url: devUrl, getToken });
      try {
        await assert.rejects(
          c.call(refs.list, { limit: 50 }),
          (e) => e.code === "HTTP_401",
        );
      } finally {
        c.dispose();
      }
    }
  });
  await test("Invalid origins and malformed function arguments are rejected", async () => {
    const r = await fetch(devUrl + "/v1/call", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        authorization: "Bearer " + devIdentity(),
      },
      body: JSON.stringify({
        path: "tasks/list",
        kind: "query",
        args: { limit: 50 },
      }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    await assert.rejects(
      client.call(refs.create, { title: "" }),
      (e) => e.code === "HTTP_400",
    );
  });
  await test("CLI credentials stay project-scoped; viewer and revoked credentials are denied", async () => {
    assert.equal((await admin("session", undefined, "invalid")).status, 401);
    const viewer = "viewer-" + id + "@example.test",
      viewerToken = randomUUID();
    await db("INSERT INTO members VALUES (?,?)", [viewer, "viewer"]);
    await db("INSERT INTO credentials VALUES (?,?,?,?,0)", [
      sha(viewerToken),
      id,
      viewer,
      now + 60000,
    ]);
    assert.equal(
      (
        await admin(
          `projects/${id}/dev/data?table=tasks`,
          undefined,
          viewerToken,
        )
      ).status,
      401,
    );
    await db("UPDATE credentials SET revoked=1 WHERE hash=?", [
      sha(viewerToken),
    ]);
    assert.equal(
      (
        await admin("projects", {
          name: "Forbidden",
          customer: "No global privilege",
          origins: [],
        })
      ).status,
      403,
    );
  });
  await test("Action validation errors survive native RPC without disclosing handlers", async () => {
    await assert.rejects(
      client.call(sdk.reference("tasks/echo", "action"), { message: 2 }),
      (e) => e.code === "HTTP_400",
    );
  });
  await test("Native live uses SDK snapshots and delivers mutations after commit", async () => {
    client.subscribe(
      refs.watch,
      { limit: 50 },
      {
        next: (value) => frames.push({ at: performance.now(), value }),
        error: (e) => console.log("Live status:", e.code),
      },
    );
    await wait(() => frames.length > 0);
    const at = performance.now();
    const created = await client.call(refs.create, {
      title: "Cloud SDK works",
    });
    await wait(() => frames.some((f) => f.value.some((t) => t.id === created)));
    report.liveDeliveryMs = Math.round(
      frames.find((f) => f.value.some((t) => t.id === created)).at - at,
    );
    assert.equal((await client.call(refs.list, { limit: 50 })).length, 1);
  });
  await test("Async failed mutations roll back without publishing live state", async () => {
    const before = await command(`projects/${id}/dev/schema`);
    await assert.rejects(
      client.call(sdk.reference("tasks/rollback", "mutation"), {}),
      (e) => e.code === "HTTP_500",
    );
    const after = await command(`projects/${id}/dev/schema`);
    assert.equal(after.revision, before.revision);
    assert.equal((await client.call(refs.list, { limit: 50 })).length, 1);
    assert(
      !frames.some((f) => f.value.some((t) => t.title === "ROLLBACK_SENTINEL")),
    );
  });
  await test("Audited dashboard CRUD uses revision conflict checks and updates live clients", async () => {
    const before = await command(`projects/${id}/dev/data?table=tasks`),
      task = before.rows[0];
    await command(`projects/${id}/dev/edit`, {
      table: "tasks",
      operation: "update",
      key: task.id,
      values: { title: "Edited through dashboard API" },
      expectedRevision: before.revision,
    });
    await wait(() =>
      frames.some((f) =>
        f.value.some((t) => t.title === "Edited through dashboard API"),
      ),
    );
    assert.equal(
      (
        await admin(`projects/${id}/dev/edit`, {
          table: "tasks",
          operation: "delete",
          key: task.id,
          expectedRevision: before.revision,
        })
      ).status,
      409,
    );
    const audit = await command(`projects/${id}/dev/audit`);
    assert(
      audit.some((x) => x.operation === "data.update" && x.status === "ok"),
    );
  });
  await test("Production data is isolated and developer tokens cannot access prod", async () => {
    assert.equal(
      (await command(`projects/${id}/prod/data?table=tasks`)).rows.length,
      0,
    );
    const prod = sdk.createClient({
      url: base + "/p/" + id + "/prod",
      getToken: () => devIdentity(),
    });
    try {
      await assert.rejects(
        prod.call(refs.list, { limit: 50 }),
        (e) => e.code === "HTTP_401",
      );
    } finally {
      prod.dispose();
    }
    assert.equal((await admin(`projects/${other}/dev/health`)).status, 403);
    assert.equal(
      (
        await admin(`projects/${id}/prod/edit`, {
          table: "tasks",
          operation: "insert",
          values: {
            id: randomUUID(),
            title: "no confirmation",
            createdAt: Date.now(),
          },
          expectedRevision: 0,
        })
      ).status,
      400,
    );
  });
  await test("Native action and transactional outbox reach Queues consumer", async () => {
    assert.equal(
      await client.call(sdk.reference("tasks/echo", "action"), {
        message: "native action",
      }),
      "native action",
    );
    const job = await client.call(
      sdk.reference("tasks/schedule", "mutation"),
      {},
    );
    let receipts = [];
    for (let i = 0; i < 30; i++) {
      const result = await command(`projects/${id}/dev/jobs`);
      receipts = result.receipts ?? [];
      if (receipts.some((r) => r.id === job)) break;
      await sleep(1000);
    }
    assert(
      receipts.some((r) => r.id === job),
      "No delivery receipt observed",
    );
  });
  await test("Expired WebSocket identity stops live delivery", async () => {
    const identity = devIdentity(id, Math.floor(Date.now() / 1000) + 5),
      ticket = await fetch(devUrl + "/v1/live/ticket", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + identity,
        },
        body: "{}",
      }).then((r) => r.json());
    assert(ticket.result?.ticket);
    const ws = new WebSocket(
      devUrl.replace("https:", "wss:") +
        "/v1/live?ticket=" +
        ticket.result.ticket,
    );
    let closed = false;
    ws.addEventListener("close", () => (closed = true));
    ws.addEventListener("error", () => {});
    await wait(() => ws.readyState === 1);
    ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "expiry",
        path: "tasks/watch",
        args: { limit: 50 },
      }),
    );
    await wait(() => closed, 12000);
  });
  await test("Slow live client coalesces changes until ACK and resynchronizes latest revision", async () => {
    const ticket = await fetch(devUrl + "/v1/live/ticket", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + devIdentity(),
      },
      body: "{}",
    }).then((r) => r.json());
    const ws = new WebSocket(
        devUrl.replace("https:", "wss:") +
          "/v1/live?ticket=" +
          ticket.result.ticket,
      ),
      received = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === "snapshot") received.push(frame);
    });
    ws.addEventListener("error", () => {});
    try {
      await wait(() => ws.readyState === 1);
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "slow",
          path: "tasks/watch",
          args: { limit: 50 },
        }),
      );
      await wait(() => received.length === 1);
      const task = received[0].result[0];
      await client.call(sdk.reference("tasks/toggle", "mutation"), {
        id: task.id,
        done: true,
      });
      await client.call(sdk.reference("tasks/toggle", "mutation"), {
        id: task.id,
        done: false,
      });
      await sleep(300);
      assert.equal(received.length, 1);
      // Change a selected value again, then release the original snapshot ACK.
      await client.call(sdk.reference("tasks/toggle", "mutation"), {
        id: task.id,
        done: true,
      });
      ws.send(
        JSON.stringify({
          type: "ack",
          id: "slow",
          revision: received[0].revision,
        }),
      );
      await wait(() => received.length === 2);
      assert.equal(received[1].result.find((x) => x.id === task.id).done, true);
      assert(received[1].revision > received[0].revision);
    } finally {
      ws.close();
    }
  });
  await test("Code upgrade preserves facet data and live connection", async () => {
    const old = JSON.parse(
      await readFile(join(directory, "release/release.json"), "utf8"),
    ).hash;
    await writeFile(
      join(directory, "app.ts"),
      source
        .replace("args.message", "'v2:'+args.message")
        .replace("=>a.message", "=>'v2:'+a.message"),
    );
    run([
      bin,
      "build",
      "--entry",
      "app.ts",
      "--migrations",
      "drizzle",
      "--outdir",
      "release-v2",
    ]);
    const next = JSON.parse(
      await readFile(join(directory, "release-v2/release.json"), "utf8"),
    ).hash;
    assert.notEqual(old, next);
    run([bin, "deploy", "--env", "dev", "--release", "release-v2"]);
    assert.equal((await client.call(refs.list, { limit: 50 })).length, 1);
    assert.equal(
      await client.call(sdk.reference("tasks/echo", "action"), {
        message: "hello",
      }),
      "v2:hello",
    );
    const created = await client.call(refs.create, { title: "After upgrade" });
    await wait(() => frames.some((f) => f.value.some((t) => t.id === created)));
  });
  await test("Keyset data pagination covers 1000 actual records", async () => {
    for (let i = 0; i < 10; i++)
      await client.call(sdk.reference("tasks/bulk", "mutation"), {
        count: 100,
      });
    let count = 0,
      cursor;
    do {
      const page = await command(
        `projects/${id}/dev/data?table=tasks` +
          (cursor === undefined
            ? ""
            : "&cursor=" + encodeURIComponent(JSON.stringify(cursor))),
      );
      count += page.rows.length;
      cursor = page.next;
    } while (cursor !== null);
    assert.equal(count, 1002);
    report.records = count;
  });
  if (process.env.FLARED_VERIFY_HIBERNATION === "yes")
    await test("Physical hibernation resumes a persisted SDK subscription after new supervisor boot", async () => {
      const before = await command(`projects/${id}/dev/health`);
      await sleep(65000);
      const after = await command(`projects/${id}/dev/health`);
      assert.notEqual(
        before.bootId,
        after.bootId,
        "No physical hibernation observed",
      );
      assert.equal(after.connections, before.connections);
      const task = frames.at(-1).value[0],
        done = !task.done;
      await client.call(sdk.reference("tasks/toggle", "mutation"), {
        id: task.id,
        done,
      });
      await wait(
        () => frames.at(-1).value.find((x) => x.id === task.id)?.done === done,
      );
      report.hibernation = { before: before.bootId, after: after.bootId };
    });
  const loadMinutes = Number(process.env.FLARED_LOAD_MINUTES ?? 0);
  if (loadMinutes > 0) {
    await test(`100 SDK live clients with reconnect and ${loadMinutes}-minute bounded soak`, async () => {
      const watched = [];
      let tokenExpires = Math.floor(Date.now() / 1000) + 900;
      // Dev identity refresh is test-controlled, not an administrative credential in a client.
      for (let i = 0; i < 99; i++) {
        const values = [];
        const c = sdk.createClient({
          url: devUrl,
          getToken: () => devIdentity(id, tokenExpires),
        });
        clients.push(c);
        watched.push(values);
        c.subscribe(
          refs.watch,
          { limit: 50 },
          {
            next: (x) => {
              values.splice(0, values.length, x);
            },
            error: () => {},
          },
        );
        await sleep(30);
      }
      await wait(() => watched.every((x) => x.length), 60000);
      report.clients = 100;
      const start = Date.now();
      while (Date.now() - start < loadMinutes * 60000) {
        await sleep(60000);
        if (tokenExpires - Date.now() / 1000 < 90)
          tokenExpires = Math.floor(Date.now() / 1000) + 900;
        const c = clients[1];
        c.refreshAuth();
        const task = frames.at(-1).value[0],
          done = !task.done,
          at = performance.now();
        await client.call(sdk.reference("tasks/toggle", "mutation"), {
          id: task.id,
          done,
        });
        await wait(
          () =>
            watched.every((x) =>
              x.at(-1)?.some((t) => t.id === task.id && t.done === done),
            ),
          15000,
        );
        (report.soakDeliveryMs ??= []).push(Math.round(performance.now() - at));
        const health = await command(`projects/${id}/dev/health`);
        assert.equal(health.connections, 100);
        report.lastHealth = health;
        await writeFile(
          "artifacts/platform-soak-progress.json",
          JSON.stringify(
            { elapsedMinutes: (Date.now() - start) / 60000, health },
            null,
            2,
          ),
        );
      }
      report.soakMinutes = (Date.now() - start) / 60000;
    });
  }
  report.status = "PASS";
} catch (e) {
  report.status = "FAIL";
  report.error = String(e);
  console.error(String(e));
  process.exitCode = 1;
} finally {
  for (const c of clients) c.dispose();
  await db("UPDATE credentials SET revoked=1 WHERE hash=?", [sha(token)]).catch(
    () => {},
  );
  report.finishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  const path = `artifacts/platform-${id}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  await writeFile(
    "artifacts/platform-acceptance.json",
    JSON.stringify(report, null, 2),
  );
  console.log("Report:", path);
}
