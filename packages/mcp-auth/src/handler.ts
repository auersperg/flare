import {
  OAuthAuthorizationServer,
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { readBody } from "../../flare/src/sdk/http.js";

export type Env = McpAuthBindings;
export type Identity = {
  userId: string;
  epoch: string;
  login: string;
  scope: string;
};
const scopes = ["mcp:read", "mcp:write", "offline_access"];
const servers = new WeakMap<Env, OAuthAuthorizationServer<Env>>();
export function authorizationServer(env: Env) {
  let server = servers.get(env);
  if (!server) {
    const issuer = new URL(env.AUTH_ISSUER),
      resource = new URL(env.MCP_RESOURCE);
    if (
      issuer.origin !== env.AUTH_ISSUER ||
      issuer.protocol !== "https:" ||
      resource.protocol !== "https:" ||
      resource.search ||
      resource.hash ||
      resource.username ||
      !/^\/p\/[0-9a-f-]{36}\/(dev|prod)\/v1\/mcp$/.test(resource.pathname)
    )
      throw Error("Invalid OAuth configuration");
    server = new OAuthAuthorizationServer<Env>({
      issuer: env.AUTH_ISSUER,
      resources: [env.MCP_RESOURCE],
      scopesSupported: scopes,
      clientIdMetadataDocumentEnabled: true,
      clientRegistrationEndpoint: "/oauth/register",
      accessTokenTTL: 300,
      refreshTokenTTL: 90 * 86400,
      refreshTokenIdleTTL: 90 * 86400,
      tokenExchangeCallback: async ({ scope }) => ({
        refreshTokenTTL: scope.includes("offline_access") ? 90 * 86400 : 0,
      }),
    });
    servers.set(env, server);
  }
  return server;
}
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function consentPage(details: ConsentDescription, handle: string) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Flare · Подключить агента</title>
<style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:24px;line-height:1.6;color:#eee;background:#181818}label{display:block;margin:16px 0}input:not([type=checkbox]){display:block;padding:10px;width:90%}button{padding:12px;margin:8px}</style>
<h1>Подключить ${escape(details.clientName)}</h1>
<p>${details.clientDomain ? `Проверенный домен клиента: <strong>${escape(details.clientDomain)}</strong>` : "Имя клиента заявлено самим клиентом и не подтверждено."}</p>
<p>Доступ получит клиент с адресом возврата <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>Это приложение на вашем компьютере. Продолжайте только если сами начали подключение.</strong></p>" : ""}
<p>Агент получает доступ только к опубликованным MCP-инструментам приложения. Пароль, сессию приложения и подписку Codex агент не получает.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<label>Логин приложения <input name="login" autocomplete="username" maxlength="128" required></label>
<label>Пароль приложения <input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
<label><input type="checkbox" name="scope" value="mcp:read" checked required> Чтение памяти</label>
<label><input type="checkbox" name="scope" value="mcp:write"> Сохранение, исправление и забывание памяти</label>
<label><input type="checkbox" name="scope" value="offline_access" checked> Сохранять подключение; повторный вход после 90 дней без использования</label>
<p>Прочитанные агентом сведения попадут в соответствующий сервис. Отозвать доступ можно на AI-странице приложения. Распространение отзыва может занимать время; токены доступа живут не более 5 минут.</p>
<button name="decision" value="approve">Разрешить выбранное</button><button name="decision" value="deny" formnovalidate>Отказать</button></form></html>`;
}
class BodyLimitError extends Error {}
async function bodyText(request: Request | Response) {
  if (!request.body) throw Error("Missing body");
  return new TextDecoder().decode(
    await readBody(request.body, 16384, () => {
      throw new BodyLimitError();
    }),
  );
}
async function identity(
  env: Env,
  operation: "delegate" | "mcp-identity",
  body: unknown,
  token?: string,
): Promise<Identity> {
  const response = await env.RUNTIME.fetch(
    env.MCP_RESOURCE.replace(/\/mcp$/, `/auth/${operation}`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: token } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new AuthorizationError("access_denied", {
      description: "Не удалось подтвердить вход. Начните подключение заново.",
    });
  const data = JSON.parse(await bodyText(response)) as Identity;
  if (
    !data.userId ||
    !data.epoch ||
    data.login !== env.OWNER_LOGIN ||
    !env.MCP_RESOURCE.endsWith(`/p/${data.scope}/v1/mcp`)
  )
    throw new AuthorizationError("access_denied", {
      description: "Этот аккаунт не имеет доступа к памяти.",
    });
  return data;
}
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const server = authorizationServer(env),
    oauth = server.getOAuthApi(env),
    url = new URL(request.url);
  if (url.origin !== env.AUTH_ISSUER)
    return new Response("Not found", { status: 404 });
  if (
    !(
      await env.RATE_LIMITER.limit({
        key: request.headers.get("cf-connecting-ip") ?? "unknown",
      })
    ).success
  )
    return new Response("Rate limited", { status: 429 });
  try {
    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        const auth = await oauth.parseAuthRequest(request);
        if (auth.codeChallengeMethod !== "S256" || !auth.codeChallenge)
          throw new AuthorizationError("invalid_request", {
            description: "PKCE S256 is required",
          });
        const details = await oauth.describeConsent(auth),
          consent = await oauth.beginConsent(auth);
        consent.headers.set("content-type", "text/html; charset=utf-8");
        consent.headers.set("referrer-policy", "no-referrer");
        consent.headers.set(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        return new Response(consentPage(details, consent.handle), {
          headers: consent.headers,
        });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== env.AUTH_ISSUER ||
        !request.headers
          .get("content-type")
          ?.startsWith("application/x-www-form-urlencoded")
      )
        return new Response("Forbidden", { status: 403 });
      const form = new URLSearchParams(await bodyText(request)),
        handle = form.get("handle") ?? "";
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = form.getAll("scope");
      if (!scope.includes("mcp:read") || scope.some((s) => !scopes.includes(s)))
        return new Response("Invalid scope", { status: 400 });
      const approved = await oauth.approveConsent(request, handle, { scope });
      const user = await identity(env, "delegate", {
        login: form.get("login"),
        password: form.get("password"),
      });
      const details = await oauth.describeConsent(approved.request);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: user.userId,
        scope: approved.request.scope,
        metadata: {
          name: details.clientName,
          redirectHost: details.redirectHost,
        },
        props: { userId: user.userId, epoch: user.epoch, scope: user.scope },
      });
      approved.headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    if (url.pathname === "/connections") {
      const origin = request.headers.get("origin");
      if (origin && origin !== env.APP_ORIGIN)
        return new Response("Forbidden", { status: 403 });
      const headers = {
        "cache-control": "no-store",
        "access-control-allow-origin": env.APP_ORIGIN,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        vary: "Origin",
      };
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      const token = request.headers.get("authorization");
      if (!token?.startsWith("Bearer flared_session_"))
        return Response.json(
          { error: "UNAUTHORIZED" },
          { status: 401, headers },
        );
      const user = await identity(env, "mcp-identity", {}, token);
      let input;
      try {
        input = JSON.parse(await bodyText(request));
      } catch {
        return Response.json(
          { error: "INVALID_INPUT" },
          { status: 400, headers },
        );
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        return Response.json(
          { error: "INVALID_INPUT" },
          { status: 400, headers },
        );
      if (input.revoke !== undefined) {
        if (typeof input.revoke !== "string" || input.revoke.length > 128)
          return Response.json(
            { error: "INVALID_INPUT" },
            { status: 400, headers },
          );
        await oauth.revokeGrant(input.revoke, user.userId);
      }
      if (
        input.cursor !== undefined &&
        (typeof input.cursor !== "string" || input.cursor.length > 1024)
      )
        return Response.json(
          { error: "INVALID_INPUT" },
          { status: 400, headers },
        );
      const grants = await oauth.listUserGrants(user.userId, {
        limit: 20,
        cursor: input.cursor,
      });
      return Response.json(
        {
          grants: grants.items.map((g) => ({
            id: g.id,
            clientId: g.clientId,
            scope: g.scope,
            createdAt: g.createdAt,
            expiresAt: g.expiresAt,
            name: g.metadata?.name ?? g.clientId,
          })),
          cursor: grants.cursor,
        },
        { headers },
      );
    }
    // The provider parses JSON/form bodies. Bound the stream first, including
    // chunked requests without a trustworthy Content-Length header.
    if (request.body)
      request = new Request(request, { body: await bodyText(request) });
    return await server.fetch(request, env, ctx);
  } catch (error) {
    const headers = {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      ...(url.pathname === "/connections" &&
      request.headers.get("origin") === env.APP_ORIGIN
        ? { "access-control-allow-origin": env.APP_ORIGIN, vary: "Origin" }
        : {}),
    };
    if (error instanceof BodyLimitError)
      return new Response("Request body too large", { status: 413, headers });
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response(
        error instanceof AuthorizationError
          ? error.description
          : "Не удалось проверить клиента. Начните подключение заново.",
        {
          status: 400,
          headers,
        },
      );
    return new Response("OAuth service unavailable", {
      status: 503,
      headers,
    });
  }
}
