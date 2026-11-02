import type { CodexTask } from "../../flare/src/sdk/codex.js";
export const eventBytes = 262144;
// One browser-independent, bounded journal. Native tail follows writes, never polls the model.
export function eventStream(options: {
  after: number;
  archive: () => string;
  task: () => CodexTask | null;
  process?: ExecProcess;
  settle: () => Promise<void>;
  release: () => void;
}): Response {
  const encoder = new TextEncoder();
  let cursor = options.after,
    closed = false,
    processExited = !options.process;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval>;
  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    void reader?.cancel().catch(() => {});
    if (!processExited)
      try {
        options.process?.kill();
      } catch {}
    options.release();
  }
  options.process?.exitCode.then(
    () => {
      processExited = true;
    },
    () => {
      processExited = true;
    },
  );
  function send(text: string) {
    if (closed) return;
    // Slow clients reconnect from their cursor instead of accumulating an unbounded output queue.
    if ((controller.desiredSize ?? 0) < -eventBytes) {
      controller.close();
      stop();
      return;
    }
    controller.enqueue(encoder.encode(text));
  }
  function lines(text: string) {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (
        !Number.isSafeInteger(event.seq) ||
        event.seq < 1 ||
        event.seq > 4096 ||
        !["status", "text", "output", "item", "truncated"].includes(
          event.type,
        ) ||
        line.length > 16384
      )
        throw Error("CODEX_INVALID_EVENT");
      if (event.seq <= cursor) continue;
      if (event.seq !== cursor + 1) throw Error("CODEX_EVENT_GAP");
      cursor = event.seq;
      send(`id: ${cursor}\nevent: progress\ndata: ${line}\n\n`);
    }
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        send(": connected\n\n");
        heartbeat = setInterval(() => send(": keep-alive\n\n"), 10000);
        void (async () => {
          try {
            if (options.process?.stdout) {
              reader = options.process.stdout.getReader();
              const decoder = new TextDecoder();
              let pending = "",
                total = 0;
              while (!closed) {
                const next = await reader.read();
                if (next.done) break;
                total += next.value.byteLength;
                if (total > eventBytes) throw Error("CODEX_EVENT_LIMIT");
                pending += decoder.decode(next.value, { stream: true });
                const end = pending.lastIndexOf("\n");
                if (end >= 0) {
                  lines(pending.slice(0, end));
                  pending = pending.slice(end + 1);
                }
                if (pending.length > 16384) throw Error("CODEX_EVENT_LIMIT");
              }
            }
          } catch {
            /* Completion may destroy tail; durable replay below fills the final gap. */
          }
          if (closed) return;
          try {
            await options.settle();
            if (closed) return;
            lines(options.archive());
            const task = options.task();
            if (task && task.state !== "running")
              send(`event: task\ndata: ${JSON.stringify(task)}\n\n`);
            else send("event: reconnect\ndata: {}\n\n");
            controller.close();
          } catch {
            try {
              controller.error(Error("CODEX_STREAM_INTERRUPTED"));
            } catch {}
          } finally {
            stop();
          }
        })();
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 65536, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
