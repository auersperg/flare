export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type FunctionKind = "query" | "mutation" | "action";
export type Auth = {
  subject: string;
  issuer: string;
  expiresAt: number;
  claims: Record<string, Json>;
};
export const LIMITS = Object.freeze({
  inputBytes: 65536,
  outputBytes: 262144,
  frameBytes: 8192,
  subscriptions: 64,
  fileBytes: 10485760,
});
export interface FunctionRef<I = Json, O = Json> {
  readonly path: string;
  readonly kind: FunctionKind;
  readonly __input?: I;
  readonly __output?: O;
}
export class FlaredError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "FlaredError";
  }
}
export function assertPath(path: string): void {
  if (
    path.length > 256 ||
    !/^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/.test(path) ||
    path
      .split("/")
      .some((p) => ["__proto__", "prototype", "constructor"].includes(p))
  ) {
    throw new FlaredError("INVALID_PATH", "Invalid function path");
  }
}
export function reference<I, O>(
  path: string,
  kind: FunctionKind,
): FunctionRef<I, O> {
  assertPath(path);
  return Object.freeze({ path, kind });
}
/** Lossless JSON only: no implicit Date, undefined, NaN or prototype coercion. */
export function stableJson(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): Json {
    if (depth > 40)
      throw new FlaredError("INVALID_JSON", "JSON nesting limit exceeded");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object" || v === null || ancestors.has(v))
      throw new FlaredError("INVALID_JSON", "Expected lossless JSON");
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    ) {
      throw new FlaredError("INVALID_JSON", "Expected plain JSON object");
    }
    if (Object.getOwnPropertySymbols(v).length)
      throw new FlaredError("INVALID_JSON", "Symbol keys are unsupported");
    ancestors.add(v);
    let result: Json;
    if (Array.isArray(v)) {
      result = Array.from(v, (item) => visit(item, depth + 1));
    } else {
      const out: Record<string, Json> = Object.create(null);
      for (const key of Object.keys(v).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in descriptor))
          throw new FlaredError("INVALID_JSON", "Getters are unsupported");
        out[key] = visit(descriptor.value, depth + 1);
      }
      result = out;
    }
    ancestors.delete(v);
    return result;
  }
  return JSON.stringify(visit(value, 0));
}
export function boundedJson(value: unknown, maxBytes: number): string {
  const json = stableJson(value);
  if (new TextEncoder().encode(json).byteLength > maxBytes)
    throw new FlaredError("TOO_LARGE", "JSON payload exceeds limit");
  return json;
}
export interface FunctionContract {
  kind: FunctionKind;
  auth: "required" | "public" | "internal";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}
export interface Manifest {
  protocol: 1;
  runtimeAbi: 4;
  functions: Record<string, FunctionContract>;
}
