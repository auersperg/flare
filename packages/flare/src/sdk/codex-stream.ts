import {
  FlareError,
  boundedJson,
  LIMITS,
  type FunctionRef,
} from "./protocol.js";
import { readBody } from "./http.js";
import type { CodexTask } from "./codex.js";
export type CodexSubscription = { type: "codex-events"; id: string };
export type CodexEvent =
  | { type: "task"; task: CodexTask }
  | {
      type: "status" | "text" | "output" | "item" | "truncated";
      seq: number;
      at: number;
      itemId?: string;
      text?: string;
      kind?: string;
      state?: string;
      exitCode?: number | null;
    };

export async function* readCodexEvents<I>(options: {
  url: string;
  ref: FunctionRef<I, CodexSubscription>;
  args: I;
  token: () => Promise<string | null>;
  transport: typeof fetch;
  signal: AbortSignal;
  after?: number;
}): AsyncGenerator<CodexEvent> {
  if (options.ref.kind !== "query")
    throw new FlareError(
      "INVALID_KIND",
      "Stream authorization must be a read-only query",
    );
  let cursor = options.after ?? 0,
    failures = 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 4096)
    throw new FlareError("INVALID_ARGUMENT", "Invalid cursor");
  const signal = options.signal;
  while (!signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const connection = new AbortController();
    const abort = () => connection.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), 45000);
    };
    try {
      touch();
      const token = await options.token();
      if (signal.aborted) return;
      const response = await options.transport(options.url, {
        method: "POST",
        redirect: "error",
        signal: connection.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: boundedJson(
          {
            path: options.ref.path,
            kind: "query",
            args: options.args,
            after: cursor,
          },
          LIMITS.inputBytes,
        ),
      });
      if (!response.ok) {
        const bytes = response.body
          ? await readBody(response.body, 8192, () => {
              throw new FlareError("INVALID_RESPONSE", "Oversized error");
            })
          : new Uint8Array();
        let code = `HTTP_${response.status}`;
        try {
          const value = JSON.parse(new TextDecoder().decode(bytes));
          if (/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error)) code = value.error;
        } catch {}
        throw new FlareError(code, "Event subscription failed");
      }
      if (
        !response.headers
          .get("content-type")
          ?.startsWith("text/event-stream") ||
        !response.body
      )
        throw new FlareError("INVALID_RESPONSE", "Expected SSE");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "",
        total = 0;
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        touch();
        total += next.value.byteLength;
        if (total > 1048576)
          throw new FlareError("INVALID_RESPONSE", "Stream exceeds bound");
        pending += decoder.decode(next.value, { stream: true });
        let end;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.length > 524288)
            throw new FlareError("INVALID_RESPONSE", "Oversized event");
          let name = "",
            data = "",
            id = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trimStart();
            if (line.startsWith("id:")) id = line.slice(3).trim();
          }
          if (!data) continue;
          if (name === "reconnect") continue;
          const value = JSON.parse(data);
          if (name === "task") {
            if (
              !value ||
              typeof value.id !== "string" ||
              !["succeeded", "failed", "cancelled", "interrupted"].includes(
                value.state,
              )
            )
              throw new FlareError("INVALID_RESPONSE", "Invalid task");
            yield { type: "task", task: value };
            return;
          }
          if (
            name !== "progress" ||
            !Number.isSafeInteger(value.seq) ||
            String(value.seq) !== id ||
            value.seq > 4096 ||
            !["status", "text", "output", "item", "truncated"].includes(
              value.type,
            )
          )
            throw new FlareError("INVALID_RESPONSE", "Invalid event");
          if (value.seq <= cursor) continue;
          if (value.seq !== cursor + 1)
            throw new FlareError("CODEX_EVENT_GAP", "Event gap");
          cursor = value.seq;
          failures = 0;
          yield value;
        }
        if (pending.length > 524288)
          throw new FlareError("INVALID_RESPONSE", "Oversized frame");
      }
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof FlareError ? error.code : "";
      if (
        code &&
        ![
          "HTTP_429",
          "HTTP_500",
          "HTTP_502",
          "HTTP_503",
          "HTTP_504",
          "CODEX_UNAVAILABLE",
        ].includes(code)
      )
        throw error;
      if (++failures > 5)
        throw new FlareError(
          "CODEX_STREAM_INTERRUPTED",
          "Reconnect failed; task continues independently",
        );
    } finally {
      clearTimeout(idle!);
      signal.removeEventListener("abort", abort);
      connection.abort();
      await reader?.cancel().catch(() => {});
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(5000, 500 * 2 ** failures));
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
