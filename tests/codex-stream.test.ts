import { describe, expect, it } from "bun:test";
import {
  createClient,
  reference,
  type CodexSubscription,
} from "../packages/flare/src/sdk/client";
import { codexEvents } from "../packages/core/src/codex";
import { eventStream } from "../packages/codex/src/stream";
import { applicationRoute } from "../packages/core/src/routing";
const id = "00000000-0000-4000-8000-000000000001",
  scope = id + "/prod";
const ref = reference<{ id: string }, CodexSubscription>("ai/watch", "query");
const enc = new TextEncoder();
const progress = (seq: number, text = "Привет") =>
  `id: ${seq}\nevent: progress\ndata: ${JSON.stringify({ seq, at: 1, type: "text", itemId: "answer", text })}\n\n`;
const done = `event: task\ndata: ${JSON.stringify({ id, state: "succeeded", startedAt: 1, result: "OK" })}\n\n`;
const response = (text: string) =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });
describe("native Codex event streams", () => {
  it("routes both stable IDs and aliases without adding a public runner API", () => {
    expect(applicationRoute(`/p/${id}/prod/v1/codex/events`)?.operation).toBe(
      "codex/events",
    );
    expect(
      applicationRoute("/app-auer-wien-b22ce01b/prod/v1/codex/events")
        ?.operation,
    ).toBe("codex/events");
  });
  it("requires a read-only authorization query and explicit scope grant", async () => {
    await expect(
      codexEvents({}, scope, { type: "codex-events", id }, 0, () => {}),
    ).rejects.toThrow("not granted");
    const client = createClient({
      url: "https://example.com",
      fetch: async () => {
        throw Error("must not send");
      },
    });
    await expect(
      client.codexEvents(reference("ai/start", "action"), { id }).next(),
    ).rejects.toThrow("read-only");
    client.dispose();
  });
  it("calls fetch without binding it to the options object (browser receiver contract)", async () => {
    let receiver: unknown;
    const client = createClient({
      url: "https://example.com",
      fetch: function (this: unknown) {
        receiver = this;
        return Promise.resolve(response(done));
      },
    });
    const stream = client.codexEvents(ref, { id });
    expect((await stream.next()).value?.type).toBe("task");
    await stream.return();
    client.dispose();
    expect(receiver).toBeUndefined();
  });
  it("validates descriptors and cursors before accessing a binding", async () => {
    for (const [grant, cursor] of [
      [{ type: "codex-events", id, extra: true }, 0],
      [{ type: "codex-events", id }, -1],
      [{ type: "other", id }, 0],
    ])
      await expect(
        codexEvents({}, scope, grant, cursor as number, () => {}),
      ).rejects.toThrow();
  });
  it("uses existing auth on each reconnect and resumes without replaying mutations", async () => {
    const bodies: any[] = [];
    let reads = 0;
    const client = createClient({
      url: "https://example.com/p/x/prod",
      getToken: () => `token-${reads + 1}`,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        expect(body.kind).toBe("query");
        expect(url).toEndWith("/v1/codex/events");
        expect((init?.headers as any).Authorization).toBe(
          `Bearer token-${++reads}`,
        );
        return reads === 1
          ? response(progress(1))
          : response(progress(1) + progress(2) + done);
      },
    });
    const events = [];
    for await (const e of client.codexEvents(ref, { id })) events.push(e);
    expect(events.map((x) => (x.type === "task" ? "done" : x.seq))).toEqual([
      1,
      2,
      "done",
    ]);
    expect(bodies.map((x) => x.after)).toEqual([0, 1]);
    client.dispose();
  });
  it("decodes UTF-8 chunks and does not wait for completion to deliver progress", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const client = createClient({
      url: "https://example.com",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const iterator = client.codexEvents(ref, { id });
    const first = iterator.next();
    await new Promise((r) => setTimeout(r, 0));
    for (const byte of enc.encode(progress(1)))
      controller!.enqueue(new Uint8Array([byte]));
    expect((await first).value).toMatchObject({ seq: 1, text: "Привет" });
    controller!.enqueue(enc.encode(done));
    controller!.close();
    expect((await iterator.next()).value?.type).toBe("task");
    await iterator.return();
    client.dispose();
  });
  it("stops on unauthorized responses rather than reconnecting indefinitely", async () => {
    let calls = 0;
    const client = createClient({
      url: "https://example.com",
      fetch: async () => {
        calls++;
        return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
      },
    });
    await expect(client.codexEvents(ref, { id }).next()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(calls).toBe(1);
    client.dispose();
  });
  it("rejects event gaps instead of silently losing output", async () => {
    const client = createClient({
      url: "https://example.com",
      fetch: async () => response(progress(2)),
    });
    await expect(client.codexEvents(ref, { id }).next()).rejects.toMatchObject({
      code: "CODEX_EVENT_GAP",
    });
    client.dispose();
  });
  it("rechecks session revocation before forwarding the next chunk", async () => {
    let source: ReadableStreamDefaultController<Uint8Array>,
      allowed = true,
      cancelled = false;
    const stream = await codexEvents(
      {
        APP_CAPABILITIES: JSON.stringify({
          [scope]: { codex: "APP_CODEX_TEST" },
        }),
        APP_CODEX_TEST: {
          events: async () => ({
            ok: true,
            value: new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  source = c;
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
          }),
        },
      } as any,
      scope,
      { type: "codex-events", id },
      0,
      () => {
        if (!allowed) throw Error("revoked");
      },
    );
    const reader = stream.getReader();
    const next = reader.read();
    allowed = false;
    source!.enqueue(enc.encode(progress(1)));
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("replays completed events from durable storage without starting a container", async () => {
    let released = false;
    const result = eventStream({
      after: 1,
      archive: () =>
        [1, 2]
          .map((seq) =>
            JSON.stringify({ seq, at: 1, type: "text", text: String(seq) }),
          )
          .join("\n"),
      task: () => ({ id, state: "succeeded", startedAt: 1, result: "OK" }),
      settle: async () => {},
      release: () => {
        released = true;
      },
    });
    const text = await result.text();
    expect(text).not.toContain("id: 1\n");
    expect(text).toContain("id: 2\n");
    expect(text).toContain("event: task");
    expect(released).toBe(true);
  });
});
