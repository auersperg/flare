import type { Tool } from "@modelcontextprotocol/server";
import {
  boundedJson,
  LIMITS,
  type Json,
  type Manifest,
} from "../../flare/src/sdk/protocol.js";
import { jsonBody, status } from "./security.js";

export function mcpTools(manifest: Manifest, scopes?: string[]): Tool[] {
  return Object.values(manifest.functions).flatMap((fn) =>
    fn.mcp &&
    fn.auth !== "internal" &&
    (!scopes ||
      scopes.includes("mcp:write") ||
      fn.kind === "query" ||
      fn.mcp.readOnly === true)
      ? [
          {
            name: fn.mcp.name,
            description: fn.mcp.description,
            inputSchema: fn.input as Tool["inputSchema"],
            annotations: {
              readOnlyHint: fn.kind === "query" || fn.mcp.readOnly === true,
              destructiveHint: fn.kind !== "query" && fn.mcp.readOnly !== true,
              idempotentHint: fn.kind === "query" || fn.mcp.readOnly === true,
              openWorldHint: fn.kind === "action",
            },
          },
        ]
      : [],
  );
}

/** Transport only. Identity, release selection and all writes remain in the supervisor. */
export async function mcpResponse(
  request: Request,
  supervisor: {
    mcp(input: {
      origin: string | null;
      authorization: string | null;
      name?: string;
      args?: Json;
    }): Promise<unknown>;
  },
) {
  const identity = {
    origin: request.headers.get("origin"),
    authorization: request.headers.get("authorization"),
  };
  const tools = (await supervisor.mcp(identity)) as ReturnType<typeof mcpTools>;
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (identity.origin) {
    headers.set("access-control-allow-origin", identity.origin);
    headers.set("vary", "Origin");
  }
  // No browser credential issuance or wildcard origins. Non-browser clients send Bearer per request.
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers });
  const body = await jsonBody(request);
  // Ordinary HTTP/live calls need only manifest helpers, not MCP schema/transport initialization.
  const [{ createMcpHandler }, { Server }] = await Promise.all([
    import("agents/mcp/server"),
    import("@modelcontextprotocol/server"),
  ]);
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: "Flare", version: "1" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/list", async ({ params }) => {
        const cursor = params?.cursor ?? "0";
        if (
          !/^(0|[1-9][0-9]{0,3})$/.test(cursor) ||
          Number(cursor) > tools.length
        )
          throw Error("Invalid cursor");
        const offset = Number(cursor),
          page = tools.slice(offset, offset + 10);
        return {
          tools: page,
          ...(offset + 10 < tools.length
            ? { nextCursor: String(offset + 10) }
            : {}),
        };
      });
      server.setRequestHandler("tools/call", async ({ params }) => {
        try {
          const result = await supervisor.mcp({
            ...identity,
            name: params.name,
            args: (params.arguments ?? {}) as Json,
          });
          const response = {
            content: [
              {
                type: "text" as const,
                text: boundedJson(result, LIMITS.outputBytes),
              },
            ],
          };
          boundedJson(response, LIMITS.outputBytes);
          return response;
        } catch (error) {
          // In particular, never retry a mutation after an unknown outcome.
          return {
            isError: true,
            content: [{ type: "text" as const, text: status(error).code }],
          };
        }
      });
      return server;
    },
    {
      route: new URL(request.url).pathname,
      corsOptions: false,
      allowedOriginHostnames: "*",
    },
  );
  const response = await handler.fetch(request, { parsedBody: body });
  const out = new Response(response.body, response);
  headers.forEach((value, key) => out.headers.set(key, value));
  return out;
}
