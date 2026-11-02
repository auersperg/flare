import { fail } from "./security.js";
/** Native Queue limits: 100 messages / 256 kB. JSON bytes are measured before
 * send, with headroom for transport metadata. No custom retry or delivery state. */
export function queueBatches<T>(bodies: T[]): MessageSendRequest<T>[][] {
  const batches: MessageSendRequest<T>[][] = [];
  let batch: MessageSendRequest<T>[] = [],
    bytes = 0;
  for (const body of bodies) {
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (size > 127000) fail("TOO_LARGE");
    if (batch.length === 100 || bytes + size > 250000) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push({ body, contentType: "json" });
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
/** Bound in-batch RPC concurrency, but ack/retry each message independently. */
export async function consumeBatch<T>(
  batch: MessageBatch<T>,
  work: (body: T) => Promise<unknown>,
  failed: (body: T, error: unknown) => void,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, batch.messages.length) }, async () => {
      // Fill each free slot immediately; a slow message must not idle its peers.
      while (next < batch.messages.length) {
        const message = batch.messages[next++];
        try {
          await work(message.body);
          message.ack();
        } catch (error) {
          failed(message.body, error);
          message.retry();
        }
      }
    }),
  );
}
