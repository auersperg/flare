# Native MCP authorization

Private optional Worker built on pinned `@cloudflare/workers-oauth-provider`.
One KV stores OAuth clients/grants/consent, **not application memory**.
The existing runtime remains the MCP resource server. No Codex process or extra memory database.

## Deployment

Deploy `src/index.ts` with Wrangler using an operator-owned config outside source control:

- tested compatibility date `2026-10-13`, flags `nodejs_compat`, `global_fetch_strictly_public`;
- `OAUTH_KV`: a dedicated KV namespace;
- `RUNTIME`: a Fetcher service binding to the installed `flare-runtime`;
- `RATE_LIMITER`: native rate limit binding, namespace unique to this service;
- `AUTH_ISSUER`: this Worker's HTTPS origin (custom domain, no trailing slash);
- `MCP_RESOURCE`: exact canonical `https://<runtime>/p/<project>/<env>/v1/mcp`;
- `APP_ORIGIN`: the single app frontend HTTPS origin allowed to manage connections;
- `OWNER_LOGIN`: the app owner allowed to consent;
- disable workers.dev and preview URLs. Do not log headers, codes, passwords or tokens.

Attach the Worker in the platform operator config:

```json
{
  "mcpAuth": [
    {
      "binding": "APP_MCP_AUTH_PERSONAL",
      "service": "your-authorization-worker",
      "issuer": "https://your-authorization-domain.example",
      "scope": "project-uuid/prod"
    }
  ],
  "capabilities": {
    "project-uuid/prod": {
      "mcpAuth": {
        "binding": "APP_MCP_AUTH_PERSONAL",
        "issuer": "https://your-authorization-domain.example"
      }
    }
  }
}
```

Merge with existing capabilities, do not replace them. Deploy the auth Worker first,
then apply through the managed `flare platform update --config ...` command.
Rollback: remove its capability grant through the same updater; preserve KV until
grants are revoked or explicitly scheduled for deletion.

## Clients

Use the canonical MCP URL, OAuth authorization-code with S256 PKCE, and the exact
resource indicator. Native metadata supports DCR and client metadata documents.
The owner signs in on the authorization domain and explicitly approves read-only
or read/write. A name from dynamic registration is unverified; check the return
domain. Do not paste an app session into ChatGPT/Gemini.

`mcp:read` is required. `mcp:write` allows explicitly exposed mutating tools.
`offline_access` requests refresh; access tokens expire in 5 minutes, refresh
sessions after 90 days idle (or earlier revocation). Repeated authorization-code
use revokes its grant through the official provider. KV revocation propagation
is not an instantaneous global guarantee.

The app manages its own connections through `/connections`, using its existing
session and exact frontend Origin. That endpoint never returns OAuth secrets.
Disabling a user, resetting their password, restoring auth data or admin-revoking
their sessions also invalidates the delegated identity in the runtime. Ordinary
browser logout does not revoke independent agents.

Run `bun run test:mcp-auth:local` for the actual provider in workerd:
discovery, registration, consent escaping, browser binding/CSRF, PKCE, scopes,
refresh, code replay, connection listing and revocation. Only the application
identity service is a fixture; OAuth itself is not mocked.

Client availability/permissions depend on that product and account. A successful
protocol test is not proof that every ChatGPT or Gemini plan exposes MCP.
Shared memory is explicit tool use, not automatic ingestion of every chat.
