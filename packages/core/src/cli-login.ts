import { digest, jsonBody, fail, uuid } from "./security.js";

export interface LoginStore {
  CATALOG: D1Database;
  DASHBOARD_URL: string;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function publicLogin(
  request: Request,
  env: LoginStore,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const input = await jsonBody(request, 8192),
    path = new URL(request.url).pathname;
  if (path === "/api/cli/start") {
    if (
      !/^[a-f0-9]{64}$/.test(input.secretHash) ||
      typeof input.publicKey !== "object" ||
      input.publicKey?.kty !== "RSA"
    )
      fail("INVALID_INPUT");
    await crypto.subtle.importKey(
      "jwk",
      input.publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    await env.CATALOG.prepare("DELETE FROM cli_logins WHERE expiresAt<?")
      .bind(Date.now())
      .run();
    const id = crypto.randomUUID(),
      code = crypto.randomUUID().slice(0, 8).toUpperCase();
    await env.CATALOG.prepare(
      "INSERT INTO cli_logins (id,secretHash,publicKey,code,expiresAt) VALUES (?,?,?,?,?)",
    )
      .bind(
        id,
        input.secretHash,
        JSON.stringify(input.publicKey),
        code,
        Date.now() + 600000,
      )
      .run();
    return json({
      id,
      code,
      dashboard: env.DASHBOARD_URL,
      expiresIn: 600,
      interval: 3,
    });
  }
  if (path !== "/api/cli/poll") fail("NOT_FOUND");
  const id = uuid(input.id);
  if (typeof input.secret !== "string" || !/^[a-f0-9]{64}$/.test(input.secret))
    fail("UNAUTHORIZED");
  const hash = await digest(input.secret);
  // Atomic claim: only one poll can receive the encrypted credential.
  const result = await env.CATALOG.prepare(
    "DELETE FROM cli_logins WHERE id=? AND secretHash=? AND expiresAt>? AND payload IS NOT NULL RETURNING payload",
  )
    .bind(id, hash, Date.now())
    .first<{ payload: string }>();
  if (result) return json(JSON.parse(result.payload));
  const pending = await env.CATALOG.prepare(
    "SELECT id FROM cli_logins WHERE id=? AND secretHash=? AND expiresAt>?",
  )
    .bind(id, hash, Date.now())
    .first();
  if (!pending) fail("UNAUTHORIZED");
  return json({ pending: true }, 202);
}
export async function loginInfo(env: LoginStore, id: string) {
  const row = await env.CATALOG.prepare(
    "SELECT code,expiresAt,payload FROM cli_logins WHERE id=? AND expiresAt>?",
  )
    .bind(uuid(id), Date.now())
    .first<{ code: string; expiresAt: number; payload: string | null }>();
  if (!row || row.payload) fail("NOT_FOUND");
  return { code: row.code, expiresAt: row.expiresAt };
}
export async function approveLogin(
  env: LoginStore,
  id: string,
  project: string,
  email: string,
  platform: string,
) {
  const row = await env.CATALOG.prepare(
    "SELECT publicKey FROM cli_logins WHERE id=? AND expiresAt>? AND payload IS NULL",
  )
    .bind(uuid(id), Date.now())
    .first<{ publicKey: string }>();
  if (!row) fail("NOT_FOUND");
  const token = crypto.randomUUID() + crypto.randomUUID(),
    expiresAt = Date.now() + 30 * 86400000;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(row.publicKey),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const cipher = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(token),
  );
  const encrypted = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  // Minting and approval are conditional on the same still-pending session.
  const results = await env.CATALOG.batch([
    env.CATALOG.prepare(
      "INSERT INTO credentials (hash,projectId,actor,expiresAt,revoked) SELECT ?,?,?,?,0 WHERE EXISTS (SELECT 1 FROM cli_logins WHERE id=? AND expiresAt>? AND payload IS NULL)",
    ).bind(
      await digest(token),
      uuid(project),
      email,
      expiresAt,
      id,
      Date.now(),
    ),
    env.CATALOG.prepare(
      "UPDATE cli_logins SET payload=? WHERE id=? AND expiresAt>? AND payload IS NULL",
    ).bind(
      JSON.stringify({ encrypted, platform, project, expiresAt }),
      id,
      Date.now(),
    ),
  ]);
  if (!results[1].meta.changes) fail("CONFLICT");
  return { ok: true };
}
