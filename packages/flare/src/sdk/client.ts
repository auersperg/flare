import {
  assertPath,
  boundedJson,
  LIMITS,
  FlareError,
  stableJson,
  type FunctionRef,
} from "./protocol.js";
export { reference, FlareError } from "./protocol.js";
export type { FunctionRef, Json } from "./protocol.js";

/** Unknown formats are stored as binary and always downloaded as attachments. */
export function fileMetadata(file: Blob & { name: string }) {
  if (file.size > LIMITS.fileBytes)
    throw new FlareError("TOO_LARGE", "Maximum file size: 10 MiB");
  if (
    !file.name ||
    file.name.length > 120 ||
    /[\x00-\x1f\x7f/\\]/.test(file.name)
  )
    throw new FlareError(
      "INVALID_INPUT",
      "File name must be 1–120 characters, without path separators",
    );
  const safeTypes = [
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
  ];
  return {
    name: file.name,
    size: file.size,
    type: safeTypes.includes(file.type)
      ? file.type
      : "application/octet-stream",
  };
}

/** A grant is single-use. Never retry automatically after an ambiguous failure. */
export async function uploadFile(
  grant: { url: string },
  file: Blob,
  options: {
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ id: string }> {
  if (file.size > LIMITS.fileBytes)
    throw new FlareError("TOO_LARGE", "Maximum file size: 10 MiB");
  const url = new URL(grant.url);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new FlareError("INVALID_URL", "Expected secure upload URL");
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url.href, {
      method: "POST",
      body: file,
      redirect: "error",
      credentials: "omit",
      signal:
        options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 120000),
    });
  } catch {
    throw new FlareError(
      "UPLOAD_UNKNOWN",
      "Connection interrupted or upload timed out; refresh the file list before trying again",
      true,
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      result &&
      typeof result === "object" &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : `HTTP_${response.status}`;
    throw new FlareError(
      code,
      `Upload failed: ${code}`,
      response.status >= 500,
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("id" in result) ||
    typeof result.id !== "string"
  )
    throw new FlareError(
      "INVALID_RESPONSE",
      "Upload outcome is unknown; refresh the file list before uploading again",
      true,
    );
  return { id: result.id };
}

export interface Socket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}
export interface ClientOptions {
  url: string;
  getToken?: () => string | null | Promise<string | null>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  createWebSocket?: (url: string) => Socket;
  requestTimeoutMs?: number;
}
export interface Observer<O> {
  next(value: O): void;
  error?(error: FlareError): void;
}
type Subscription = {
  id: string;
  ref: FunctionRef<any, any>;
  args: unknown;
  observers: Set<Observer<any>>;
  revision: number;
  value?: unknown;
  hasValue: boolean;
  terminal: boolean;
};

export function createClient(options: ClientOptions) {
  const base = new URL(options.url);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new FlareError("INVALID_URL", "Expected backend HTTP URL");
  if (
    base.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new FlareError("INVALID_URL", "Remote backends require HTTPS");
  base.pathname = base.pathname.replace(/\/$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  if (!transport)
    throw new FlareError(
      "TRANSPORT_UNAVAILABLE",
      "Provide a fetch implementation",
    );
  const subscriptions = new Map<string, Subscription>();
  let disposed = false,
    socket: Socket | undefined,
    connecting = false,
    attempt = 0,
    generation = 0,
    counter = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const cleanups = new Set<() => void>();
  const endpoint = (path: string) => `${base.href.replace(/\/$/, "")}${path}`;
  const notify = (
    sub: Subscription,
    method: "next" | "error",
    value: unknown,
  ) => {
    for (const observer of sub.observers) {
      try {
        (observer[method] as ((value: unknown) => void) | undefined)?.(
          method === "next" ? JSON.parse(stableJson(value)) : value,
        );
      } catch {
        /* One observer must not block ACK or its peers. */
      }
    }
  };
  function ensureOpen() {
    if (disposed) throw new FlareError("DISPOSED", "Client is disposed");
  }
  async function request(
    path: string,
    body: unknown,
    write: boolean,
  ): Promise<any> {
    ensureOpen();
    const json = boundedJson(body, LIMITS.inputBytes);
    let token: string | null;
    try {
      token = (await options.getToken?.()) ?? null;
    } catch {
      throw new FlareError("AUTH_UNAVAILABLE", "Cannot obtain access token");
    }
    ensureOpen();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.requestTimeoutMs ?? 30000,
    );
    try {
      const response = await transport(endpoint(path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: json,
        signal: controller.signal,
        redirect: "error",
      });
      // Limit decoding before parsing, including servers that omit Content-Length.
      if (!response.body)
        throw new FlareError(
          "INVALID_RESPONSE",
          "Missing response body",
          write,
        );
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > LIMITS.outputBytes)
            throw new FlareError(
              "INVALID_RESPONSE",
              "Response exceeds limit",
              write,
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let data: unknown;
      try {
        data = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(combined),
        );
      } catch (error) {
        if (response.ok) throw error;
        throw new FlareError(
          `HTTP_${response.status}`,
          "Backend request failed",
          write && response.status >= 500,
        );
      }
      if (!response.ok) {
        const code =
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof data.error === "string" &&
          /^[A-Z][A-Z0-9_]{0,63}$/.test(data.error)
            ? data.error
            : `HTTP_${response.status}`;
        throw new FlareError(
          code,
          "Backend request failed",
          write && response.status >= 500,
        );
      }
      if (!data || typeof data !== "object" || !("result" in data))
        throw new FlareError(
          "INVALID_RESPONSE",
          "Invalid protocol envelope",
          write,
        );
      boundedJson(data.result, LIMITS.outputBytes);
      return data.result;
    } catch (error) {
      if (error instanceof FlareError) throw error;
      if (error instanceof SyntaxError)
        throw new FlareError(
          "INVALID_RESPONSE",
          "Invalid JSON response",
          write,
        );
      throw new FlareError(
        "TRANSPORT_ERROR",
        write
          ? "Write outcome is unknown; do not replay automatically"
          : "Backend request interrupted",
        write,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  function send(value: unknown) {
    socket?.send(boundedJson(value, LIMITS.frameBytes));
  }
  function register(sub: Subscription) {
    send({ type: "subscribe", id: sub.id, path: sub.ref.path, args: sub.args });
  }
  function reconnect() {
    if (disposed || !subscriptions.size || retry) return;
    const delay = Math.min(30000, 250 * 2 ** Math.min(attempt++, 7));
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, delay);
  }
  async function connect() {
    if (disposed || connecting || socket || !subscriptions.size) return;
    connecting = true;
    const current = ++generation;
    try {
      const ticket = await request("/v1/live/ticket", {}, false);
      if (disposed || current !== generation || !subscriptions.size) return;
      if (
        !ticket ||
        typeof ticket.ticket !== "string" ||
        ticket.ticket.length > 1024
      )
        throw new FlareError("INVALID_RESPONSE", "Invalid live ticket");
      const url = new URL(endpoint("/v1/live"));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket.ticket);
      const ws = options.createWebSocket
        ? options.createWebSocket(url.href)
        : new globalThis.WebSocket(url.href);
      socket = ws;
      const onOpen = () => {
        if (socket !== ws || disposed) return;
        attempt = 0;
        for (const sub of subscriptions.values()) {
          sub.revision = -1;
          sub.hasValue = false;
          if (!sub.terminal) register(sub);
        }
      };
      const onMessage = (event: { data: unknown }) => {
        if (socket !== ws || disposed) return;
        try {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).byteLength >
              LIMITS.outputBytes + 1024
          )
            throw new Error("Invalid frame");
          const frame = JSON.parse(event.data);
          if (frame.type === "ready") return;
          const sub = [...subscriptions.values()].find(
            (s) => s.id === frame.id,
          );
          if (!sub || sub.terminal) return;
          if (frame.type === "error") {
            sub.terminal = true;
            if (
              ["AUTH_EXPIRED", "UNAUTHORIZED", "FORBIDDEN"].includes(frame.code)
            ) {
              sub.hasValue = false;
              sub.value = undefined;
            }
            notify(
              sub,
              "error",
              new FlareError(
                typeof frame.code === "string" ? frame.code : "LIVE_ERROR",
                "Live subscription failed",
              ),
            );
            return;
          }
          if (
            frame.type !== "snapshot" ||
            !Number.isSafeInteger(frame.revision) ||
            frame.revision < 0 ||
            !("result" in frame)
          )
            throw new Error("Invalid snapshot");
          const json = boundedJson(frame.result, LIMITS.outputBytes);
          if (frame.revision > sub.revision) {
            const changed = !sub.hasValue || stableJson(sub.value) !== json;
            sub.revision = frame.revision;
            sub.value = frame.result;
            sub.hasValue = true;
            if (changed) notify(sub, "next", sub.value);
          }
          send({ type: "ack", id: sub.id, revision: sub.revision });
        } catch {
          ws.close(1002, "Invalid protocol frame");
        }
      };
      const onClose = (event: { code?: number }) => {
        cleanup();
        if (socket !== ws) return;
        socket = undefined;
        for (const sub of subscriptions.values()) {
          if (event.code === 1008) {
            sub.hasValue = false;
            sub.value = undefined;
            sub.revision = -1;
          }
          if (!sub.terminal)
            notify(
              sub,
              "error",
              new FlareError(
                event.code === 1008 ? "AUTH_EXPIRED" : "LIVE_DISCONNECTED",
                "Live reconnecting; next snapshot will be current",
              ),
            );
        }
        reconnect();
      };
      const onError = () => ws.close();
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        cleanups.delete(cleanup);
      };
      cleanups.add(cleanup);
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    } catch (error) {
      if (disposed || current !== generation) return;
      for (const sub of subscriptions.values()) {
        if (
          error instanceof FlareError &&
          ["HTTP_401", "HTTP_403"].includes(error.code)
        ) {
          sub.hasValue = false;
          sub.value = undefined;
          sub.revision = -1;
        }
        notify(
          sub,
          "error",
          error instanceof FlareError
            ? error
            : new FlareError("LIVE_UNAVAILABLE", "Live connection failed"),
        );
      }
      reconnect();
    } finally {
      connecting = false;
      if (!disposed && current !== generation && !socket && subscriptions.size)
        reconnect();
    }
  }
  function invoke(kind: FunctionRef["kind"]) {
    return async <I, O>(ref: FunctionRef<I, O>, args: I): Promise<O> => {
      assertPath(ref.path);
      if (ref.kind !== kind)
        throw new FlareError("INVALID_KIND", `Expected a ${kind} function`);
      return request(
        "/v1/call",
        { path: ref.path, kind: ref.kind, args },
        ref.kind === "mutation" || ref.kind === "action",
      );
    };
  }
  return {
    query: invoke("query"),
    mutation: invoke("mutation"),
    action: invoke("action"),
    /** One subscription delivers the initial snapshot and subsequent updates. */
    onUpdate<I, O>(
      ref: FunctionRef<I, O>,
      args: I,
      next: (value: O) => void,
      error?: (error: FlareError) => void,
    ): () => void {
      const observer = { next, error };
      ensureOpen();
      assertPath(ref.path);
      if (ref.kind !== "query")
        throw new FlareError("INVALID_KIND", "Only queries are subscribable");
      boundedJson(
        {
          type: "subscribe",
          id: "subscription-9999999999",
          path: ref.path,
          args,
        },
        LIMITS.frameBytes,
      );
      const key = stableJson({ path: ref.path, args });
      let sub = subscriptions.get(key);
      if (!sub) {
        if (subscriptions.size >= LIMITS.subscriptions)
          throw new FlareError(
            "TOO_MANY_SUBSCRIPTIONS",
            "Subscription limit exceeded",
          );
        sub = {
          id: `subscription-${++counter}`,
          ref,
          args: JSON.parse(stableJson(args)),
          observers: new Set(),
          revision: -1,
          hasValue: false,
          terminal: false,
        };
        subscriptions.set(key, sub);
        if (socket?.readyState === 1) register(sub);
      }
      const registration = { next: observer.next, error: observer.error };
      sub.observers.add(registration);
      if (sub.hasValue)
        notify({ ...sub, observers: new Set([observer]) }, "next", sub.value);
      void connect();
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        sub!.observers.delete(registration);
        if (!sub!.observers.size) {
          subscriptions.delete(key);
          if (socket?.readyState === 1)
            send({ type: "unsubscribe", id: sub!.id });
        }
        if (!subscriptions.size) {
          ++generation;
          if (retry) clearTimeout(retry);
          retry = undefined;
          const old = socket;
          socket = undefined;
          for (const cleanup of [...cleanups]) cleanup();
          old?.close(1000, "No subscriptions");
        }
      };
    },
    /** Call on login/logout/account switch; never reuse cached values across identities. */
    refreshAuth() {
      ensureOpen();
      ++generation;
      if (retry) clearTimeout(retry);
      retry = undefined;
      for (const cleanup of [...cleanups]) cleanup();
      const old = socket;
      socket = undefined;
      old?.close(1000, "Authorization changed");
      for (const sub of subscriptions.values()) {
        sub.hasValue = false;
        sub.value = undefined;
        sub.revision = -1;
        sub.terminal = false;
        notify(
          sub,
          "error",
          new FlareError(
            "AUTH_CHANGED",
            "Authorization changed; cached value invalidated",
          ),
        );
      }
      void connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      if (retry) clearTimeout(retry);
      retry = undefined;
      for (const cleanup of [...cleanups]) cleanup();
      subscriptions.clear();
      socket?.close(1000, "Disposed");
      socket = undefined;
    },
  };
}
export type FlareClient = ReturnType<typeof createClient>;

export type PasswordUser = {
  id: string;
  login: string;
  disabled: boolean;
  createdAt: number;
};
export type PasswordSession = {
  token: string;
  expiresAt: number;
  user: PasswordUser;
};
/** Browser persistence is scoped to the full deployment URL. Passwords are never stored.
 * Server/mobile callers can provide storage explicitly, or use null for memory-only auth.
 * Connect onChange to client.refreshAuth() and call restore() before rendering protected UI. */
export type PasswordAuthStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
export function createPasswordAuth(options: {
  url: string;
  storage?: PasswordAuthStorage | null;
}) {
  const base = options.url.replace(/\/$/, "");
  const key = "flared:session:" + encodeURIComponent(base);
  let storage = options.storage ?? null;
  let browserStorage: Storage | null = null;
  if (typeof window !== "undefined") {
    try {
      browserStorage = window.localStorage;
    } catch {
      /* Browser storage may be denied. */
    }
    if (options.storage === undefined) storage = browserStorage;
  }
  let session: Pick<PasswordSession, "token" | "expiresAt"> | null = null;
  let user: PasswordUser | null = null;
  let version = 0;
  let listening = false;
  let restoring: {
    version: number;
    promise: Promise<PasswordUser | null>;
  } | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const persist = () => {
    if (!storage) return;
    try {
      if (session) storage.setItem(key, JSON.stringify(session));
      else storage.removeItem(key);
    } catch {
      /* A denied/quota-limited store must not prevent sign-out. */
    }
  };
  const clear = () => {
    ++version;
    session = null;
    user = null;
    persist();
    changed();
  };
  const request = async <T>(
    op: string,
    input: unknown,
    token = session?.token,
  ): Promise<T> => {
    const response = await fetch(base + "/v1/auth/" + op, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await response.json();
    if (!response.ok)
      throw new FlareError(
        data.error ?? "AUTH_FAILED",
        "Authentication request failed",
      );
    return data as T;
  };
  const restore = (): Promise<PasswordUser | null> => {
    if (!listening && browserStorage && storage === browserStorage) {
      window.addEventListener("storage", onStorage);
      listening = true;
    }
    if (restoring?.version === version) return restoring.promise;
    const current = version;
    const promise = (async () => {
      let saved = session;
      if (storage) {
        try {
          const raw = storage.getItem(key);
          saved = raw ? JSON.parse(raw) : null;
        } catch {
          saved = null;
        }
      }
      if (
        !saved ||
        !/^flared_session_[a-f0-9]{64}$/.test(saved.token) ||
        !Number.isSafeInteger(saved.expiresAt) ||
        saved.expiresAt <= Date.now()
      ) {
        if (current === version) clear();
        return null;
      }
      try {
        const verified = await request<PasswordUser>("me", {}, saved.token);
        if (current !== version) return null;
        session = { token: saved.token, expiresAt: saved.expiresAt };
        user = verified;
        changed();
        return verified;
      } catch (error) {
        if (current !== version) return null;
        if (
          error instanceof FlareError &&
          ["UNAUTHORIZED", "AUTH_EXPIRED", "AUTH_DISABLED"].includes(error.code)
        ) {
          clear();
          return null;
        }
        // Network failures are not evidence of an invalid session. Keep storage for retry.
        throw error;
      }
    })();
    restoring = { version: current, promise };
    void promise
      .finally(() => {
        if (restoring?.promise === promise) restoring = null;
      })
      .catch(() => {});
    return promise;
  };
  function onStorage(event: StorageEvent) {
    if (
      event.storageArea !== browserStorage ||
      (event.key !== key && event.key !== null)
    )
      return;
    ++version;
    session = null;
    user = null;
    changed();
    void restore().catch(() => {});
  }
  const signIn = async (op: string, login: string, password: string) => {
    const current = ++version;
    const result = await request<PasswordSession>(
      op,
      { login, password },
      undefined,
    );
    if (current !== version) {
      await request("logout", {}, result.token).catch(() => {});
      throw new FlareError(
        "AUTH_CHANGED",
        "Authentication changed during sign-in",
      );
    }
    session = { token: result.token, expiresAt: result.expiresAt };
    user = result.user;
    persist();
    changed();
    return result.user;
  };
  const getToken = () =>
    session && session.expiresAt > Date.now() ? session.token : null;
  return {
    getToken,
    getUser: () => (getToken() ? user : null),
    restore,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: (login: string, password: string) =>
      signIn("register", login, password),
    login: (login: string, password: string) =>
      signIn("login", login, password),
    async me() {
      const current = version;
      try {
        const value = await request<PasswordUser>("me", {});
        if (current === version) user = value;
        return value;
      } catch (error) {
        if (
          current === version &&
          error instanceof FlareError &&
          ["UNAUTHORIZED", "AUTH_EXPIRED", "AUTH_DISABLED"].includes(error.code)
        )
          clear();
        throw error;
      }
    },
    async logout() {
      let token = session?.token;
      // Logout may be requested before restore finishes. Revoke the saved session too.
      if (!token && storage) {
        try {
          const saved = JSON.parse(storage.getItem(key) ?? "null");
          if (saved && /^flared_session_[a-f0-9]{64}$/.test(saved.token))
            token = saved.token;
        } catch {
          /* No valid saved session. */
        }
      }
      clear();
      if (token) await request("logout", {}, token);
    },
    async changePassword(currentPassword: string, password: string) {
      const current = version;
      await request("change-password", { currentPassword, password });
      if (current === version) clear();
    },
    dispose() {
      ++version;
      if (listening) window.removeEventListener("storage", onStorage);
      listening = false;
      listeners.clear();
      session = null;
      user = null;
      // Disposing a view is not logging out: keep the durable session.
    },
  };
}
