import { describe, it, expect } from "bun:test";
import { fileMetadata, uploadFile } from "../packages/flare/src/sdk/client";
import { LIMITS } from "../packages/flare/src/sdk/protocol";
describe("thin file client", () => {
  it.each([200, 400, 500])(
    "cancels oversized upload confirmations without trusting Content-Length (%s)",
    async (status) => {
      let reads = 0,
        cancelled = false,
        calls = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (++reads <= 10)
              controller.enqueue(new Uint8Array(65536).fill(32));
            else {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"id":"proof","error":"INVALID_INPUT"}',
                ),
              );
              controller.close();
            }
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status, headers: { "content-length": "1" } },
      );
      await expect(
        uploadFile({ url: "https://example.test/upload" }, new Blob(["x"]), {
          fetch: async () => {
            calls++;
            return response;
          },
        }),
      ).rejects.toMatchObject({
        code: status === 200 ? "INVALID_RESPONSE" : `HTTP_${status}`,
        ambiguous: status === 200 || status >= 500,
      });
      expect(cancelled).toBe(true);
      expect(reads).toBeLessThanOrEqual(6);
      expect(calls).toBe(1);
    },
  );
  it("accepts an exact-limit confirmation and rejects malformed UTF-8", async () => {
    const json = '{"id":"proof"}';
    const grant = { url: "https://example.test/upload" },
      file = new Blob(["x"]);
    await expect(
      uploadFile(grant, file, {
        fetch: async () =>
          new Response(" ".repeat(LIMITS.outputBytes - json.length) + json),
      }),
    ).resolves.toEqual({ id: "proof" });
    await expect(
      uploadFile(grant, file, {
        fetch: async () =>
          new Response(
            new Uint8Array([123, 34, 105, 100, 34, 58, 34, 255, 34, 125]),
          ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", ambiguous: true });
  });
  it.each(["deadline", "caller"])(
    "honors both the upload deadline and caller cancellation (%s)",
    async (reason) => {
      const controller = new AbortController();
      let calls = 0;
      const result = uploadFile(
        { url: "https://example.test/upload" },
        new Blob(["x"]),
        {
          signal: controller.signal,
          timeoutMs: reason === "deadline" ? 1 : 10000,
          fetch: (_url, options) => {
            calls++;
            return new Promise<Response>((_resolve, reject) => {
              const signal = options.signal!;
              const abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          },
        },
      ).catch((error) => error);
      try {
        if (reason === "caller") controller.abort();
        expect(
          await Promise.race([
            result,
            Bun.sleep(100).then(() => "not aborted"),
          ]),
        ).toMatchObject({ code: "UPLOAD_UNKNOWN", ambiguous: true });
        expect(calls).toBe(1);
        expect(controller.signal.aborted).toBe(reason === "caller");
      } finally {
        controller.abort();
        await result;
      }
    },
  );
  it("retains safe formats and treats unknown formats as downloadable binary", () => {
    expect(
      fileMetadata(new File(["abc"], "photo.heic", { type: "image/heic" })),
    ).toEqual({
      name: "photo.heic",
      size: 3,
      type: "application/octet-stream",
    });
    expect(
      fileMetadata(new File(["abc"], "proof.pdf", { type: "application/pdf" }))
        .type,
    ).toBe("application/pdf");
    expect(() => fileMetadata(new File(["x"], "../path"))).toThrow();
    expect(() =>
      fileMetadata(new File([new Uint8Array(10485761)], "large")),
    ).toThrow();
  });
  it("streams the original Blob once, omits cookies and preserves server error codes", async () => {
    let calls = 0;
    const body = new File(["x"], "x.txt");
    const transport = async (_url: string, options: RequestInit) => {
      calls++;
      expect(options?.body).toBe(body);
      expect(options?.credentials).toBe("omit");
      expect(options?.redirect).toBe("error");
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    };
    await expect(
      uploadFile({ url: "https://example.test/upload" }, body, {
        fetch: transport,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toBe(1);
    await expect(
      uploadFile({ url: "https://example.test/upload" }, body, {
        fetch: async () =>
          Response.json({ error: "OPERATION_FAILED" }, { status: 500 }),
      }),
    ).rejects.toMatchObject({ code: "OPERATION_FAILED", ambiguous: true });
  });
  it("validates completion and never retries ambiguous network failures", async () => {
    const body = new Blob(["x"]);
    await expect(
      uploadFile({ url: "https://example.test/upload" }, body, {
        fetch: async () => Response.json({ id: "proof" }),
      }),
    ).resolves.toEqual({ id: "proof" });
    await expect(
      uploadFile({ url: "https://example.test/upload" }, body, {
        fetch: async () => Response.json({}),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    let calls = 0;
    await expect(
      uploadFile({ url: "https://example.test/upload" }, body, {
        fetch: async () => {
          calls++;
          throw Error("connection lost");
        },
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_UNKNOWN", ambiguous: true });
    expect(calls).toBe(1);
    await expect(
      uploadFile({ url: "http://remote.test/upload" }, body),
    ).rejects.toMatchObject({ code: "INVALID_URL" });
  });
});
