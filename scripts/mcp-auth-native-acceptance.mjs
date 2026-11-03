import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const scratch = await mkdtemp(join(tmpdir(), "flare-mcp-oauth-"));
let mf;
try {
  const build = spawnSync(
    "bun",
    [
      "build",
      "packages/mcp-auth/src/index.ts",
      "--target=browser",
      "--external=cloudflare:workers",
      "--outdir",
      scratch,
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const scope = "00000000-0000-4000-8000-000000000001/prod";
  const resource = `https://api.example.test/p/${scope}/v1/mcp`,
    issuer = "https://auth.example.test";
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "oauth",
          modules: true,
          script: await readFile(join(scratch, "index.js"), "utf8"),
          compatibilityDate: "2026-10-13",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          bindings: {
            AUTH_ISSUER: issuer,
            MCP_RESOURCE: resource,
            APP_ORIGIN: "https://app.example.test",
            OWNER_LOGIN: "owner@example.test",
          },
          kvNamespaces: ["OAUTH_KV"],
          serviceBindings: { RUNTIME: "runtime" },
          ratelimits: {
            RATE_LIMITER: {
              namespace_id: "1",
              simple: { limit: 1000, period: 60 },
            },
          },
          outboundService: () =>
            new Response("No external traffic in acceptance", { status: 503 }),
        },
        {
          name: "runtime",
          modules: true,
          compatibilityDate: "2026-10-13",
          serviceBindings: {
            OAUTH: { name: "oauth", entrypoint: "McpAuthorization" },
          },
          script: `export default { async fetch(r,env) { const u=new URL(r.url); if(u.pathname==='/validate') { const v=await env.OAUTH.validateToken(${JSON.stringify(resource)},r.headers.get('authorization')); return Response.json(v); } const b=await r.json(); if ((u.pathname.endsWith('/delegate') && b.login==='owner@example.test' && b.password==='native-fixture-password') || (u.pathname.endsWith('/mcp-identity') && r.headers.get('authorization')==='Bearer flared_session_fixture')) return Response.json({ userId:'00000000-0000-4000-8000-000000000002', epoch:'fixture-epoch', login:'owner@example.test', scope:${JSON.stringify(scope)} }); return new Response('Unauthorized',{status:401}); } }`,
        },
      ],
    }),
  );
  const runtime = await mf.getWorker("runtime");
  const request = (path, init = {}) =>
    mf.dispatchFetch(issuer + path, { redirect: "manual", ...init });
  for (const path of ["/oauth/token", "/oauth/register"]) {
    const oversized = await request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "x=" + "a".repeat(16384),
    });
    assert.equal(oversized.status, 413);
  }
  let response = await request("/.well-known/oauth-authorization-server");
  const metadata = await response.json();
  assert.equal(metadata.issuer, issuer);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  const registration = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "<script>bad</script> Native proof",
      redirect_uris: ["http://127.0.0.1:9100/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = "a".repeat(64),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:9100/callback",
    response_type: "code",
    scope: "mcp:read offline_access",
    state: "proof-state",
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  response = await request("/authorize?" + params);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.ok(!page.includes("<script>bad</script>"));
  assert.ok(page.includes("127.0.0.1"));
  assert.ok(
    response.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  const handle = page.match(/name="handle" value="([^"]+)"/)[1];
  const cookie = response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const form = new URLSearchParams({
    handle,
    login: "owner@example.test",
    password: "native-fixture-password",
    decision: "approve",
  });
  form.append("scope", "mcp:read");
  form.append("scope", "offline_access");
  const approve = (extra = {}) =>
    request("/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: issuer,
        cookie,
        ...extra,
      },
      body: form.toString(),
    });
  assert.equal(
    (await approve({ origin: "https://attacker.test" })).status,
    403,
  );
  {
    const missing = await approve({ cookie: "" });
    assert.ok([400, 403].includes(missing.status), await missing.text());
  }
  response = await approve();
  assert.equal(response.status, 302, await response.clone().text());
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "proof-state");
  assert.equal(callback.searchParams.get("iss"), issuer);
  assert.equal((await approve()).status, 400);
  const code = callback.searchParams.get("code");
  const exchange = (body) =>
    request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  const input = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: "http://127.0.0.1:9100/callback",
    resource,
  };
  assert.equal(
    (await exchange({ ...input, code_verifier: "b".repeat(64) })).status,
    400,
  );
  response = await exchange(input);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.expires_in, 300);
  const validate = async (token) =>
    (
      await runtime.fetch("https://api.example.test/validate", {
        headers: { authorization: token },
      })
    ).json();
  const validated = await validate(tokens.access_token);
  assert.equal(validated.props.scope, scope);
  assert.ok(validated.scope.includes("mcp:read"));
  assert.ok(!validated.scope.includes("mcp:write"));
  response = await exchange({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource,
  });
  assert.equal(response.status, 200);
  const refreshed = await response.json();
  assert.ok(await validate(refreshed.access_token));
  const connections = async (body) =>
    request("/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.example.test",
        authorization: "Bearer flared_session_fixture",
      },
      body: JSON.stringify(body),
    });
  const listed = await (await connections({})).json();
  assert.equal(listed.grants.length, 1);
  assert.ok(!JSON.stringify(listed).includes(tokens.access_token));
  response = await connections({ revoke: listed.grants[0].id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).grants.length, 0);
  assert.equal(await validate(refreshed.access_token), null);
  assert.equal((await exchange(input)).status, 400);
  // A separate, explicitly approved write grant, without offline access.
  response = await request("/authorize?" + params);
  const writePage = await response.text();
  const writeForm = new URLSearchParams({
    handle: writePage.match(/name="handle" value="([^"]+)"/)[1],
    login: "owner@example.test",
    password: "native-fixture-password",
    decision: "approve",
  });
  writeForm.append("scope", "mcp:read");
  writeForm.append("scope", "mcp:write");
  response = await request("/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: issuer,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    },
    body: writeForm.toString(),
  });
  assert.equal(response.status, 302);
  const writeInput = {
    ...input,
    code: new URL(response.headers.get("location")).searchParams.get("code"),
  };
  response = await exchange(writeInput);
  assert.equal(response.status, 200);
  const writeTokens = await response.json();
  assert.ok(!writeTokens.refresh_token);
  assert.ok(
    (await validate(writeTokens.access_token)).scope.includes("mcp:write"),
  );
  assert.equal((await exchange(writeInput)).status, 400);
  assert.equal(
    await validate(writeTokens.access_token),
    null,
    "Code replay must revoke the affected grant",
  );
  assert.equal((await connections(null)).status, 400);
  assert.equal(
    (
      await request("/connections", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/connections", {
        method: "POST",
        headers: { origin: "https://app.example.test" },
      })
    ).status,
    401,
  );
  const bad = new URLSearchParams(params);
  bad.set("redirect_uri", "https://attacker.test/steal");
  response = await request("/authorize?" + bad);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
  console.log(
    "PASS: native OAuth metadata, DCR, escaped consent, CSRF/browser binding, PKCE, one-time code, audience, read-only scope, refresh, grant listing and revocation",
  );
} finally {
  await mf?.dispose();
  await rm(scratch, { recursive: true, force: true });
}
