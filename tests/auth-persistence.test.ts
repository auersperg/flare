import { afterEach, expect, it, jest } from "bun:test";
import {
  createPasswordAuth,
  type PasswordAuthStorage,
} from "../packages/flare/src/sdk/client.js";
const token = "flared_session_" + "a".repeat(64);
const user = { id: "user-a", login: "adam", disabled: false, createdAt: 1 };
function storage(): PasswordAuthStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  };
}
function responses(handler?: (op: string) => Response | Promise<Response>) {
  return jest.spyOn(globalThis, "fetch").mockImplementation((async (
    url: RequestInfo | URL,
  ) => {
    const op = String(url).split("/").at(-1)!;
    if (handler) return handler(op);
    return Response.json(
      op === "me"
        ? user
        : op === "logout"
          ? {}
          : { token, expiresAt: Date.now() + 60000, user },
    );
  }) as typeof fetch);
}
afterEach(() => {
  jest.restoreAllMocks();
});
it("restores after recreating the SDK, verifies the server, and isolates deployments", async () => {
  const saved = storage(),
    fetcher = responses();
  const a = createPasswordAuth({
    url: "https://api.example/app/dev",
    storage: saved,
  });
  await a.login("adam", "six123");
  expect([...saved.values.values()].join()).not.toContain("six123");
  expect([...saved.values.values()].join()).not.toContain('"user"');
  a.dispose();
  const b = createPasswordAuth({
    url: "https://api.example/app/dev/",
    storage: saved,
  });
  expect(b.getToken()).toBeNull();
  const promise = b.restore();
  expect(b.restore()).toBe(promise);
  expect(await promise).toEqual(user);
  expect(b.getToken()).toBe(token);
  expect(b.getUser()).toEqual(user);
  const prod = createPasswordAuth({
    url: "https://api.example/app/prod",
    storage: saved,
  });
  expect(await prod.restore()).toBeNull();
  expect(b.getToken()).toBe(token);
  expect(fetcher.mock.calls.length).toBe(2);
  await b.logout();
  expect(saved.values.size).toBe(0);
  expect(
    await createPasswordAuth({
      url: "https://api.example/app/dev",
      storage: saved,
    }).restore(),
  ).toBeNull();
});
it("clears revoked sessions, but preserves credentials on a temporary network failure", async () => {
  const saved = storage();
  responses();
  const a = createPasswordAuth({
    url: "https://api.example/dev",
    storage: saved,
  });
  await a.login("adam", "six123");
  a.dispose();
  jest.restoreAllMocks();
  responses(() => {
    throw new TypeError("offline");
  });
  const b = createPasswordAuth({
    url: "https://api.example/dev",
    storage: saved,
  });
  await expect(b.restore()).rejects.toThrow("offline");
  expect(saved.values.size).toBe(1);
  expect(b.getToken()).toBeNull();
  jest.restoreAllMocks();
  responses(() => Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
  expect(await b.restore()).toBeNull();
  expect(saved.values.size).toBe(0);
});
it("rejects corrupt and expired records without a request", async () => {
  const saved = storage(),
    fetcher = responses();
  const key = "flared:session:" + encodeURIComponent("https://api.example/dev");
  for (const record of [
    "{broken",
    JSON.stringify({ token, expiresAt: Date.now() - 1 }),
    JSON.stringify({ token: "wrong", expiresAt: Date.now() + 60000 }),
  ]) {
    saved.setItem(key, record);
    expect(
      await createPasswordAuth({
        url: "https://api.example/dev",
        storage: saved,
      }).restore(),
    ).toBeNull();
    expect(saved.values.size).toBe(0);
  }
  expect(fetcher.mock.calls.length).toBe(0);
});
it("logout wins over a delayed restore and erases persistence even when offline", async () => {
  const saved = storage();
  responses();
  const a = createPasswordAuth({
    url: "https://api.example/dev",
    storage: saved,
  });
  await a.login("adam", "six123");
  a.dispose();
  jest.restoreAllMocks();
  let release!: (r: Response) => void;
  responses((op) =>
    op === "logout"
      ? Response.json({})
      : new Promise<Response>((resolve) => {
          release = resolve;
        }),
  );
  const b = createPasswordAuth({
    url: "https://api.example/dev",
    storage: saved,
  });
  const restoring = b.restore();
  await b.logout();
  release(Response.json(user));
  expect(await restoring).toBeNull();
  expect(b.getToken()).toBeNull();
  expect(saved.values.size).toBe(0);
  jest.restoreAllMocks();
  responses();
  await b.login("adam", "six123");
  jest.restoreAllMocks();
  responses(() => {
    throw new TypeError("offline");
  });
  await expect(b.logout()).rejects.toThrow("offline");
  expect(b.getToken()).toBeNull();
  expect(saved.values.size).toBe(0);
});
it("browser default storage synchronizes tab logout and dispose keeps persistence", async () => {
  const saved = storage();
  const events = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: saved,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  try {
    responses();
    const a = createPasswordAuth({ url: "https://api.example/dev" });
    await a.login("adam", "six123");
    await a.restore();
    const key = [...saved.values.keys()][0];
    const b = createPasswordAuth({ url: "https://api.example/dev" });
    await b.restore();
    b.dispose();
    expect(saved.values.size).toBe(1);
    saved.removeItem(key);
    const event = new Event("storage");
    Object.assign(event, { key, storageArea: saved });
    events.dispatchEvent(event);
    expect(a.getToken()).toBeNull();
    expect(a.getUser()).toBeNull();
    a.dispose();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as any).window;
  }
});
it("works without browser globals or storage", async () => {
  responses();
  const auth = createPasswordAuth({
    url: "https://api.example/dev",
    storage: null,
  });
  expect(await auth.restore()).toBeNull();
  await auth.login("adam", "six123");
  expect(auth.getToken()).toBe(token);
  auth.dispose();
});
