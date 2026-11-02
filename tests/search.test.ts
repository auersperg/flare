import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { SearchStore } from "../packages/core/src/search";
import { FileStore } from "../packages/core/src/files";
import { searchContext } from "../packages/flare/src/sdk/search";

const scope = "b6466091-bacf-4193-93ea-4d86d2db9960/dev";
function fixture(onWake?: (count: number) => Promise<void>) {
  const db = new Database(":memory:");
  const storage: any = {
    sql: {
      exec(sql: string, ...args: any[]) {
        const rows = db.prepare(sql).all(...args);
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw Error();
            return rows[0];
          },
        };
      },
    },
  };
  FileStore.initialize(storage);
  SearchStore.initialize(storage);
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  for (const file of [id, other])
    db.query("INSERT INTO files VALUES (?,?,?,?,'ready',0,0)").run(
      file,
      file + ".txt",
      "text/plain",
      4,
    );
  const items = new Map<string, AiSearchItemInfo>();
  let uploads = 0,
    wakes = 0,
    failUpload = false,
    failDelete = false,
    failSearch = false;
  let duringUpload: (() => Promise<void>) | undefined;
  const provider: any = {
    items: {
      list: async ({ key }: any) => ({
        result: [...items.values()].filter((i) => i.key === key),
      }),
      upload: async (key: string, body: ReadableStream) => {
        uploads++;
        await new Response(body).text();
        const info: AiSearchItemInfo = {
          id: crypto.randomUUID(),
          key,
          status: "queued",
          source_id: "builtin",
        };
        items.set(key, info);
        await duringUpload?.();
        if (failUpload) throw Error("private provider body");
        return info;
      },
      uploadAndPoll: async (
        key: string,
        body: ReadableStream,
        options: any,
      ) => {
        expect(options).toEqual({ timeoutMs: 30_000, pollIntervalMs: 2_000 });
        return provider.items.upload(key, body);
      },
      get: (id: string) => ({
        info: async () => [...items.values()].find((i) => i.id === id),
        sync: async () => {
          const i = [...items.values()].find((i) => i.id === id)!;
          i.status = "queued";
          return i;
        },
      }),
      delete: async (id: string) => {
        if (failDelete) throw Error("secret");
        for (const [key, item] of items) if (item.id === id) items.delete(key);
      },
    },
    search: async (input: any) => {
      if (input.ai_search_options.retrieval.filters) {
        expect(input.ai_search_options.retrieval.filters).toEqual({
          folder: { $in: [other + "/"] },
        });
      }
      expect(input.ai_search_options.retrieval.return_on_failure).toBe(false);
      if (failSearch) throw Error("private");
      return {
        chunks: [...items.values()].map((item) => ({
          item: { key: item.key },
          text: "private text",
          score: 0.8,
        })),
      };
    },
  };
  const env: any = {
    APP_CAPABILITIES: JSON.stringify({
      [scope]: { search: "APP_SEARCH_TEST" },
    }),
    APP_SEARCH_TEST: provider,
    FILES: {
      head: async () => ({ version: "v1" }),
      get: async (key: string) => ({
        version: "v1",
        body: new Response("text").body,
      }),
    },
  };
  const store = new SearchStore(storage, env, scope, async () => {
    wakes++;
    await onWake?.(wakes);
  });
  const sdk = searchContext(async (op, input: any) => {
    if (op === "query") return store.query(input);
    if (op === "validate") return store.validate(input.fileIds);
    return (store as any)[op](input.fileId);
  });
  return {
    db,
    storage,
    env,
    store,
    sdk,
    id,
    other,
    items,
    get uploads() {
      return uploads;
    },
    get wakes() {
      return wakes;
    },
    fault: (kind: string) => {
      failUpload = kind === "upload";
      failDelete = kind === "delete";
      failSearch = kind === "search";
    },
    during: (fn: () => Promise<void>) => {
      duringUpload = fn;
    },
  };
}
describe("Scoped derived search", () => {
  it("is opt-in, asynchronous and idempotent, with actual provider readiness", async () => {
    const f = fixture();
    expect((await f.store.status(f.id)).status).toBe("excluded");
    expect(await f.store.query({ query: "x" })).toEqual([]);
    expect((await f.store.index(f.id)).status).toBe("pending");
    await f.store.index(f.id);
    await f.store.work();
    await f.store.work();
    expect(f.uploads).toBe(1);
    expect(f.wakes).toBeGreaterThan(0);
    expect((await f.store.status(f.id)).status).toBe("queued");
    [...f.items.values()][0].status = "completed";
    expect((await f.store.status(f.id)).status).toBe("completed");
  });
  it("recovers an upload whose acknowledgement was lost without a second object", async () => {
    const f = fixture();
    f.fault("upload");
    await f.store.index(f.id);
    await f.store.work();
    expect((await f.store.status(f.id)).error).toBe("SEARCH_UNAVAILABLE");
    f.fault("");
    await f.store.work();
    expect(f.uploads).toBe(1);
    expect(f.items.size).toBe(1);
    expect((await f.store.status(f.id)).status).toBe("queued");
  });
  it("reindexes a failed item through the same bounded native upload path", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    const key = [...f.items.keys()][0];
    f.items.get(key)!.status = "error";
    await f.store.status(f.id);
    await f.store.index(f.id);
    await f.store.work();
    expect(f.uploads).toBe(2);
    expect([...f.items.keys()]).toEqual([key]);
    expect((await f.store.status(f.id)).status).toBe("queued");
  });
  it("requires a trusted ACL callback and excludes another user's hits", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.index(f.other);
    await f.store.work();
    expect(await f.sdk.query({ query: "x" }, async () => [])).toEqual([]);
    const hits = await f.sdk.query({ query: "x" }, async () => [f.id]);
    expect(hits.map((h) => h.fileId)).toEqual([f.id]);
    // Provider fixture deliberately ignores filters: local filtering must still enforce selection.
    expect(
      (
        await f.sdk.query(
          { query: "x", fileIds: [f.other] },
          async (ids) => ids,
        )
      ).map((h) => h.fileId),
    ).toEqual([f.other]);
    await expect(
      f.sdk.query({ query: "x" }, undefined as any),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.sdk.query({ query: "x" }, async () => [crypto.randomUUID()]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rechecks exclusion and source deletion after ACL evaluation", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    expect(
      await f.sdk.query({ query: "x" }, async (ids) => {
        await f.store.exclude(f.id);
        return ids;
      }),
    ).toEqual([]);
    f.fault("delete");
    await f.store.work();
    expect(f.items.size).toBe(1);
    expect(await f.store.query({ query: "x" })).toEqual([]);
    f.fault("");
    await f.store.work();
    expect(f.items.size).toBe(0);
    await f.store.index(f.other);
    await f.store.work();
    expect(
      await f.sdk.query({ query: "x" }, async (ids) => {
        f.db.query("DELETE FROM files WHERE id=?").run(f.other);
        return ids;
      }),
    ).toEqual([]);
  });
  it("cleans up an upload excluded while the provider is running", async () => {
    const f = fixture();
    f.during(async () => {
      await f.store.exclude(f.id);
    });
    await f.store.index(f.id);
    await f.store.work();
    expect(await f.store.query({ query: "x" })).toEqual([]);
    await f.store.work();
    expect(f.items.size).toBe(0);
    expect(f.store.summary().remaining).toBe(0);
  });
  it("does not accept caller scope/filter, unsupported files or private error bodies", async () => {
    const f = fixture();
    await expect(
      f.store.query({ query: "x", filters: {} } as any),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(f.store.index("../prod/id")).rejects.toThrow();
    f.db
      .query("UPDATE files SET type='application/octet-stream' WHERE id=?")
      .run(f.id);
    await expect(f.store.index(f.id)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    f.fault("search");
    await expect(f.store.query({ query: "x" })).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
  });
  it("isolates environments and drains revoked grants using retained native bindings", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    const prod = new SearchStore(
      f.storage,
      f.env,
      scope.replace("/dev", "/prod"),
      async () => {},
    );
    await expect(prod.query({ query: "x" })).rejects.toMatchObject({
      code: "SEARCH_NOT_CONFIGURED",
    });
    expect(prod.validate([f.id])).toEqual([]);
    const revoked = new SearchStore(
      f.storage,
      { ...f.env, APP_CAPABILITIES: "{}" },
      scope,
      async () => {},
    );
    await revoked.reconcile();
    await revoked.work();
    expect(f.items.size).toBe(0);
    expect(revoked.summary().remaining).toBe(0);
  });
  it("retains cleanup evidence when an uncertain upload is absent from the provider list", async () => {
    const f = fixture();
    f.env.APP_SEARCH_TEST.items.upload = async () => {
      throw Error("Connection lost before acknowledgement");
    };
    await f.store.index(f.id);
    await f.store.work();
    await f.store.exclude(f.id);
    await f.store.work();
    expect((await f.store.status(f.id)).error).toBe(
      "SEARCH_RECONCILE_REQUIRED",
    );
    expect(f.store.summary().remaining).toBe(1);
    const row = f.db
      .query("SELECT key FROM search_items WHERE id=?")
      .get(f.id) as { key: string };
    f.items.set(row.key, {
      id: "late",
      key: row.key,
      status: "queued",
      source_id: "builtin",
    });
    await f.store.work();
    expect(f.store.summary().remaining).toBe(0);
    expect(f.items.size).toBe(0);
  });
  for (const operation of ["exclude", "clear"] as const) {
    it(`does not resurrect an in-flight selection after ${operation}`, async () => {
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const armed = new Promise<void>((r) => {
        started = r;
      });
      const f = fixture(async (count) => {
        if (count === 1) {
          started();
          await gate;
        }
      });
      const index = f.store.index(f.id);
      await armed;
      if (operation === "exclude") await f.store.exclude(f.id);
      else await f.store.clear();
      release();
      await index;
      await f.store.work();
      expect((await f.store.status(f.id)).enabled).toBe(false);
      expect(f.uploads).toBe(0);
    });
  }
  it("gives revoked grants a fresh cleanup budget after exhausted indexing attempts", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    f.db.query("UPDATE search_items SET attempts=3 WHERE id=?").run(f.id);
    const revoked = new SearchStore(
      f.storage,
      { ...f.env, APP_CAPABILITIES: "{}" },
      scope,
      async () => {},
    );
    await revoked.reconcile();
    await revoked.work();
    expect(f.items.size).toBe(0);
    expect(revoked.summary().remaining).toBe(0);
  });
  it("does not let a stale status request cancel a retry", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    const info = [...f.items.values()][0];
    info.status = "error";
    await f.store.status(f.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.env.APP_SEARCH_TEST.items.get = () => ({
      info: async () => {
        await gate;
        return info;
      },
    });
    const stale = f.store.status(f.id);
    await f.store.index(f.id);
    release();
    await stale;
    expect(
      f.db.query("SELECT status FROM search_items WHERE id=?").get(f.id),
    ).toEqual({ status: "pending" });
  });
  it("surfaces a crash on the final attempt and allows an explicit retry", async () => {
    const f = fixture();
    await f.store.index(f.id);
    f.db
      .query("UPDATE search_items SET status='sending',attempts=3 WHERE id=?")
      .run(f.id);
    await f.store.reconcile();
    expect(await f.store.status(f.id)).toMatchObject({
      status: "error",
      error: "SEARCH_RECONCILE_REQUIRED",
    });
    await f.store.index(f.id);
    await f.store.work();
    expect((await f.store.status(f.id)).status).toBe("queued");
    expect(f.uploads).toBe(1);
  });
  it("does not upload replacement bytes after recording an R2 version", async () => {
    const f = fixture();
    await f.store.index(f.id);
    f.db
      .query("UPDATE search_items SET version='previous-version' WHERE id=?")
      .run(f.id);
    let cancelled = false;
    f.env.FILES.get = async () => ({
      version: "new-version",
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    await f.store.work();
    expect(cancelled).toBe(true);
    expect(f.uploads).toBe(0);
    expect((await f.store.status(f.id)).error).toBe("SEARCH_UNAVAILABLE");
  });
  it("rearms a pending selection after the first durable wake fails", async () => {
    const f = fixture(async (count) => {
      if (count === 1) throw Error("alarm unavailable");
    });
    await expect(f.store.index(f.id)).rejects.toThrow("alarm unavailable");
    expect((await f.store.index(f.id)).status).toBe("pending");
    expect(f.wakes).toBe(2);
    await f.store.work();
    expect(f.uploads).toBe(1);
  });
  it("deletes a known item even when the provider list omits it", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    f.env.APP_SEARCH_TEST.items.list = async () => ({ result: [] });
    await f.store.exclude(f.id);
    await f.store.work();
    expect(f.items.size).toBe(0);
    expect(f.store.summary().remaining).toBe(0);
  });
  it("recovers a lost delete acknowledgement only on explicit item-not-found", async () => {
    const f = fixture();
    await f.store.index(f.id);
    await f.store.work();
    const originalDelete = f.env.APP_SEARCH_TEST.items.delete;
    f.env.APP_SEARCH_TEST.items.delete = async (id: string) => {
      await originalDelete(id);
      throw Error("lost acknowledgement");
    };
    await f.store.exclude(f.id);
    await f.store.work();
    expect(f.store.summary().remaining).toBe(1);
    f.env.APP_SEARCH_TEST.items.delete = async () => {
      throw Object.assign(Error("ai_search_not_found"), {
        name: "AiSearchNotFoundError",
      });
    };
    await f.store.work();
    expect(f.store.summary().remaining).toBe(1);
    f.env.APP_SEARCH_TEST.items.delete = async () => {
      throw Error("item_not_found");
    };
    await f.store.work();
    expect(f.store.summary().remaining).toBe(0);
  });
  it("excludes unknown provider objects even inside the attached instance", async () => {
    const f = fixture();
    f.items.set("foreign", {
      id: "foreign",
      key: "foreign",
      status: "completed",
      source_id: "builtin",
    });
    expect(await f.store.query({ query: "x" })).toEqual([]);
    await f.store.clear();
    await f.store.work();
    expect(f.items.size).toBe(1);
  });
});
