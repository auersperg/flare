import { describe, expect, it, jest } from "bun:test";
import { readBody } from "../packages/flare/src/sdk/http.js";
import { createClient } from "../packages/flare/src/sdk/client.js";
import { reference } from "../packages/flare/src/sdk/protocol.js";
import { jsonBody } from "../packages/core/src/security.js";

const overflow = () => {
  throw new Error("limit");
};
function body(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}
describe("shared bounded HTTP reader", () => {
  it("does not copy a single chunk and accepts the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("🔥");
    expect(await readBody(body([bytes]), 4, overflow)).toBe(bytes);
    await expect(readBody(body([bytes]), 3, overflow)).rejects.toThrow("limit");
  });
  it("joins chunks in order and accepts an empty stream", async () => {
    expect(
      await readBody(
        body([new Uint8Array([1, 2]), new Uint8Array([3])]),
        3,
        overflow,
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readBody(body([]), 0, overflow)).toEqual(new Uint8Array());
  });
  it("cancels an oversized stream and preserves the error if cancellation fails", async () => {
    const cancel = jest.fn(() => {
      throw Error("cancel failed");
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(11));
      },
      cancel,
    });
    await expect(readBody(stream, 10, overflow)).rejects.toThrow("limit");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("preserves a stream read failure", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(Error("interrupted"));
      },
    });
    await expect(readBody(stream, 10, overflow)).rejects.toThrow("interrupted");
  });
  it("decodes UTF-8 split across chunks on both sides of the HTTP boundary", async () => {
    const bytes = new TextEncoder().encode('{"result":"🔥你好"}');
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const response = () =>
      new Response(body(chunks), {
        headers: { "content-type": "application/json" },
      });
    expect(await jsonBody(response())).toEqual({ result: "🔥你好" });
    const client = createClient({
      url: "https://backend.example",
      fetch: async () => response(),
    });
    try {
      expect(await client.query(reference("x", "query"), {})).toBe("🔥你好");
    } finally {
      client.dispose();
    }
  });
  it("rejects incomplete UTF-8 and preserves ambiguous write semantics", async () => {
    const response = () =>
      new Response(body([new Uint8Array([0x22, 0xf0, 0x9f])]), {
        headers: { "content-type": "application/json" },
      });
    await expect(jsonBody(response())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const client = createClient({
      url: "https://backend.example",
      fetch: async () => response(),
    });
    try {
      await expect(
        client.mutation(reference("x", "mutation"), {}),
      ).rejects.toMatchObject({ code: "TRANSPORT_ERROR", ambiguous: true });
    } finally {
      client.dispose();
    }
  });
});
