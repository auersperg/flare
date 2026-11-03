import { appPolicy, type PolicyEnv } from "./capabilities.js";
import { fail } from "./security.js";

export type McpIdentity = { userId: string; epoch: string; scope: string };
type Validated = {
  props: McpIdentity;
  audience: string;
  expiresAt: number;
  userId: string;
  clientId: string;
  scope: string[];
};
type Env = PolicyEnv & { RUNTIME_URL: string };
export function mcpResource(env: Env, scope: string) {
  return `${env.RUNTIME_URL}/p/${scope}/v1/mcp`;
}
export function mcpMetadata(env: Env, scope: string) {
  const configured = appPolicy(env, scope).mcpAuth;
  if (!configured) return null;
  return {
    resource: mcpResource(env, scope),
    authorization_servers: [configured.issuer],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
    resource_name: "Flare application MCP",
  };
}
export function mcpChallenge(env: Env, scope: string) {
  return `Bearer resource_metadata="${env.RUNTIME_URL}/.well-known/oauth-protected-resource/p/${scope}/v1/mcp", scope="mcp:read"`;
}
/** Only the operator-bound authorization service can assert identity. Never accept client JWT claims directly. */
export async function validateMcpToken(
  env: Env,
  scope: string,
  token: string,
): Promise<Validated> {
  const configured = appPolicy(env, scope).mcpAuth;
  if (!configured || !token || token.length > 8192) fail("UNAUTHORIZED");
  const binding = (env as unknown as Record<string, unknown>)[
    configured.binding
  ] as {
    validateToken(resource: string, token: string): Promise<Validated | null>;
  };
  if (!binding?.validateToken) fail("UNAUTHORIZED");
  const validated = await binding.validateToken(mcpResource(env, scope), token);
  if (
    !validated ||
    validated.audience !== mcpResource(env, scope) ||
    !Number.isFinite(validated.expiresAt) ||
    validated.expiresAt * 1000 <= Date.now() ||
    !Array.isArray(validated.scope) ||
    !validated.scope.includes("mcp:read") ||
    typeof validated.clientId !== "string" ||
    !validated.clientId ||
    !validated.props ||
    validated.props.scope !== scope ||
    typeof validated.props.userId !== "string" ||
    validated.props.userId !== validated.userId ||
    typeof validated.props.epoch !== "string"
  )
    fail("UNAUTHORIZED");
  return validated;
}
