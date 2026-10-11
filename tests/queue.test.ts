import { describe, expect, it } from "bun:test";
import { queueBatches, consumeBatch } from "../packages/core/src/queue";
describe("native Queue batching", () => {
  it("bounds both message count and UTF-8 bytes without losing order", () => {
    const bodies = Array.from({ length: 235 }, (_, id) => ({
      id,
      text: "é".repeat(1200),
    }));
    const batches = queueBatches(bodies);
    expect(batches.flat().map((message) => message.body)).toEqual(bodies);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(
        batch.reduce(
          (sum, m) =>
            sum + new TextEncoder().encode(JSON.stringify(m.body)).byteLength,
          0,
        ),
      ).toBeLessThanOrEqual(250000);
      expect(batch.every((message) => message.contentType === "json")).toBe(
        true,
      );
    }
    expect(queueBatches([])).toEqual([]);
  });
  it("rejects oversized messages before sending any batch", () => {
    expect(() => queueBatches([{ text: "x".repeat(127000) }])).toThrow();
  });
  it("runs at most four messages in parallel and retries only failures", async () => {
    let active = 0,
      maximum = 0;
    const acked: number[] = [],
      retried: number[] = [],
      errors: number[] = [];
    const messages = Array.from({ length: 11 }, (_, body) => ({
      body,
      ack: () => acked.push(body),
      retry: () => retried.push(body),
    }));
    await consumeBatch<number>(
      { messages } as any,
      async (body) => {
        active++;
        maximum = Math.max(active, maximum);
        await Bun.sleep(1);
        active--;
        if (body === 3 || body === 8) throw Error("transient");
      },
      (body) => {
        errors.push(body);
      },
    );
    expect(maximum).toBe(4);
    expect(acked.sort((a, b) => a - b)).toEqual([0, 1, 2, 4, 5, 6, 7, 9, 10]);
    expect(retried).toEqual([3, 8]);
    expect(errors).toEqual(retried);
  });
});
