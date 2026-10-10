import { describe, it, expect, vi } from "vitest";
import {
  scopeForDeletion,
  eraseEnvironment,
} from "../packages/core/src/maintenance.js";
const id = "443eb045-22b8-4c1e-bfee-1eaf7b01a0f9";
describe("trusted environment cleanup", () => {
  it.each(["dev", "prod"])("accepts only exact immutable scopes: %s", (env) =>
    expect(scopeForDeletion(`${id}/${env}`)).toBe(`${id}/${env}`),
  );
  it.each([
    undefined,
    null,
    "demo/dev",
    `${id}/staging`,
    `${id}/dev/extra`,
    `${id}/dev/`,
    `${id}/`,
    "../../dev",
    `${id}/DEV`,
  ])("rejects invalid scope %s", (scope) =>
    expect(() => scopeForDeletion(scope)).toThrow(),
  );
  it("erases facet, alarm and supervisor storage before writing only a tombstone", async () => {
    const calls: string[] = [];
    const ctx = {
      facets: { delete: vi.fn((name: string) => calls.push("facet:" + name)) },
      storage: {
        deleteAlarm: vi.fn(async () => {
          calls.push("alarm");
        }),
        deleteAll: vi.fn(async () => {
          calls.push("storage");
        }),
        sql: {
          exec: vi.fn((sql: string) => {
            calls.push(sql);
          }),
        },
        sync: vi.fn(async () => {
          calls.push("sync");
        }),
      },
    };
    await eraseEnvironment(ctx as any);
    expect(calls).toEqual([
      "facet:app",
      "alarm",
      "storage",
      "CREATE TABLE _flared_deleted (id INTEGER PRIMARY KEY)",
      "INSERT INTO _flared_deleted VALUES (1)",
      "sync",
    ]);
  });
  it("does not report success or write tombstone if physical deletion fails", async () => {
    const exec = vi.fn();
    const ctx = {
      facets: { delete: vi.fn() },
      storage: {
        deleteAlarm: vi.fn(async () => {}),
        deleteAll: vi.fn(async () => {
          throw Error("storage failure");
        }),
        sql: { exec },
        sync: vi.fn(),
      },
    };
    await expect(eraseEnvironment(ctx as any)).rejects.toThrow(
      "storage failure",
    );
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.storage.sync).not.toHaveBeenCalled();
  });
});
