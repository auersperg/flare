declare const FLARED_DASHBOARD_CSP_HASHES: {
  scripts: string[];
  styles: string[];
};
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ScopeConfig } from "./runtime.js";
import {
  digest,
  uuid,
  environment,
  origins,
  validateOidc,
  accessEmail,
  accessAssertion,
  verifyJwt,
  jsonBody,
  fail,
  status,
  unwrap,
  type RpcResult,
} from "./security.js";
import type { ReleaseUpload } from "./release.js";
import { applicationUrl, defaultAlias, projectAlias } from "./routing.js";
type Role = "owner" | "editor" | "viewer";
type Actor = { email: string; role: Role; projectId: string | null };
type RuntimeApi = {
  configure(config: ScopeConfig): Promise<void>;
  deploy(
    scope: string,
    bundle: ReleaseUpload,
  ): Promise<{ hash: string; unchanged: boolean }>;
  admin(scope: string, op: string, input: any): Promise<any>;
  devIdentity(scope: string, subject: string): Promise<string>;
  publishAlias(alias: string, projectId: string): Promise<void>;
};
interface Env {
  CATALOG: D1Database;
  RUNTIME: { command(op: string, args: any[]): Promise<RpcResult<any>> };
  ASSETS: Fetcher;
  RUNTIME_URL: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
}
function runtime(env: Env): RuntimeApi {
  return new Proxy({} as RuntimeApi, {
    get:
      (_target, key) =>
      (...args: any[]) =>
        env.RUNTIME.command(String(key), args).then(unwrap),
  });
}
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
async function actor(
  request: Request,
  env: Env,
  credentialsOnly = false,
  ctx?: ExecutionContext,
): Promise<Actor> {
  if (credentialsOnly) {
    const bearer = request.headers.get("authorization");
    if (!bearer?.startsWith("Bearer ") || bearer.length > 256)
      fail("UNAUTHORIZED");
    const row = await env.CATALOG.prepare(
      "SELECT c.actor,c.projectId,m.role FROM credentials c JOIN members m ON m.email=c.actor WHERE c.hash=? AND c.revoked=0 AND c.expiresAt>?",
    )
      .bind(await digest(bearer.slice(7)), Date.now())
      .first<any>();
    if (!row || row.role === "viewer") fail("UNAUTHORIZED");
    return { email: row.actor, role: row.role, projectId: row.projectId };
  }
  // Static Assets' internal router does not forward native ctx.access.
  // Its Access cookie/assertion must still be cryptographically verified.
  const email = ctx?.access
    ? await accessEmail(ctx.access, env.ACCESS_AUD)
    : String(
        (
          await verifyJwt(accessAssertion(request), {
            issuer: env.ACCESS_ISSUER,
            audience: env.ACCESS_AUD,
            jwks: env.ACCESS_ISSUER + "/cdn-cgi/access/certs",
          })
        ).claims.email ?? "",
      ).toLowerCase();
  if (!email || email.length > 254) fail("UNAUTHORIZED");
  const member = await env.CATALOG.prepare(
    "SELECT role FROM members WHERE email=?",
  )
    .bind(email)
    .first<{ role: Role }>();
  if (!member) fail("FORBIDDEN");
  return { email: email.toLowerCase(), role: member.role, projectId: null };
}
const writable = (a: Actor) => {
  if (a.role === "viewer") fail("FORBIDDEN");
};
async function audit(
  env: Env,
  a: Actor,
  projectId: string | null,
  which: string | null,
  operation: string,
  work: () => Promise<unknown>,
) {
  const id = crypto.randomUUID();
  await env.CATALOG.prepare("INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, Date.now(), a.email, projectId, which, operation, "pending", "{}")
    .run();
  try {
    const result = await work();
    await env.CATALOG.prepare("UPDATE audit SET status='ok' WHERE id=?")
      .bind(id)
      .run();
    return result;
  } catch (e) {
    await env.CATALOG.prepare(
      "UPDATE audit SET status='error',detail=? WHERE id=?",
    )
      .bind(JSON.stringify({ code: status(e).code }), id)
      .run();
    throw e;
  }
}
async function bootstrap(env: Env): Promise<ReleaseUpload> {
  const get = async (path: string) =>
    (
      await env.ASSETS.fetch(
        new Request("https://assets.internal/bootstrap/" + path),
      )
    ).text();
  return {
    release: JSON.parse(await get("release.json")),
    manifest: JSON.parse(await get("manifest.json")),
    migrations: JSON.parse(await get("migrations.json")),
    facet: await get("facet.js"),
    action: await get("action.js"),
  };
}
async function publishAlias(env: Env, id: string, alias: string) {
  projectAlias(alias);
  // Reserve in the unique catalog before publishing. A failed RPC leaves a
  // retryable reservation, never a visible URL pointing at the wrong database.
  await env.CATALOG.prepare(
    "INSERT INTO project_aliases (projectId,alias) VALUES (?,?) ON CONFLICT DO NOTHING",
  )
    .bind(id, alias)
    .run();
  const reserved = await env.CATALOG.prepare(
    "SELECT alias FROM project_aliases WHERE projectId=?",
  )
    .bind(id)
    .first<{ alias: string }>();
  if (reserved?.alias !== alias) fail("CONFLICT");
  await runtime(env).publishAlias(alias, id);
  await env.CATALOG.prepare(
    "UPDATE project_aliases SET published=1 WHERE projectId=? AND alias=?",
  )
    .bind(id, alias)
    .run();
  return { alias };
}
async function api(request: Request, env: Env, a: Actor): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/api/session" && request.method === "GET")
    return json({
      email: a.email,
      role: a.role,
      projectId: a.projectId,
      runtime: env.RUNTIME_URL,
      version: "0.2.0",
      stage: "private-minimum",
    });
  if (path === "/api/projects" && request.method === "GET") {
    const rows = await env.CATALOG.prepare(
      "SELECT p.*,c.name customer,r.alias FROM projects p JOIN customers c ON c.id=p.customerId LEFT JOIN project_aliases r ON r.projectId=p.id AND r.published=1 WHERE (? IS NULL OR p.id=?) ORDER BY p.createdAt DESC LIMIT 100",
    )
      .bind(a.projectId, a.projectId)
      .all();
    return json(rows.results);
  }
  if (path === "/api/projects" && request.method === "POST") {
    if (a.projectId) fail("FORBIDDEN");
    writable(a);
    const input = await jsonBody(request);
    for (const field of ["name", "customer"])
      if (
        typeof input[field] !== "string" ||
        input[field].trim().length < 1 ||
        input[field].length > 100
      )
        fail("INVALID_INPUT");
    const customer = await env.CATALOG.prepare(
      "SELECT id FROM customers WHERE name=? COLLATE NOCASE LIMIT 1",
    )
      .bind(input.customer.trim())
      .first<{ id: string }>();
    const id = crypto.randomUUID(),
      customerId = customer?.id ?? crypto.randomUUID(),
      at = Date.now();
    const alias = input.alias
      ? projectAlias(input.alias)
      : defaultAlias(input.name, id);
    if (
      await env.CATALOG.prepare(
        "SELECT projectId FROM project_aliases WHERE alias=?",
      )
        .bind(alias)
        .first()
    )
      fail("CONFLICT");
    const allowed = origins(input.origins ?? []);
    const result = await audit(env, a, id, null, "project.create", async () => {
      await env.CATALOG.batch([
        ...(customer
          ? []
          : [
              env.CATALOG.prepare("INSERT INTO customers VALUES (?,?,?)").bind(
                customerId,
                input.customer.trim(),
                at,
              ),
            ]),
        env.CATALOG.prepare("INSERT INTO projects VALUES (?,?,?,?)").bind(
          id,
          customerId,
          input.name.trim(),
          at,
        ),
        env.CATALOG.prepare(
          "INSERT INTO project_aliases (projectId,alias) VALUES (?,?)",
        ).bind(id, alias),
        ...(["dev", "prod"] as const).map((e) =>
          env.CATALOG.prepare(
            "INSERT INTO environments (projectId,env,origins) VALUES (?,?,?)",
          ).bind(id, e, JSON.stringify(allowed)),
        ),
      ]);
      const bundle = await bootstrap(env);
      for (const e of ["dev", "prod"]) {
        await runtime(env).configure({
          scope: `${id}/${e}`,
          origins: allowed,
          oidc: null,
        });
        await runtime(env).deploy(`${id}/${e}`, bundle);
      }
      await publishAlias(env, id, alias);
      return { id, alias };
    });
    return json(result, 201);
  }
  const match = path.match(
    /^\/api\/projects\/([^/]+)(?:\/(alias|dev|prod)(?:\/([a-z-]+))?)?$/,
  );
  if (!match) fail("NOT_FOUND");
  const projectId = uuid(match[1]);
  if (a.projectId && a.projectId !== projectId) fail("FORBIDDEN");
  const project = await env.CATALOG.prepare(
    "SELECT p.*,r.alias FROM projects p LEFT JOIN project_aliases r ON r.projectId=p.id AND r.published=1 WHERE p.id=?",
  )
    .bind(projectId)
    .first<{ id: string; alias: string | null }>();
  if (!project) fail("NOT_FOUND");
  if (match[2] === "alias") {
    if (request.method !== "POST")
      return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (a.role !== "owner" || a.projectId) fail("FORBIDDEN");
    const input = await jsonBody(request);
    const alias = projectAlias(input.alias);
    return json(
      await audit(env, a, projectId, null, "project.alias", () =>
        publishAlias(env, projectId, alias),
      ),
    );
  }
  if (!match[2])
    return json({
      project,
      environments: (
        await env.CATALOG.prepare(
          "SELECT * FROM environments WHERE projectId=?",
        )
          .bind(projectId)
          .all()
      ).results,
      runtime: env.RUNTIME_URL,
      urls: Object.fromEntries(
        ["dev", "prod"].map((e) => [
          e,
          applicationUrl(env.RUNTIME_URL, projectId, e, project.alias),
        ]),
      ),
    });
  const which = environment(match[2]),
    scope = `${projectId}/${which}`,
    op = match[3] ?? "health";
  if (request.method === "GET") {
    if (op === "settings") {
      const row = await env.CATALOG.prepare(
        "SELECT * FROM environments WHERE projectId=? AND env=?",
      )
        .bind(projectId, which)
        .first<any>();
      return json({
        ...row,
        origins: JSON.parse(row.origins),
        oidc: row.oidc ? JSON.parse(row.oidc) : null,
        url: applicationUrl(env.RUNTIME_URL, projectId, which, project.alias),
        alias: project.alias,
      });
    }
    if (op === "audit")
      return json(
        (
          await env.CATALOG.prepare(
            "SELECT * FROM audit WHERE projectId=? ORDER BY at DESC LIMIT 100",
          )
            .bind(projectId)
            .all()
        ).results,
      );
    const input: any = {};
    if (url.searchParams.has("table"))
      input.table = url.searchParams.get("table");
    if (url.searchParams.has("cursor")) {
      try {
        input.cursor = JSON.parse(url.searchParams.get("cursor")!);
      } catch {
        fail("INVALID_INPUT");
      }
    }
    return json(await runtime(env).admin(scope, op, input));
  }
  if (request.method !== "POST")
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  writable(a);
  const input = await jsonBody(request, op === "deploy" ? 4 * 1048576 : 65536);
  if (which === "prod" && input.confirm !== projectId)
    fail("INVALID_CONFIRMATION");
  if (op === "deploy") {
    const result = await audit(env, a, projectId, which, "release.deploy", () =>
      runtime(env).deploy(scope, input.bundle),
    );
    return json({
      ...(result as object),
      url: applicationUrl(env.RUNTIME_URL, projectId, which, project.alias),
    });
  }
  if (op === "edit")
    return json(
      await audit(env, a, projectId, which, "data." + input.operation, () =>
        runtime(env).admin(scope, "edit", input),
      ),
    );
  if (op === "settings") {
    const allowed = origins(input.origins),
      oidc = input.oidc ? validateOidc(input.oidc) : null;
    return json(
      await audit(env, a, projectId, which, "settings.update", async () => {
        // Runtime is the data-plane authority. D1 mirrors the acknowledged configuration.
        await runtime(env).configure({ scope, origins: allowed, oidc });
        await env.CATALOG.prepare(
          "UPDATE environments SET origins=?,oidc=? WHERE projectId=? AND env=?",
        )
          .bind(
            JSON.stringify(allowed),
            oidc ? JSON.stringify(oidc) : null,
            projectId,
            which,
          )
          .run();
        return { ok: true };
      }),
    );
  }
  if (op === "dev-token") {
    if (which !== "dev" || a.projectId) fail("FORBIDDEN");
    return json({
      token: await runtime(env).devIdentity(scope, a.email),
      expiresIn: 900,
      url: applicationUrl(env.RUNTIME_URL, projectId, which, project.alias),
    });
  }
  if (op === "credential") {
    if (a.role !== "owner" || a.projectId) fail("FORBIDDEN");
    const token = crypto.randomUUID() + crypto.randomUUID();
    await audit(env, a, projectId, which, "credential.issue", async () => {
      await env.CATALOG.prepare("INSERT INTO credentials VALUES (?,?,?,?,0)")
        .bind(
          await digest(token),
          projectId,
          a.email,
          Date.now() + 30 * 86400000,
        )
        .run();
      return { ok: true };
    });
    return json({
      token,
      expiresIn: 30 * 86400,
      platform: env.RUNTIME_URL + "/control",
    });
  }
  if (op === "revoke-credentials") {
    if (a.role !== "owner") fail("FORBIDDEN");
    return json(
      await audit(env, a, projectId, which, "credential.revoke", async () => {
        await env.CATALOG.prepare(
          "UPDATE credentials SET revoked=1 WHERE projectId=?",
        )
          .bind(projectId)
          .run();
        return { ok: true };
      }),
    );
  }
  fail("INVALID_OPERATION");
}
export class AdminControl extends WorkerEntrypoint<Env> {
  async request(request: Request) {
    try {
      return await api(request, this.env, await actor(request, this.env, true));
    } catch (e) {
      const out = status(e);
      return json({ error: out.code }, out.status);
    }
  }
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const a = await actor(request, env, false, ctx);
      const u = new URL(request.url);
      if (u.pathname.startsWith("/api/")) {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
          request.headers.get("origin") !== u.origin
        )
          fail("FORBIDDEN");
        return await api(request, env, a);
      }
      if (
        u.pathname.startsWith("/bootstrap/") ||
        u.pathname.startsWith("/starter/")
      )
        return new Response("Not found", { status: 404 });
      const response = await env.ASSETS.fetch(request),
        headers = new Headers(response.headers);
      headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self' " +
          FLARED_DASHBOARD_CSP_HASHES.scripts.join(" ") +
          "; style-src 'self' " +
          FLARED_DASHBOARD_CSP_HASHES.styles.join(" ") +
          "; connect-src 'self' " +
          env.RUNTIME_URL +
          " " +
          env.RUNTIME_URL.replace("https:", "wss:") +
          "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      headers.set(
        "cache-control",
        response.ok && u.pathname.startsWith("/_astro/")
          ? "private, max-age=31536000, immutable"
          : "private, no-store",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      const out = status(e);
      if (out.status >= 500)
        console.error({ source: "flared-admin", code: out.code });
      return json({ error: out.code }, out.status);
    }
  },
};
