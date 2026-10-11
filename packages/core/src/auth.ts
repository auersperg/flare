import { Buffer } from "node:buffer";
import { scrypt, timingSafeEqual } from "node:crypto";
import { fail, digest } from "./security.js";
import type { Auth } from "../../flare/src/sdk/protocol.js";

export type AuthBackupUser = {
  id: string;
  login: string;
  password: string;
  disabled: number;
  createdAt: number;
};
export function validateAuthBackup(
  users: unknown,
): asserts users is AuthBackupUser[] {
  if (!Array.isArray(users) || users.length > 10000) fail("INVALID_BACKUP");
  const ids = new Set(),
    logins = new Set();
  for (const user of users) {
    if (
      !user ||
      !/^[a-f0-9-]{36}$/.test(user.id) ||
      loginName(user.login) !== user.login ||
      !/^scrypt\$16384\$8\$5\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(
        user.password,
      ) ||
      ![0, 1].includes(user.disabled) ||
      !Number.isSafeInteger(user.createdAt) ||
      user.createdAt < 0 ||
      ids.has(user.id) ||
      logins.has(user.login)
    )
      fail("INVALID_BACKUP");
    ids.add(user.id);
    logins.add(user.login);
  }
}
const ttl = 12 * 60 * 60 * 1000;
const kdf = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const dummySalt = "00000000000000000000000000000000";
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, kdf, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
}
export function loginName(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.@+-]{2,127}$/.test(login)) fail("INVALID_INPUT");
  return login;
}
function passwordValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 6 || value.length > 128)
    fail("INVALID_PASSWORD");
  return value;
}
export async function hashPassword(value: unknown): Promise<string> {
  const password = passwordValue(value);
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "hex",
  );
  return `scrypt$16384$8$5$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(
  password: unknown,
  hash?: string,
): Promise<boolean> {
  if (typeof password !== "string" || password.length > 128)
    fail("INVALID_INPUT");
  const parts = hash?.split("$");
  const valid =
    parts?.length === 6 &&
    parts.slice(0, 4).join("$") === "scrypt$16384$8$5" &&
    /^[a-f0-9]{32}$/.test(parts[4]) &&
    /^[a-f0-9]{64}$/.test(parts[5]);
  const result = await derive(password, valid ? parts![4] : dummySalt);
  return !!valid && timingSafeEqual(result, Buffer.from(parts![5], "hex"));
}
/** Platform-only SQLite, not app facet tables. No method exports credential material. */
export class PasswordAuth {
  constructor(
    private storage: DurableObjectStorage,
    private scope: string,
    private issuer: string,
  ) {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS auth_users (id TEXT PRIMARY KEY,login TEXT UNIQUE NOT NULL,password TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY,userId TEXT NOT NULL,expires INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(userId)",
      "CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires)",
      "CREATE TABLE IF NOT EXISTS auth_config (id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,registration INTEGER NOT NULL DEFAULT 0)",
      "INSERT OR IGNORE INTO auth_config VALUES (1,0,0)",
      "CREATE TABLE IF NOT EXISTS auth_limits (id TEXT PRIMARY KEY,at INTEGER NOT NULL,count INTEGER NOT NULL)",
    ])
      storage.sql.exec(sql);
  }
  // Private backup capsule only; this is never exposed through auth/admin endpoints.
  backupUsers(): AuthBackupUser[] {
    return this.storage.sql
      .exec(
        "SELECT id,login,password,disabled,createdAt FROM auth_users ORDER BY id",
      )
      .toArray()
      .map((r) => ({
        id: String(r.id),
        login: String(r.login),
        password: String(r.password),
        disabled: Number(r.disabled),
        createdAt: Number(r.createdAt),
      }));
  }
  hasUsers() {
    return !!this.storage.sql.exec("SELECT 1 FROM auth_users LIMIT 1").toArray()
      .length;
  }
  restoreUsers(users: AuthBackupUser[]) {
    validateAuthBackup(users);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM auth_sessions");
      this.storage.sql.exec("DELETE FROM auth_users");
      for (const u of users)
        this.storage.sql.exec(
          "INSERT INTO auth_users VALUES (?,?,?,?,?)",
          u.id,
          u.login,
          u.password,
          u.disabled,
          u.createdAt,
        );
    });
  }
  settings() {
    const row = this.storage.sql
      .exec("SELECT enabled,registration FROM auth_config WHERE id=1")
      .one();
    return {
      enabled: !!row.enabled,
      registration: !!row.registration,
      passwordMinLength: 6,
      sessionHours: 12,
    };
  }
  private limit(key: string, maximum: number) {
    const now = Date.now();
    const row = this.storage.sql
      .exec("SELECT at,count FROM auth_limits WHERE id=?", key)
      .toArray()[0];
    if (row && Number(row.at) > now - 60000 && Number(row.count) >= maximum)
      fail("RATE_LIMITED");
    this.storage.sql.exec("DELETE FROM auth_limits WHERE at<?", now - 60000);
    this.storage.sql.exec(
      "INSERT INTO auth_limits VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN at<? THEN 1 ELSE count+1 END,at=CASE WHEN at<? THEN excluded.at ELSE at END",
      key,
      now,
      now - 60000,
      now - 60000,
    );
  }
  private async create(input: any) {
    const login = loginName(input.login);
    const hash = await hashPassword(input.password);
    if (
      this.storage.sql
        .exec("SELECT id FROM auth_users WHERE login=?", login)
        .toArray().length
    )
      fail("REGISTRATION_UNAVAILABLE");
    if (
      Number(
        this.storage.sql.exec("SELECT COUNT(*) n FROM auth_users").one().n,
      ) >= 10000
    )
      fail("LIMIT_EXCEEDED");
    const id = crypto.randomUUID();
    this.storage.sql.exec(
      "INSERT INTO auth_users(id,login,password,createdAt) VALUES (?,?,?,?)",
      id,
      login,
      hash,
      Date.now(),
    );
    await this.storage.sync();
    return { id, login };
  }
  private async issue(id: string) {
    this.storage.sql.exec(
      "DELETE FROM auth_sessions WHERE expires<=?",
      Date.now(),
    );
    // Bound sessions per user and environment without a periodic wake-up.
    this.storage.sql.exec(
      "DELETE FROM auth_sessions WHERE userId=? AND id NOT IN (SELECT id FROM auth_sessions WHERE userId=? ORDER BY expires DESC LIMIT 4)",
      id,
      id,
    );
    if (
      Number(
        this.storage.sql.exec("SELECT COUNT(*) n FROM auth_sessions").one().n,
      ) >= 50000
    )
      fail("LIMIT_EXCEEDED");
    const token =
      "flared_session_" +
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const expiresAt = Date.now() + ttl;
    this.storage.sql.exec(
      "INSERT INTO auth_sessions VALUES (?,?,?)",
      await digest(token),
      id,
      expiresAt,
    );
    await this.storage.sync();
    return { token, expiresAt, user: this.user(id) };
  }
  private user(id: string) {
    const row = this.storage.sql
      .exec("SELECT id,login,disabled,createdAt FROM auth_users WHERE id=?", id)
      .toArray()[0];
    if (!row) fail("NOT_FOUND");
    return {
      id: String(row.id),
      login: String(row.login),
      disabled: !!row.disabled,
      createdAt: Number(row.createdAt),
    };
  }
  async authenticate(token: string): Promise<Auth> {
    if (
      !/^flared_session_[a-f0-9]{64}$/.test(token) ||
      !this.settings().enabled
    )
      fail("UNAUTHORIZED");
    const id = await digest(token);
    const row = this.storage.sql
      .exec(
        "SELECT s.userId,s.expires,u.login FROM auth_sessions s JOIN auth_users u ON s.userId=u.id WHERE s.id=? AND s.expires>? AND u.disabled=0",
        id,
        Date.now(),
      )
      .toArray()[0];
    if (!row) fail("UNAUTHORIZED");
    return {
      subject: String(row.userId),
      issuer: this.issuer + "/auth/" + this.scope,
      expiresAt: Number(row.expires),
      claims: { flaredSession: id, login: String(row.login) },
    };
  }
  assert(auth: Auth | null) {
    const session = auth?.claims.flaredSession;
    if (typeof session !== "string") return;
    if (
      !this.settings().enabled ||
      !this.storage.sql
        .exec(
          "SELECT 1 FROM auth_sessions s JOIN auth_users u ON s.userId=u.id WHERE s.id=? AND s.userId=? AND s.expires>? AND u.disabled=0",
          session,
          auth!.subject,
          Date.now(),
        )
        .toArray().length
    )
      fail("AUTH_EXPIRED");
  }
  async public(op: string, input: any, token: string | null) {
    if (!this.settings().enabled) fail("AUTH_DISABLED");
    if (op === "register" || op === "login") {
      this.limit("global", 30);
      const login = loginName(input.login);
      this.limit("login:" + login, 5);
      if (op === "register") {
        if (!this.settings().registration) fail("REGISTRATION_DISABLED");
        const user = await this.create(input);
        return this.issue(user.id);
      }
      const row = this.storage.sql
        .exec(
          "SELECT id,password,disabled FROM auth_users WHERE login=?",
          login,
        )
        .toArray()[0];
      const valid = await verifyPassword(
        input.password,
        row ? String(row.password) : undefined,
      );
      if (!valid || !row || row.disabled) fail("UNAUTHORIZED");
      return this.issue(String(row.id));
    }
    if (!token) fail("UNAUTHORIZED");
    const auth = await this.authenticate(token);
    if (op === "me") return this.user(auth.subject);
    if (op === "logout") {
      this.storage.sql.exec(
        "DELETE FROM auth_sessions WHERE id=?",
        String(auth.claims.flaredSession),
      );
      await this.storage.sync();
      return { userId: auth.subject };
    }
    if (op === "change-password") {
      this.limit("password:" + auth.subject, 5);
      const row = this.storage.sql
        .exec("SELECT password FROM auth_users WHERE id=?", auth.subject)
        .one();
      if (!(await verifyPassword(input.currentPassword, String(row.password))))
        fail("UNAUTHORIZED");
      const hash = await hashPassword(input.password);
      this.replacePassword(auth.subject, hash);
      await this.storage.sync();
      return { userId: auth.subject };
    }
    fail("INVALID_OPERATION");
  }
  private replacePassword(id: string, hash: string) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE auth_users SET password=? WHERE id=?",
        hash,
        id,
      );
      this.storage.sql.exec("DELETE FROM auth_sessions WHERE userId=?", id);
    });
  }
  async admin(op: string, input: any) {
    if (op === "auth-settings") return this.settings();
    if (op === "auth-configure") {
      if (
        typeof input.enabled !== "boolean" ||
        typeof input.registration !== "boolean"
      )
        fail("INVALID_INPUT");
      this.storage.transactionSync(() => {
        this.storage.sql.exec(
          "UPDATE auth_config SET enabled=?,registration=? WHERE id=1",
          +input.enabled,
          +input.registration,
        );
        if (!input.enabled) this.storage.sql.exec("DELETE FROM auth_sessions");
      });
      await this.storage.sync();
      return this.settings();
    }
    if (op === "auth-users") {
      const cursor = input.cursor ?? "";
      if (typeof cursor !== "string" || cursor.length > 36)
        fail("INVALID_CURSOR");
      const rows = this.storage.sql
        .exec(
          "SELECT id FROM auth_users WHERE id>? ORDER BY id LIMIT 51",
          cursor,
        )
        .toArray();
      return {
        users: rows.slice(0, 50).map((r) => this.user(String(r.id))),
        next: rows.length > 50 ? String(rows[49].id) : null,
      };
    }
    if (op === "auth-create") return this.create(input);
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      fail("INVALID_INPUT");
    this.user(input.id);
    if (op === "auth-password")
      this.replacePassword(input.id, await hashPassword(input.password));
    else if (op === "auth-revoke" || op === "auth-disable") {
      this.storage.transactionSync(() => {
        if (op === "auth-disable") {
          if (typeof input.disabled !== "boolean") fail("INVALID_INPUT");
          this.storage.sql.exec(
            "UPDATE auth_users SET disabled=? WHERE id=?",
            +input.disabled,
            input.id,
          );
        }
        this.storage.sql.exec(
          "DELETE FROM auth_sessions WHERE userId=?",
          input.id,
        );
      });
    } else fail("INVALID_OPERATION");
    await this.storage.sync();
    return { userId: input.id };
  }
}
