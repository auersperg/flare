import { stableJson, type Json } from "../../flared/src/sdk/protocol.js";
import { digest } from "./security.js";

/** Table-level invalidation, not a distributed read-set engine. Revision maps commit with app data. */
export function needsSnapshot(
  subscription: {
    dependencies: string | null;
    checked: number;
    release: string | null;
  },
  release: string,
  changes: Record<string, number>,
): boolean {
  if (subscription.release !== release || subscription.dependencies == null)
    return true;
  const tables: unknown = JSON.parse(subscription.dependencies);
  if (
    !Array.isArray(tables) ||
    !tables.every((table) => typeof table === "string")
  )
    return true;
  return tables.some((table) => (changes[table] ?? 0) > subscription.checked);
}
type Snapshot = { result: Json; revision: number; tables: string[] };
/** Per-broadcast only: no stale data or identity can survive a commit/reconnect. */
export class SnapshotCache {
  private entries = new Map<
    string,
    { value: Snapshot; hash: string; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private maxBytes = 4 * 1048576,
    private maxEntries = 64,
  ) {}
  async get(key: string, load: () => Promise<Snapshot>) {
    const cached = this.entries.get(key);
    if (cached) return cached;
    const value = await load();
    const encoded = stableJson(value.result);
    const entry = {
      value,
      hash: await digest(encoded),
      bytes: new TextEncoder().encode(
        key + encoded + JSON.stringify(value.tables),
      ).byteLength,
    };
    if (entry.bytes <= this.maxBytes && this.maxEntries > 0) {
      while (
        this.entries.size &&
        (this.bytes + entry.bytes > this.maxBytes ||
          this.entries.size >= this.maxEntries)
      ) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes;
        this.entries.delete(oldest);
      }
      this.entries.set(key, entry);
      this.bytes += entry.bytes;
    }
    return entry;
  }
}
