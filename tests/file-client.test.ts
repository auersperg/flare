import { describe, it, expect } from "bun:test";
import { fileMetadata, uploadFile } from "../packages/flare/src/sdk/client";
describe("thin file client", () => {
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
