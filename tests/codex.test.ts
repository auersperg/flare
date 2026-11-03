import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Session } from "../packages/codex/src/session";
import {
  allowedDestination,
  boundedText,
  managedAuth,
  mcpUrl,
} from "../packages/codex/src/policy";
import { codexContext, codexInput } from "../packages/flare/src/sdk/codex";
import { codexCommand } from "../packages/core/src/codex";

const scope = "00000000-0000-4000-8000-000000000001/dev";
const auth = (suffix = "seed") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `test-access-${suffix}`,
      refresh_token: `test-refresh-${suffix}`,
      id_token: `test-id-${suffix}`,
    },
  });
function fixture() {
  const data = new Map<string, any>(),
    disk = new Map<string, string>();
  const events: string[] = [];
  let directoryReady = false,
    failSetup = false;
  let alarm: number | null = null,
    starts = 0,
    failStop = false,
    failRead = false;
  const db = new Database(":memory:");
  const storage: any = {
    sql: {
      exec(query: string, ...args: any[]) {
        const rows = db.query(query).all(...args);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    kv: {
      get: (key: string) => structuredClone(data.get(key)),
      put: (key: string, value: any) => {
        data.set(key, structuredClone(value));
        events.push(key);
      },
      delete: (key: string) => data.delete(key),
      list: ({ prefix }: any) =>
        new Map([...data].filter(([key]) => key.startsWith(prefix))),
    },
    sync: async () => {
      events.push("sync");
    },
    setAlarm: async (value: number) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const container: any = {
    running: false,
    images: { codex: "image" },
    start(options: any) {
      expect(options.enableInternet).toBe(false);
      starts++;
      this.running = true;
      directoryReady = false;
    },
    interceptAllOutboundHttp: async () => {},
    interceptOutboundHttps: async () => {},
    setInactivityTimeout: async (ms: number) => {
      expect(ms).toBe(30000);
    },
    exec: async (argv: string[], options: any) => {
      if (argv.join(" ").includes("mkdir -p")) {
        directoryReady = !failSetup;
        return { exitCode: Promise.resolve(failSetup ? 1 : 0) };
      }
      expect(argv.join()).not.toContain("prompt");
      expect(options.env?.OPENAI_API_KEY).toBeUndefined();
      return { exitCode: Promise.resolve(0) };
    },
    async destroy() {
      if (failStop) throw Error("stop failed");
      events.push("destroy");
      this.running = false;
      disk.clear();
    },
  };
  const files: any = {
    writeFile: async (path: string, value: string) => {
      if (!directoryReady)
        throw Error("Ephemeral /run directory does not exist");
      disk.set(path, value);
    },
    readFile: async (path: string) => {
      if (failRead) throw Error("private provider error");
      if (!disk.has(path))
        throw Object.assign(new Error("missing"), {
          name: "SandboxFileError",
          code: "ENOENT",
        });
      return new Response(disk.get(path));
    },
  };
  const env = {
    FLARE_SCOPE: scope,
    AUTH_REVISION: "1",
    CODEX_AUTH_JSON: auth(),
    MCP_URL: "",
  };
  const make = () => new Session(storage, container, files, env, {} as Fetcher);
  let session = make();
  return {
    data,
    disk,
    events,
    env,
    container,
    db,
    command: (op: string, input: unknown) =>
      session.exclusive(() => session.command(op, input)),
    tick: () => session.exclusive(() => session.tick()),
    restart: () => {
      session = make();
    },
    complete: (exitCode = 0, reason?: string) => {
      disk.set("/run/flare/outcome.json", JSON.stringify({ exitCode, reason }));
      disk.set("/run/flare/result.txt", "OK");
    },
    failSetup: (v: boolean) => {
      failSetup = v;
    },
    failStop: (v: boolean) => {
      failStop = v;
    },
    failRead: (v: boolean) => {
      failRead = v;
    },
    starts: () => starts,
    alarm: () => alarm,
  };
}
const task = () => ({ id: crypto.randomUUID(), prompt: "Reply OK" });

describe("Private on-demand Codex runner", () => {
  it("does not invalidate a login when setup failed before any agent launch", async () => {
    const f = fixture();
    f.failSetup(true);
    expect(await f.command("start", task())).toMatchObject({
      state: "failed",
      error: "CODEX_SETUP_FAILED",
    });
    expect(f.data.get("auth-invalid")).toBeUndefined();
    expect(f.container.running).toBe(false);
    f.failSetup(false);
    expect(await f.command("start", task())).toMatchObject({
      state: "running",
    });
  });
  it("does not scan result bodies to expire history and refuses to evict recent IDs", async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++)
      f.db
        .query("INSERT INTO codex_tasks VALUES (?, ?, ?)")
        .run(String(i), Date.now(), "{}");
    await expect(f.command("start", task())).rejects.toThrow(
      "CODEX_HISTORY_FULL",
    );
    expect(f.starts()).toBe(0);
    f.db.query("UPDATE codex_tasks SET finished_at = 0").run();
    await f.command("start", task());
    expect(
      f.db.query("SELECT COUNT(*) AS count FROM codex_tasks").get(),
    ).toEqual({ count: 1 });
  });
  it.each(["missing", "oversized"])(
    "fails promptly on %s final output",
    async (kind) => {
      const f = fixture(),
        input = task();
      await f.command("start", input);
      f.complete();
      if (kind === "missing") f.disk.delete("/run/flare/result.txt");
      else f.disk.set("/run/flare/result.txt", "x".repeat(65537));
      await f.tick();
      expect(await f.command("status", { id: input.id })).toMatchObject({
        state: "failed",
        error:
          kind === "missing"
            ? "CODEX_RESULT_MISSING"
            : "CODEX_OUTPUT_TOO_LARGE",
      });
      expect(f.container.running).toBe(false);
    },
  );
  it("serializes submissions and never replays the same task", async () => {
    const f = fixture(),
      input = task();
    const results = await Promise.all([
      f.command("start", input),
      f.command("start", input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.starts()).toBe(1);
    await expect(
      f.command("start", { ...input, prompt: "different" }),
    ).rejects.toThrow("CODEX_ID_CONFLICT");
    await expect(f.command("start", task())).rejects.toThrow("CODEX_BUSY");
    expect(JSON.stringify(results)).not.toContain("fingerprint");
  });
  it("persists rotated auth before stop and uses it after DO restart, not the seed", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    f.disk.set("/run/flare/codex/auth.json", auth("rotated"));
    f.complete();
    await f.tick();
    expect(f.data.get("auth")).toBe(auth("rotated"));
    expect(f.events.slice(-2)).toEqual(["sync", "destroy"]);
    expect(f.container.running).toBe(false);
    expect(f.alarm()).toBeNull();
    f.restart();
    expect(await f.command("start", input)).toMatchObject({
      state: "succeeded",
      result: "OK",
    });
    await f.command("start", task());
    expect(f.disk.get("/run/flare/codex/auth.json")).toBe(auth("rotated"));
  });
  it("checkpoints while running and resumes monitoring without relaunching", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    f.disk.set("/run/flare/codex/auth.json", auth("mid-run"));
    f.restart();
    await f.tick();
    expect(f.data.get("auth")).toBe(auth("mid-run"));
    expect(f.starts()).toBe(1);
    f.complete();
    await f.tick();
    expect(f.container.running).toBe(false);
  });
  it("fails closed after container loss; only a new auth revision reseeds", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    f.container.running = false;
    f.disk.clear();
    await f.tick();
    expect(await f.command("status", { id: input.id })).toMatchObject({
      state: "interrupted",
      error: "CODEX_CONTAINER_LOST",
    });
    await expect(f.command("start", task())).rejects.toThrow(
      "CODEX_AUTH_REQUIRED",
    );
    f.env.AUTH_REVISION = "2";
    f.env.CODEX_AUTH_JSON = auth("new-login");
    await f.command("start", task());
    expect(f.disk.get("/run/flare/codex/auth.json")).toBe(auth("new-login"));
  });
  it("retries stopping, never executing, after result commit", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    f.complete();
    f.failStop(true);
    await f.tick();
    expect(await f.command("status", { id: input.id })).toMatchObject({
      state: "succeeded",
    });
    expect(f.alarm()).not.toBeNull();
    f.failStop(false);
    f.restart();
    await f.tick();
    expect(f.starts()).toBe(1);
    expect(f.container.running).toBe(false);
    expect(f.alarm()).toBeNull();
  });
  it("cancels through the process supervisor and checkpoints before stop", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    await f.command("cancel", { id: input.id });
    expect(f.disk.get("/run/flare/cancel")).toBe("1");
    f.complete(-1, "CANCELLED");
    await f.tick();
    expect(await f.command("status", { id: input.id })).toMatchObject({
      state: "cancelled",
    });
    expect(f.data.get("auth-invalid")).toBeUndefined();
  });
  it("does not expose raw errors or return a false success on failed auth checkpoint", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    f.complete();
    f.disk.set("/run/flare/codex/auth.json", "secret-invalid");
    await f.tick();
    expect(await f.command("status", { id: input.id })).toMatchObject({
      state: "interrupted",
      error: "CODEX_AUTH_CHECKPOINT_FAILED",
    });
    expect(f.container.running).toBe(false);
  });
  it("bounds lifetime even when file reads fail", async () => {
    const f = fixture(),
      input = task();
    await f.command("start", input);
    const row = JSON.parse(
      (
        f.db
          .query("SELECT record FROM codex_tasks WHERE id = ?")
          .get(input.id) as any
      ).record,
    );
    row.startedAt = Date.now() - 12 * 60000;
    f.db
      .query("UPDATE codex_tasks SET record = ? WHERE id = ?")
      .run(JSON.stringify(row), input.id);
    f.failRead(true);
    await f.tick();
    expect(f.container.running).toBe(false);
    expect(await f.command("status", { id: input.id })).toMatchObject({
      error: "CODEX_DEADLINE_EXCEEDED",
    });
  });
  it("pins durable credentials to their original environment", async () => {
    const f = fixture();
    await f.command("start", task());
    f.env.FLARE_SCOPE = scope.replace("dev", "prod");
    await expect(
      f.command("status", { id: crypto.randomUUID() }),
    ).rejects.toThrow("CODEX_SCOPE_MISMATCH");
  });
});

describe("Codex capability boundaries", () => {
  it("accepts only managed ChatGPT auth, not API keys or host-managed tokens", () => {
    expect(managedAuth(auth())).toBe(auth());
    for (const value of [
      "{}",
      "null",
      JSON.stringify({ auth_mode: "chatgptAuthTokens", tokens: {} }),
      JSON.stringify({ OPENAI_API_KEY: "test" }),
    ])
      expect(() => managedAuth(value)).toThrow("CODEX_AUTH_REQUIRED");
  });
  it("denies arbitrary egress, API billing and redirects to other paths", () => {
    const mcp = `https://runtime.example.com/p/${scope}/v1/mcp`;
    expect(mcpUrl(mcp, scope)).toBe(mcp);
    for (const url of [
      mcp,
      "https://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/wham/accounts/check",
      "https://chatgpt.com/backend-api/wham/settings/user",
      "https://auth.openai.com/oauth/token",
    ])
      expect(allowedDestination(new URL(url), mcp)).toBe(true);
    for (const url of [
      "https://api.openai.com/v1/responses",
      "http://chatgpt.com/backend-api/codex/responses",
      "https://chatgpt.com/anything",
      mcp + "?token=x",
      "https://auth.openai.com/oauth/token/evil",
      "https://chatgpt.com.evil.test/backend-api/codex/responses",
    ])
      expect(allowedDestination(new URL(url), mcp)).toBe(false);
    expect(() => mcpUrl(mcp, scope.replace("dev", "prod"))).toThrow();
  });
  it("bounds inputs and output streams and exposes no shell/config surface", async () => {
    for (const input of [
      { ...task(), model: "x" },
      { ...task(), prompt: "x".repeat(16385) },
      { id: "bad", prompt: "ok" },
      { ...task(), prompt: "" },
    ])
      expect(() => codexInput("start", input)).toThrow();
    await expect(boundedText(new Response("12345"), 4)).rejects.toThrow();
    let calls = 0;
    const sdk = codexContext(async () => {
      calls++;
      return null;
    });
    await sdk.status(crypto.randomUUID());
    expect(calls).toBe(1);
  });
  it("requires an explicit scope grant and passes the platform scope, not caller scope", async () => {
    const input = task();
    await expect(codexCommand({}, scope, "start", input)).rejects.toMatchObject(
      { code: "CODEX_DISABLED" },
    );
    const env: any = {
      APP_CAPABILITIES: JSON.stringify({
        [scope]: { codex: "APP_CODEX_PERSONAL" },
      }),
      APP_CODEX_PERSONAL: {
        command: async (...args: unknown[]) => ({ ok: true, value: args }),
      },
    };
    expect(await codexCommand(env, scope, "start", input)).toEqual([
      scope,
      "start",
      input,
    ]);
    await expect(
      codexCommand(env, scope.replace("dev", "prod"), "start", input),
    ).rejects.toMatchObject({ code: "CODEX_DISABLED" });
  });
});

describe("Optional same-turn JSON artifact", () => {
  it("validates paths and includes instructions/artifact selection in task idempotency", async () => {
    const f = fixture(),
      id = crypto.randomUUID();
    for (const outputFile of [
      "../auth.json",
      "/run/flare/auth.json",
      "secret.txt",
      "a/b.json",
    ])
      expect(() =>
        codexInput("start", { id, prompt: "test", outputFile }),
      ).toThrow();
    await f.command("start", {
      id,
      prompt: "test",
      instructions: "trusted application instructions",
      outputFile: "memory.json",
    });
    await expect(
      f.command("start", {
        id,
        prompt: "test",
        instructions: "changed",
        outputFile: "memory.json",
      }),
    ).rejects.toThrow("CODEX_ID_CONFLICT");
    const input = JSON.parse(f.disk.get("/run/flare/input.json")!);
    expect(input.instructions).toBe("trusted application instructions");
    expect(input.outputFile).toBe("memory.json");
    f.complete();
    f.disk.set("/run/flare/artifact.json", '{"facts":[]}');
    await f.tick();
    expect(await f.command("status", { id })).toMatchObject({
      state: "succeeded",
      artifact: '{"facts":[]}',
    });
  });
  it("does not publish artifacts from failed or cancelled tasks", async () => {
    const f = fixture(),
      id = crypto.randomUUID();
    await f.command("start", { id, prompt: "test", outputFile: "memory.json" });
    f.complete(1, "CANCELLED");
    f.disk.set("/run/flare/artifact.json", '{"facts":["false"]}');
    await f.tick();
    expect(await f.command("status", { id })).toMatchObject({
      state: "cancelled",
    });
    expect((await f.command("status", { id }))?.artifact).toBeUndefined();
  });
});

it("erases consumed artifacts, fences delayed artifacts and never starts a forgotten ID", async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  await f.command("start", {
    id,
    prompt: "artifact",
    outputFile: "memory.json",
  });
  await f.command("discardArtifact", { id });
  f.complete();
  f.disk.set("/run/flare/artifact.json", '{"private":"forgotten"}');
  await f.tick();
  const result = await f.command("status", { id });
  expect(result?.state).toBe("succeeded");
  expect(result?.artifact).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("artifactDiscarded");
  const unknown = crypto.randomUUID();
  await f.command("discardArtifact", { id: unknown });
  await expect(
    f.command("start", { id: unknown, prompt: "do not resurrect" }),
  ).rejects.toThrow("CODEX_ID_CONFLICT");
});
