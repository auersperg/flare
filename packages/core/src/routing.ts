import { environment, fail, uuid } from "./security.js";

const reserved = new Set(["p", "api", "control", "health", "v1", "cdn-cgi"]);
export function projectAlias(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > 48 ||
    reserved.has(value)
  )
    fail("INVALID_ALIAS");
  return value;
}
export function defaultAlias(name: string, id: string): string {
  const stem = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return projectAlias(
    (/^[a-z]/.test(stem) ? stem : "app") + "-" + uuid(id).slice(0, 8),
  );
}
export function applicationUrl(
  base: string,
  id: string,
  env: string,
  alias?: string | null,
): string {
  return (
    base.replace(/\/$/, "") +
    (alias ? "/" + projectAlias(alias) : "/p/" + uuid(id)) +
    "/" +
    environment(env)
  );
}
export function applicationRoute(path: string) {
  const old = path.match(
    /^\/p\/([^/]+)\/(dev|prod)\/v1\/(call|live(?:\/ticket)?)$/,
  );
  const short = old
    ? null
    : path.match(/^\/([^/]+)\/(dev|prod)\/v1\/(call|live(?:\/ticket)?)$/);
  try {
    if (old)
      return {
        id: uuid(old[1]),
        alias: null,
        env: environment(old[2]),
        operation: old[3],
      };
    if (short)
      return {
        id: null,
        alias: projectAlias(short[1]),
        env: environment(short[2]),
        operation: short[3],
      };
  } catch {
    /* Invalid public paths are simply not routes. */
  }
  return null;
}

type ObjectBody = { text(): Promise<string> };
type RoutingBucket = {
  get(key: string): Promise<ObjectBody | null>;
  put(
    key: string,
    value: string,
    options: { onlyIf: { etagDoesNotMatch: string } },
  ): Promise<unknown | null>;
};
// Alias objects are write-once and never reassigned/deleted. Therefore positive
// caching cannot send an old URL to a different tenant. D1 is not in this path.
export class AliasRegistry {
  private cache = new Map<string, string>();
  private pending = new Map<string, Promise<string | null>>();
  constructor(
    private bucket: RoutingBucket,
    private capacity = 256,
  ) {}
  private remember(alias: string, id: string) {
    this.cache.delete(alias);
    this.cache.set(alias, id);
    if (this.cache.size > this.capacity)
      this.cache.delete(this.cache.keys().next().value!);
  }
  async resolve(value: string): Promise<string | null> {
    const alias = projectAlias(value);
    const cached = this.cache.get(alias);
    if (cached) {
      this.remember(alias, cached);
      return cached;
    }
    if (this.pending.has(alias)) return this.pending.get(alias)!;
    if (this.pending.size >= 64) fail("NOT_READY");
    const work = (async () => {
      const blob = await this.bucket.get("routes/" + alias + ".json");
      if (!blob) return null; // Never cache a miss; publication becomes visible immediately.
      const raw = await blob.text();
      if (raw.length > 256) fail("INVALID_ROUTE");
      const data = JSON.parse(raw);
      if (data.version !== 1 || data.alias !== alias) fail("INVALID_ROUTE");
      const id = uuid(data.projectId);
      this.remember(alias, id);
      return id;
    })();
    this.pending.set(alias, work);
    try {
      return await work;
    } finally {
      this.pending.delete(alias);
    }
  }
  async publish(value: string, projectId: string) {
    const alias = projectAlias(value),
      id = uuid(projectId);
    const created = await this.bucket.put(
      "routes/" + alias + ".json",
      JSON.stringify({ version: 1, alias, projectId: id }),
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
    if (!created && (await this.resolve(alias)) !== id) fail("CONFLICT");
    this.remember(alias, id);
  }
}
