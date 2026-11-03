import { expect, test } from "bun:test";
import {
  mcpMetadata,
  mcpChallenge,
  mcpResource,
  validateMcpToken,
} from "../packages/core/src/mcp-auth";
// @ts-expect-error CLI module is JavaScript.
import { validatePlatformConfig } from "../packages/flare/src/cli/platform-config.mjs";
const scope = "00000000-0000-4000-8000-000000000001/prod";
const binding = "APP_MCP_AUTH_PERSONAL",
  issuer = "https://auth.example.com";
const config = {
  capabilities: { [scope]: { mcpAuth: { binding, issuer } } },
  mcpAuth: [{ binding, issuer, scope, service: "flare-auth" }],
};
test("OAuth authorization services are explicit, scope-owned operator bindings", () => {
  expect(validatePlatformConfig(config).mcpAuth).toHaveLength(1);
  expect(() =>
    validatePlatformConfig({
      ...config,
      mcpAuth: [
        { ...config.mcpAuth[0], scope: scope.replace("/prod", "/dev") },
      ],
    }),
  ).toThrow();
  expect(() =>
    validatePlatformConfig({
      ...config,
      mcpAuth: [...config.mcpAuth, config.mcpAuth[0]],
    }),
  ).toThrow();
});
test("MCP scope challenges preserve least-privilege discovery and request read plus write only for step-up", () => {
  const env = {
    RUNTIME_URL: "https://api.example.com",
    APP_CAPABILITIES: JSON.stringify(config.capabilities),
  };
  expect(mcpMetadata(env, scope)?.scopes_supported).toEqual(["mcp:read"]);
  expect(mcpChallenge(env, scope)).toBe(
    `Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/p/${scope}/v1/mcp", scope="mcp:read"`,
  );
  expect(mcpChallenge(env, scope, true)).toBe(
    `Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/p/${scope}/v1/mcp", error="insufficient_scope", scope="mcp:read mcp:write"`,
  );
});
test("MCP accepts only the configured resource, current token, read scope and matching delegated identity", async () => {
  const env = {
    RUNTIME_URL: "https://api.example.com",
    APP_CAPABILITIES: JSON.stringify(config.capabilities),
    [binding]: { validateToken: async (_r: string, _t: string) => value },
  };
  const valid = {
    audience: mcpResource(env, scope),
    expiresAt: Date.now() / 1000 + 300,
    scope: ["mcp:read"],
    userId: "owner",
    clientId: "client",
    props: { userId: "owner", epoch: "epoch", scope },
  };
  let value: any = valid;
  expect((await validateMcpToken(env, scope, "opaque")).userId).toBe("owner");
  expect(mcpMetadata(env, scope)?.authorization_servers).toEqual([issuer]);
  for (const patch of [
    null,
    { audience: "https://other.test" },
    { expiresAt: 0 },
    { scope: ["mcp:write"] },
    { userId: "foreign" },
    { props: { ...valid.props, scope: scope.replace("/prod", "/dev") } },
  ]) {
    value = patch === null ? null : { ...valid, ...patch };
    await expect(validateMcpToken(env, scope, "opaque")).rejects.toThrow();
  }
  value = valid;
  await expect(
    validateMcpToken(env, scope.replace("/prod", "/dev"), "opaque"),
  ).rejects.toThrow();
});
