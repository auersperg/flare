import { describe, it, expect, afterEach, jest } from "bun:test";
import { Database } from "bun:sqlite";
import {
  PasswordAuth,
  hashPassword,
  verifyPassword,
} from "../packages/core/src/auth.js";
import { createPasswordAuth } from "../packages/sdk/src/client.js";
const password = "A unique long test passphrase 73!";
const databases: Database[] = [];
function store(scope = "proof/dev") {
  const db = new Database(":memory:");
  databases.push(db);
  const storage = {
    sql: {
      exec(sql: string, ...args: any[]) {
        const rows = db.query(sql).all(...args);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw Error("Expected one row");
            return rows[0];
          },
        };
      },
    },
    sync: async () => {},
    transactionSync: (fn: () => unknown) => db.transaction(fn)(),
  } as unknown as DurableObjectStorage;
  return {
    auth: new PasswordAuth(storage, scope, "https://api.example.com"),
    db,
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  jest.restoreAllMocks();
});
describe("password authentication", () => {
  it("uses native salted scrypt, verifies and rejects weak input", async () => {
    const a = await hashPassword(password),
      b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(a).not.toContain(password);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword(password)).toBe(false);
    await expect(hashPassword("short")).rejects.toMatchObject({
      code: "INVALID_PASSWORD",
    });
    expect(await verifyPassword("six123", await hashPassword("six123"))).toBe(
      true,
    );
    const { auth } = store();
    expect(auth.settings().passwordMinLength).toBe(6);
  });
  it("defaults closed and enables scoped open registration without exposing hashes", async () => {
    const { auth, db } = store();
    await expect(
      auth.public("register", { login: "adam", password }, null),
    ).rejects.toMatchObject({ code: "AUTH_DISABLED" });
    await auth.admin("auth-configure", { enabled: true, registration: true });
    const session: any = await auth.public(
      "register",
      { login: "Adam", password },
      null,
    );
    expect(session.user.login).toBe("adam");
    expect(session.user.password).toBeUndefined();
    expect(JSON.stringify(await auth.admin("auth-users", {}))).not.toContain(
      "scrypt$",
    );
    expect((await auth.authenticate(session.token)).subject).toBe(
      session.user.id,
    );
    expect(db.query("SELECT id FROM auth_sessions").get()).not.toEqual({
      id: session.token,
    });
    await expect(
      store("proof/prod").auth.authenticate(session.token),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("password reset revokes all sessions, logout revokes the selected session", async () => {
    const { auth } = store();
    await auth.admin("auth-configure", { enabled: true, registration: true });
    const a: any = await auth.public(
      "register",
      { login: "adam", password },
      null,
    );
    const b: any = await auth.public(
      "login",
      { login: "adam", password },
      null,
    );
    await auth.public("logout", {}, a.token);
    await expect(auth.authenticate(a.token)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const identity = await auth.authenticate(b.token);
    await auth.admin("auth-password", {
      id: a.user.id,
      password: password + "changed",
    });
    expect(() => auth.assert(identity)).toThrow();
    await expect(
      auth.public("login", { login: "adam", password }, null),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        (await auth.public(
          "login",
          { login: "adam", password: password + "changed" },
          null,
        )) as any
      ).user.id,
    ).toBe(a.user.id);
  });
  it("disabled users and expired sessions cannot authenticate; settings disable revokes all", async () => {
    const { auth, db } = store();
    await auth.admin("auth-configure", { enabled: true, registration: true });
    const a: any = await auth.public(
      "register",
      { login: "adam", password },
      null,
    );
    db.query("UPDATE auth_sessions SET expires=0").run();
    await expect(auth.authenticate(a.token)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await auth.admin("auth-disable", { id: a.user.id, disabled: true });
    await expect(
      auth.public("login", { login: "adam", password }, null),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await auth.admin("auth-disable", { id: a.user.id, disabled: false });
    const b: any = await auth.public(
      "login",
      { login: "adam", password },
      null,
    );
    await auth.admin("auth-configure", { enabled: false, registration: false });
    await expect(auth.authenticate(b.token)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("rate limits unknown accounts before further password hashing", async () => {
    const { auth } = store();
    await auth.admin("auth-configure", { enabled: true, registration: true });
    for (let i = 0; i < 5; i++)
      await expect(
        auth.public("login", { login: "unknown", password }, null),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      auth.public("login", { login: "unknown", password }, null),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("SDK has in-memory sessions, change notification and no token URL", async () => {
    const requests: Request[] = [];
    jest.spyOn(globalThis, "fetch").mockImplementation((async (
      url: any,
      init: any,
    ) => {
      const r = new Request(url, init);
      requests.push(r);
      return Response.json(
        r.url.endsWith("/login")
          ? {
              token: "test-token",
              expiresAt: Date.now() + 10000,
              user: { id: "one", login: "adam" },
            }
          : { userId: "one" },
      );
    }) as typeof fetch);
    const auth = createPasswordAuth({ url: "https://api.example.com/p/dev" });
    let changed = 0;
    auth.onChange(() => changed++);
    await auth.login("adam", password);
    expect(auth.getToken()).toBe("test-token");
    await auth.logout();
    expect(auth.getToken()).toBeNull();
    expect(changed).toBe(2);
    expect(requests[1].headers.get("authorization")).toBe("Bearer test-token");
    expect(requests.some((r) => r.url.includes("test-token"))).toBe(false);
  });
});
