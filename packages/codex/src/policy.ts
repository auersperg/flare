export const scopePattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(dev|prod)$/;
export function mcpUrl(value: string, scope: string): string {
  if (!value) return "";
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/p/${scope}/v1/mcp` ||
    !url.hostname.includes(".") ||
    /\.(local|internal|localhost)$/.test(url.hostname)
  )
    throw Error("CODEX_INVALID_MCP_URL");
  return url.href;
}
export function allowedDestination(url: URL, mcp: string): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return false;
  // No api.openai.com: this runner deliberately has no API-billing fallback.
  return (
    (url.hostname === "chatgpt.com" &&
      (url.pathname === "/backend-api/codex" ||
        url.pathname.startsWith("/backend-api/codex/") ||
        // Native CLI workspace discovery, not a model/API-key proxy.
        [
          "/backend-api/wham/accounts/check",
          "/backend-api/wham/settings/user",
        ].includes(url.pathname))) ||
    (url.hostname === "auth.openai.com" && url.pathname === "/oauth/token") ||
    (!!mcp && url.href === mcp)
  );
}
export function managedAuth(value: string): string {
  if (new TextEncoder().encode(value).length > 65536)
    throw Error("CODEX_AUTH_REQUIRED");
  let auth;
  try {
    auth = JSON.parse(value);
  } catch {
    throw Error("CODEX_AUTH_REQUIRED");
  }
  if (
    auth?.auth_mode !== "chatgpt" ||
    auth.OPENAI_API_KEY ||
    !["access_token", "refresh_token", "id_token"].every(
      (k) => typeof auth.tokens?.[k] === "string" && auth.tokens[k].length > 0,
    )
  )
    throw Error("CODEX_AUTH_REQUIRED");
  return value;
}
export async function boundedText(
  response: Response,
  max: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let result = "",
    size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw Error("CODEX_OUTPUT_TOO_LARGE");
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
