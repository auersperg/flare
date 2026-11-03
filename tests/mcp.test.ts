import { describe, expect, it } from "bun:test";
import {
  action,
  mutation,
  query,
  manifest,
  defineApp,
  z,
} from "../packages/flare/src/sdk/server";
import { mcpResponse, mcpTools, mcpDescriptor } from "../packages/core/src/mcp";
import { FlareError } from "../packages/flare/src/sdk/protocol";
import { applicationRoute } from "../packages/core/src/routing";
import { validateRelease } from "../packages/core/src/release";
import { digest } from "../packages/core/src/security";
import { stableJson } from "../packages/flare/src/sdk/protocol";

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
  it("carries bounded app instructions without changing old manifests", () => {
    const original = manifest({ functions: { visible: define() } });
    expect(Object.keys(original).sort()).toEqual([
      "functions",
      "protocol",
      "runtimeAbi",
    ]);
    const mcp = {
      instructions: "Use notes.list before answering about saved notes.",
    };
    const configured = manifest(
      defineApp({ schema: {}, functions: { visible: define() }, mcp }),
    );
    expect(configured).toEqual({ ...original, mcp });
    expect(
      manifest({ functions: {}, mcp: { instructions: "é".repeat(4096) } }).mcp
        ?.instructions,
    ).toHaveLength(4096);
  });
  it.each([
    ["null", null],
    ["array", []],
    ["missing", {}],
    ["empty", { instructions: "" }],
    ["blank", { instructions: "  \n" }],
    ["wrong type", { instructions: 1 }],
    ["UTF-8 overflow", { instructions: "é".repeat(4097) }],
    ["unknown field", { instructions: "ok", secret: "not-public" }],
  ])("rejects malformed server instructions: %s", (_, mcp) => {
    expect(() =>
      defineApp({ schema: {}, functions: {}, mcp } as any),
    ).toThrow();
    expect(() => manifest({ functions: {}, mcp } as any)).toThrow();
  });
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
  const initialize = async (contract: ReturnType<typeof manifest>) => {
    const response = await mcpResponse(
      request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      }),
      {
        mcp: async () => mcpDescriptor(contract),
      },
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    return JSON.parse(
      raw.startsWith("{")
        ? raw
        : raw
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
    ).result;
  };
  it("delivers current release instructions on initialize without leaking across applications or old releases", async () => {
    const first = manifest({
      functions: { visible: define() },
      mcp: { instructions: "First app workflow" },
    });
    const next = manifest({
      functions: { visible: define() },
      mcp: { instructions: "Updated app workflow" },
    });
    expect((await initialize(first)).instructions).toBe("First app workflow");
    expect((await initialize(next)).instructions).toBe("Updated app workflow");
    expect(
      (await initialize(manifest({ functions: {} }))).instructions,
    ).toBeUndefined();
    expect((await initialize(first)).instructions).toBe("First app workflow");
  });
  it("uses normal tools/call and never retries failed writes", async () => {
    let calls = 0;
    const supervisor = {
      async mcp(input: any) {
        if (!input.name)
          return mcpDescriptor(manifest({ functions: { visible: define() } }));
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
  it("challenges a known write before execution and executes only after scope upgrade", async () => {
    const base = {
      input: z.object({}),
      output: z.string(),
      handler: () => "ok",
    };
    const contract = manifest({
      functions: {
        read: query({ ...base, mcp: { name: "read", description: "Read" } }),
        write: mutation({
          ...base,
          mcp: { name: "write", description: "Write" },
        }),
      },
    });
    let scopes = ["mcp:read"],
      calls = 0;
    const supervisor = {
      mcp: async (input: any) => {
        if (input.name === undefined) return mcpDescriptor(contract, scopes);
        if (!mcpTools(contract, scopes).some((t) => t.name === input.name))
          throw new FlareError("FORBIDDEN", "private detail");
        calls++;
        return "saved";
      },
    };
    const challenge =
      'Bearer error="insufficient_scope", scope="mcp:read mcp:write", resource_metadata="https://flare.test/.well-known/oauth-protected-resource/p/test/dev/v1/mcp"';
    const blocked = await mcpResponse(
      request("tools/call", {
        name: "write",
        arguments: { secret: "never-echo" },
      }),
      supervisor,
      challenge,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("www-authenticate")).toBe(challenge);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(await blocked.text()).toBe('{"error":"insufficient_scope"}');
    expect(calls).toBe(0);
    const listed = await mcpResponse(
      request("tools/list"),
      supervisor,
      challenge,
    );
    const listBody = await listed.text();
    expect(listBody).not.toContain('"name":"write"');
    expect(listBody).not.toContain("scopeRestrictedTools");
    scopes = ["mcp:read", "mcp:write"];
    const allowed = await mcpResponse(
      request("tools/call", { name: "write", arguments: {} }),
      supervisor,
      challenge,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("www-authenticate")).toBeNull();
    expect(await allowed.text()).toContain("saved");
    expect(calls).toBe(1);
  });
  it("does not turn unknown, internal, private or application-forbidden calls into scope upgrades", async () => {
    const base = {
      input: z.object({}),
      output: z.string(),
      handler: () => "ok",
    };
    const contract = manifest({
      functions: {
        public: query({
          ...base,
          mcp: { name: "public", description: "Read" },
        }),
        internal: mutation({ ...base, auth: "internal" }),
        private: mutation(base),
      },
    });
    for (const name of ["unknown", "internal", "private", "public"]) {
      const response = await mcpResponse(
        request("tools/call", { name }),
        {
          mcp: async (input: any) => {
            if (input.name === undefined)
              return mcpDescriptor(contract, ["mcp:read"]);
            throw new FlareError("FORBIDDEN", "private detail");
          },
        },
        'Bearer error="insufficient_scope", scope="mcp:read mcp:write"',
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      const body = await response.text();
      expect(body).toContain("FORBIDDEN");
      expect(body).not.toContain("private detail");
    }
  });
});

it("validates instructions at release upload and binds changes to the release checksum", async () => {
  const bundle = async (mcp?: unknown) => {
    const data = {
      manifest: {
        protocol: 1,
        runtimeAbi: 4,
        functions: {},
        ...(mcp === undefined ? {} : { mcp }),
      },
      schema: {},
      facet: "facet",
      action: "action",
    };
    const checksums = Object.fromEntries(
      await Promise.all(
        Object.entries(data).map(async ([key, value]) => [
          key,
          await digest(typeof value === "string" ? value : stableJson(value)),
        ]),
      ),
    );
    const release = { protocol: 1, compatibilityDate: "2026-10-10", checksums };
    return {
      ...data,
      release: { ...release, hash: await digest(stableJson(release)) },
    } as any;
  };
  const old = await bundle();
  const current = await bundle({ instructions: "Current workflow" });
  await expect(validateRelease(old)).resolves.toBe(old);
  await expect(validateRelease(current)).resolves.toBe(current);
  expect(current.release.hash).not.toBe(old.release.hash);
  await expect(
    validateRelease({
      ...current,
      manifest: {
        ...current.manifest,
        mcp: { instructions: "Changed without new release" },
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_RELEASE_CONTRACT_CHECKSUM" });
  for (const invalid of [
    { instructions: "" },
    { instructions: "😀".repeat(2049) },
    { instructions: "ok", unknown: true },
  ])
    await expect(validateRelease(await bundle(invalid))).rejects.toMatchObject({
      code: "INVALID_RELEASE_MCP",
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
