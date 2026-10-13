import {
  FlareError,
  LIMITS,
  boundedJson,
  type Auth,
} from "../../flare/src/sdk/protocol.js";
export function fail(code: string): never {
  throw new FlareError(code, code);
}
export const uuid = (value: unknown): string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : fail("INVALID_ID");
export const environment = (value: unknown): "dev" | "prod" =>
  value === "dev" || value === "prod" ? value : fail("INVALID_ENV");
export async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function jsonBody(
  request: Request | Response,
  limit: number = LIMITS.inputBytes,
): Promise<any> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail("INVALID_CONTENT_TYPE");
  if (!request.body) fail("INVALID_INPUT");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail("TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    boundedJson(parsed, limit);
    return parsed;
  } catch {
    fail("INVALID_INPUT");
  }
}
const decode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const encode = (s: Uint8Array) =>
  btoa(String.fromCharCode(...s))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const encoder = new TextEncoder();
export type Oidc = { issuer: string; audience: string; jwks: string };
const jwksCache = new Map<
  string,
  {
    until: number;
    refreshAfter: number;
    keys: (JsonWebKey & { kid?: string; alg?: string })[];
    imported: Map<string, Promise<CryptoKey>>;
  }
>();
const jwksPending = new Map<
  string,
  Promise<NonNullable<ReturnType<typeof jwksCache.get>>>
>();
function loadJwks(url: string, rotation: boolean) {
  const existing = jwksPending.get(url);
  if (existing) return existing;
  const pending = (async () => {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) fail("AUTH_UNAVAILABLE");
    const raw = await jsonBody(response, 65536);
    if (!Array.isArray(raw.keys) || raw.keys.length > 16)
      fail("AUTH_UNAVAILABLE");
    const cached = {
      until: Date.now() + 300000,
      refreshAfter: rotation ? Date.now() + 60000 : 0,
      keys: raw.keys,
      imported: new Map<string, Promise<CryptoKey>>(),
    };
    if (jwksCache.size >= 32 && !jwksCache.has(url))
      jwksCache.delete(jwksCache.keys().next().value!);
    jwksCache.set(url, cached);
    return cached;
  })();
  jwksPending.set(url, pending);
  void pending.finally(() => jwksPending.delete(url)).catch(() => undefined);
  return pending;
}
export function validateOidc(value: Oidc): Oidc {
  if (
    !value ||
    typeof value.issuer !== "string" ||
    typeof value.audience !== "string" ||
    value.audience.length < 1 ||
    value.audience.length > 256
  )
    fail("INVALID_AUTH_CONFIG");
  for (const field of ["issuer", "jwks"] as const) {
    const u = new URL(value[field]);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      u.search ||
      u.hostname === "localhost" ||
      !u.hostname.includes(".") ||
      /^(\d+\.){3}\d+$/.test(u.hostname) ||
      u.hostname.includes(":")
    )
      fail("INVALID_AUTH_CONFIG");
  }
  if (new URL(value.issuer).origin !== new URL(value.jwks).origin)
    fail("INVALID_AUTH_CONFIG");
  return value;
}
function claimsAuth(claims: any, issuer: string, audience: string): Auth {
  const now = Date.now() / 1000;
  if (
    claims.iss !== issuer ||
    !(
      claims.aud === audience ||
      (Array.isArray(claims.aud) && claims.aud.includes(audience))
    ) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    (claims.nbf !== undefined &&
      (!Number.isFinite(claims.nbf) || claims.nbf > now))
  )
    fail("UNAUTHORIZED");
  const auth = {
    subject: claims.sub,
    issuer,
    expiresAt: claims.exp * 1000,
    claims,
  };
  boundedJson(auth, 1536);
  return auth;
}
export async function verifyJwt(token: string, config: Oidc): Promise<Auth> {
  validateOidc(config);
  if (token.length > 8192) fail("UNAUTHORIZED");
  try {
    const parts = token.split(".");
    if (parts.length !== 3) fail("UNAUTHORIZED");
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit)
      fail("UNAUTHORIZED");
    let cached = jwksCache.get(config.jwks);
    if (!cached || cached.until < Date.now())
      cached = await loadJwks(config.jwks, false);
    const match = () =>
      cached!.keys.find(
        (k) =>
          k.kid === header.kid &&
          k.kty === "RSA" &&
          (!k.alg || k.alg === "RS256") &&
          (!k.use || k.use === "sig"),
      );
    let jwk = match();
    if (!jwk && cached.refreshAfter <= Date.now()) {
      cached.refreshAfter = Date.now() + 60000;
      cached = await loadJwks(config.jwks, true);
      jwk = match();
    }
    if (!jwk) fail("UNAUTHORIZED");
    let imported = cached.imported.get(header.kid);
    if (!imported) {
      imported = crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      cached.imported.set(header.kid, imported);
    }
    const key = await imported;
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decode(parts[2]),
        encoder.encode(parts[0] + "." + parts[1]),
      ))
    )
      fail("UNAUTHORIZED");
    return claimsAuth(
      JSON.parse(new TextDecoder().decode(decode(parts[1]))),
      config.issuer,
      config.audience,
    );
  } catch (e) {
    if (e instanceof FlareError) throw e;
    fail("UNAUTHORIZED");
  }
}
export async function devToken(
  secret: string,
  issuer: string,
  scope: string,
  subject: string,
) {
  const header = encode(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        iss: issuer,
        aud: scope,
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + 900,
        iat: Math.floor(Date.now() / 1000),
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${header}.${payload}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(header + "." + payload))))}`;
}
export async function verifyDevToken(
  token: string,
  secret: string,
  issuer: string,
  scope: string,
): Promise<Auth> {
  try {
    if (!scope.endsWith("/dev") || !secret || token.length > 8192)
      fail("UNAUTHORIZED");
    const p = token.split(".");
    if (
      p.length !== 3 ||
      JSON.parse(new TextDecoder().decode(decode(p[0]))).alg !== "HS256"
    )
      fail("UNAUTHORIZED");
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(p[2]),
        encoder.encode(p[0] + "." + p[1]),
      ))
    )
      fail("UNAUTHORIZED");
    return claimsAuth(
      JSON.parse(new TextDecoder().decode(decode(p[1]))),
      issuer,
      scope,
    );
  } catch {
    fail("UNAUTHORIZED");
  }
}
export function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10) fail("INVALID_ORIGIN");
  return value.map((x) => {
    if (typeof x !== "string") fail("INVALID_ORIGIN");
    const u = new URL(x);
    if (
      u.origin !== x ||
      u.username ||
      u.password ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname))
      )
    )
      fail("INVALID_ORIGIN");
    return x;
  });
}
export function status(error: unknown) {
  const code = error instanceof FlareError ? error.code : "OPERATION_FAILED";
  return {
    code,
    status:
      code === "RATE_LIMITED"
        ? 429
        : ["AUTH_DISABLED", "REGISTRATION_DISABLED"].includes(code)
          ? 403
          : code === "REGISTRATION_UNAVAILABLE"
            ? 409
            : code === "UNAUTHORIZED" || code === "AUTH_EXPIRED"
              ? 401
              : code === "FORBIDDEN"
                ? 403
                : code === "NOT_FOUND" || code === "FUNCTION_NOT_FOUND"
                  ? 404
                  : ["TOO_LARGE", "BACKUP_TOO_LARGE"].includes(code)
                    ? 413
                    : ["CONFLICT", "BACKUP_BUSY", "RESTORE_NOT_EMPTY"].includes(
                          code,
                        )
                      ? 409
                      : code.startsWith("INVALID") || code === "READ_ONLY"
                        ? 400
                        : [
                              "NOT_READY",
                              "UNSUPPORTED",
                              "RESTORE_IN_PROGRESS",
                            ].includes(code)
                          ? 503
                          : 500,
  };
}

// Error classes do not survive native RPC. Serialize only deliberate public error codes.
export type RpcResult<T = unknown> =
  { ok: true; value: T } | { ok: false; code: string };
export async function capture<T>(
  work: () => Promise<T>,
): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, code: status(error).code };
  }
}
export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) fail(result.code);
  return result.value;
}

/** Workers Access has already validated the session before fetch. Never trust identity headers. */
export function accessAssertion(request: Request): string {
  const assertion = request.headers.get("CF-Access-Jwt-Assertion");
  if (assertion) return assertion;
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith("CF_Authorization="));
  if (matches.length !== 1) fail("UNAUTHORIZED");
  const token = matches[0].slice("CF_Authorization=".length);
  if (!token) fail("UNAUTHORIZED");
  return token;
}
export async function accessEmail(
  access: CloudflareAccessContext | undefined,
  audience: string,
): Promise<string> {
  if (!access || !audience || access.aud !== audience) fail("UNAUTHORIZED");
  const identity = await access.getIdentity();
  if (!identity || typeof identity.email !== "string" || !identity.email)
    fail("UNAUTHORIZED");
  return identity.email.toLowerCase();
}

/** Optional grouping for existing API clients; new projects use one default workspace. */
export function projectCustomer(value: unknown): string {
  if (value === undefined) return "Default";
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    fail("INVALID_INPUT");
  return value.trim();
}
