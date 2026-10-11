import { describe, it, expect, jest } from "bun:test";
import {
  scopeForDeletion,
  eraseEnvironment,
  markEnvironmentDeleting,
} from "../packages/core/src/maintenance.js";
const id = "443eb045-22b8-4c1e-bfee-1eaf7b01a0f9";
describe("trusted environment cleanup", () => {
  it("durably closes an environment before physical cleanup starts", async () => {
    const calls: string[] = [];
    await markEnvironmentDeleting({
      storage: {
        sql: { exec: (sql: string) => calls.push(sql) },
        sync: async () => {
          calls.push("sync");
        },
      },
    } as any);
    expect(calls).toEqual([
      "CREATE TABLE IF NOT EXISTS _flared_deleted (id INTEGER PRIMARY KEY)",
      "INSERT OR IGNORE INTO _flared_deleted VALUES (0)",
      "sync",
    ]);
  });
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
      facets: {
        delete: jest.fn((name: string) => calls.push("facet:" + name)),
      },
      storage: {
        deleteAlarm: jest.fn(async () => {
          calls.push("alarm");
        }),
        deleteAll: jest.fn(async () => {
          calls.push("storage");
        }),
        sql: {
          exec: jest.fn((sql: string) => {
            calls.push(sql);
          }),
        },
        sync: jest.fn(async () => {
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
    const exec = jest.fn();
    const ctx = {
      facets: { delete: jest.fn() },
      storage: {
        deleteAlarm: jest.fn(async () => {}),
        deleteAll: jest.fn(async () => {
          throw Error("storage failure");
        }),
        sql: { exec },
        sync: jest.fn(),
      },
    };
    await expect(eraseEnvironment(ctx as any)).rejects.toThrow(
      "storage failure",
    );
    expect(exec).not.toHaveBeenCalled();
    expect(ctx.storage.sync).not.toHaveBeenCalled();
  });
});

import { buildKey, buildPrefix } from "../packages/core/src/release";
it("scopes immutable build storage and deletion to one environment", () => {
  const scope = `${id}/dev`,
    hash = "a".repeat(64);
  expect(buildKey(scope, hash, "facet")).toBe(
    `${buildPrefix(scope)}${hash}/facet.js`,
  );
  expect(buildKey(`${id}/prod`, hash, "facet")).not.toBe(
    buildKey(scope, hash, "facet"),
  );
  expect(() => buildKey("../../dev", hash, "action")).toThrow();
  expect(() => buildKey(scope, "../../old", "facet")).toThrow();
});
