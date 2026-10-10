import {
  assertPath,
  boundedJson,
  LIMITS,
  FlaredError,
  stableJson,
  type FunctionRef,
} from "./protocol.js";
export { reference, FlaredError } from "./protocol.js";
export type { FunctionRef, Json } from "./protocol.js";

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
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string) => Socket;
  requestTimeoutMs?: number;
}
export interface Observer<O> {
  next(value: O): void;
  error?(error: FlaredError): void;
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
    throw new FlaredError("INVALID_URL", "Expected backend HTTP URL");
  if (
    base.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new FlaredError("INVALID_URL", "Remote backends require HTTPS");
  base.pathname = base.pathname.replace(/\/$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  if (!transport)
    throw new FlaredError(
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
    if (disposed) throw new FlaredError("DISPOSED", "Client is disposed");
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
      throw new FlaredError("AUTH_UNAVAILABLE", "Cannot obtain access token");
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
      if (!response.ok)
        throw new FlaredError(
          `HTTP_${response.status}`,
          "Backend request failed",
          write && response.status >= 500,
        );
      // Limit decoding before parsing, including servers that omit Content-Length.
      if (!response.body)
        throw new FlaredError(
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
            throw new FlaredError(
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
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(combined),
      );
      if (!data || typeof data !== "object" || !("result" in data))
        throw new FlaredError(
          "INVALID_RESPONSE",
          "Invalid protocol envelope",
          write,
        );
      boundedJson(data.result, LIMITS.outputBytes);
      return data.result;
    } catch (error) {
      if (error instanceof FlaredError) throw error;
      if (error instanceof SyntaxError)
        throw new FlaredError(
          "INVALID_RESPONSE",
          "Invalid JSON response",
          write,
        );
      throw new FlaredError(
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
        throw new FlaredError("INVALID_RESPONSE", "Invalid live ticket");
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
              new FlaredError(
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
              new FlaredError(
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
          error instanceof FlaredError &&
          ["HTTP_401", "HTTP_403"].includes(error.code)
        ) {
          sub.hasValue = false;
          sub.value = undefined;
          sub.revision = -1;
        }
        notify(
          sub,
          "error",
          error instanceof FlaredError
            ? error
            : new FlaredError("LIVE_UNAVAILABLE", "Live connection failed"),
        );
      }
      reconnect();
    } finally {
      connecting = false;
      if (!disposed && current !== generation && !socket && subscriptions.size)
        reconnect();
    }
  }
  return {
    async call<I, O>(ref: FunctionRef<I, O>, args: I): Promise<O> {
      assertPath(ref.path);
      if (ref.kind === "live")
        throw new FlaredError(
          "INVALID_KIND",
          "Use subscribe for live functions",
        );
      return request(
        "/v1/call",
        { path: ref.path, kind: ref.kind, args },
        ref.kind === "mutation" || ref.kind === "action",
      );
    },
    subscribe<I, O>(
      ref: FunctionRef<I, O>,
      args: I,
      observer: Observer<O>,
    ): () => void {
      ensureOpen();
      assertPath(ref.path);
      if (ref.kind !== "live")
        throw new FlaredError("INVALID_KIND", "Expected a live function");
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
          throw new FlaredError(
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
          new FlaredError(
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
export type FlaredClient = ReturnType<typeof createClient>;
