import { describe, expect, it } from "bun:test";
import {
  action,
  mutation,
  query,
  manifest,
  z,
} from "../packages/flare/src/sdk/server";
import { mcpResponse, mcpTools } from "../packages/core/src/mcp";
import { FlareError } from "../packages/flare/src/sdk/protocol";
import { applicationRoute } from "../packages/core/src/routing";

const tool = { name: "notes.list", description: "List permitted notes" };
const define = (options: object = {}) =>
  query({
    input: z.object({}),
    output: z.string(),
    handler: () => "ok",
    mcp: tool,
    ...options,
  });
describe("MCP opt-in contract", () => {
  it("keeps old functions hidden and never serializes handlers", () => {
    const m = manifest({
      functions: { visible: define(), hidden: define({ mcp: undefined }) },
    });
    expect(mcpTools(m).map((x) => x.name)).toEqual([tool.name]);
    expect(JSON.stringify(m)).not.toContain("handler");
  });
  it.each([
    { auth: "internal" },
    { input: z.string() },
    { mcp: { ...tool, name: "notes/list" } },
    { mcp: { ...tool, description: "" } },
  ])("rejects unsafe metadata %j", (options) => {
    expect(() => manifest({ functions: { bad: define(options) } })).toThrow();
  });
  it("rejects duplicate tool names", () => {
    expect(() =>
      manifest({ functions: { one: define(), two: define() } }),
    ).toThrow();
  });
  it("supports both existing project URL forms", () => {
    for (const path of [
      "/demo/dev/v1/mcp",
      "/p/00000000-0000-4000-8000-000000000001/prod/v1/mcp",
    ])
      expect(applicationRoute(path)?.operation).toBe("mcp");
  });
});
describe("Stateless MCP transport", () => {
  const request = (method: string, params: object = {}) =>
    new Request("https://flare.test/demo/dev/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
        authorization: "Bearer fixture",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  it("uses normal tools/call and never retries failed writes", async () => {
    let calls = 0;
    const supervisor = {
      async mcp(input: any) {
        if (!input.name)
          return mcpTools(manifest({ functions: { visible: define() } }));
        calls++;
        throw new FlareError("OPERATION_FAILED", "private detail");
      },
    };
    const response = await mcpResponse(
      request("tools/call", { name: tool.name, arguments: {} }),
      supervisor,
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).toContain("OPERATION_FAILED");
    expect(raw).not.toContain("private detail");
    expect(calls).toBe(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("checks identity before tools/list or transport initialization", async () => {
    for (const method of ["initialize", "tools/list", "tools/call"])
      await expect(
        mcpResponse(request(method), {
          mcp: async () => {
            throw new FlareError("UNAUTHORIZED", "UNAUTHORIZED");
          },
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

it("distinguishes read-only actions and filters write tools for read-only grants", () => {
  const base = { input: z.object({}), output: z.string(), handler: () => "ok" };
  const m = manifest({
    functions: {
      read: query({ ...base, mcp: { name: "read", description: "Read" } }),
      search: action({
        ...base,
        mcp: { name: "search", description: "Search", readOnly: true },
      }),
      write: mutation({
        ...base,
        mcp: { name: "write", description: "Write" },
      }),
    },
  });
  expect(mcpTools(m, ["mcp:read"]).map((t) => t.name)).toEqual([
    "read",
    "search",
  ]);
  expect(mcpTools(m, ["mcp:read", "mcp:write"])).toHaveLength(3);
  expect(mcpTools(m)[1].annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(() =>
    manifest({
      functions: {
        invalid: mutation({
          ...base,
          mcp: { name: "bad", description: "Bad", readOnly: true },
        }),
      },
    }),
  ).toThrow();
});
