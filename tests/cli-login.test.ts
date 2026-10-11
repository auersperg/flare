import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  constants,
} from "node:crypto";
import { describe, it, expect } from "bun:test";
import {
  publicLogin,
  loginInfo,
  approveLogin,
} from "../packages/core/src/cli-login";

function store() {
  const db = new Database(":memory:");
  db.exec(
    readFileSync(
      new URL("../packages/core/migrations/0001.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL(
        "../packages/core/migrations/0003_cli_login.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.prepare("INSERT INTO customers VALUES ('customer','Customer',0)").run();
  const project = crypto.randomUUID();
  db.prepare("INSERT INTO projects VALUES (?,'customer','Project',0)").run(
    project,
  );
  function prepare(sql: string) {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) {
        args = values;
        return statement;
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  }
  const env: any = {
    DASHBOARD_URL: "https://dashboard.example.test",
    CATALOG: {
      prepare,
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements)
            results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
  return { env, db, project };
}
const request = (operation: string, body: unknown) =>
  new Request("https://api.example.test/api/cli/" + operation, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
async function start(env: any) {
  const secret = "ab".repeat(32),
    { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
  const response = await publicLogin(
    request("start", {
      secretHash: createHash("sha256").update(secret).digest("hex"),
      publicKey: publicKey.export({ format: "jwk" }),
    }),
    env,
  );
  const session: any = await response.json();
  return { secret, privateKey, session };
}
describe("CLI browser login", () => {
  it("requires the CLI secret, encrypts the credential and allows exactly one claim", async () => {
    const { env, db, project } = store();
    const { session, secret, privateKey } = await start(env);
    expect(await loginInfo(env, session.id)).toMatchObject({
      code: session.code,
    });
    expect(
      (await publicLogin(request("poll", { id: session.id, secret }), env))
        .status,
    ).toBe(202);
    await expect(
      publicLogin(
        request("poll", { id: session.id, secret: "cd".repeat(32) }),
        env,
      ),
    ).rejects.toThrow();
    await approveLogin(
      env,
      session.id,
      project,
      "owner@example.test",
      "https://api.example.test/control",
    );
    const row: any = db.prepare("SELECT payload FROM cli_logins").get();
    expect(row.payload).not.toContain('"token"');
    const response = await publicLogin(
      request("poll", { id: session.id, secret }),
      env,
    );
    const result: any = await response.json();
    const token = privateDecrypt(
      {
        key: privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(result.encrypted, "base64"),
    ).toString();
    expect(token).toHaveLength(72);
    const credential: any = db.prepare("SELECT * FROM credentials").get();
    expect(credential.hash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(credential.projectId).toBe(project);
    await expect(
      publicLogin(request("poll", { id: session.id, secret }), env),
    ).rejects.toThrow();
    db.close();
  });
  it("expires sessions and refuses duplicate approval", async () => {
    const { env, db, project } = store();
    const { session } = await start(env);
    await approveLogin(
      env,
      session.id,
      project,
      "owner@example.test",
      "https://api.example.test/control",
    );
    await expect(
      approveLogin(
        env,
        session.id,
        project,
        "owner@example.test",
        "https://api.example.test/control",
      ),
    ).rejects.toThrow();
    expect(
      db
        .query<{ count: number }, []>("SELECT count(*) count FROM credentials")
        .get()?.count,
    ).toBe(1);
    const other = await start(env);
    db.prepare("UPDATE cli_logins SET expiresAt=0 WHERE id=?").run(
      other.session.id,
    );
    await expect(loginInfo(env, other.session.id)).rejects.toThrow();
    await expect(
      publicLogin(
        request("poll", { id: other.session.id, secret: other.secret }),
        env,
      ),
    ).rejects.toThrow();
    db.close();
  });
  it("rejects malformed input and non-POST public requests", async () => {
    const { env, db } = store();
    await expect(
      publicLogin(request("start", { secretHash: "x", publicKey: {} }), env),
    ).rejects.toThrow();
    expect(
      (
        await publicLogin(
          new Request("https://api.example.test/api/cli/start"),
          env,
        )
      ).status,
    ).toBe(405);
    db.close();
  });
});
