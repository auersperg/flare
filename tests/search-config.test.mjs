import { describe, it, expect } from "bun:test";
import {
  validatePlatformConfig,
  validateSearchTransition,
} from "../packages/flare/src/cli/platform-config.mjs";
import { workerConfiguration } from "../packages/flare/src/cli/platform.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";

const scope = "00000000-0000-4000-8000-000000000001/dev";
const ref = {
  binding: "APP_SEARCH_DOCS",
  instance_name: "documents-dev",
  scope,
};
const enabled = {
  search: [ref],
  capabilities: { [scope]: { search: ref.binding } },
};
describe("Managed search bindings", () => {
  it("keeps existing default config byte shape, grants one instance to one environment", () => {
    expect(validatePlatformConfig()).toEqual({ capabilities: {}, secrets: [] });
    expect(validatePlatformConfig(enabled).capabilities[scope].search).toBe(
      ref.binding,
    );
    expect(() =>
      validatePlatformConfig({
        ...enabled,
        capabilities: {
          [scope.replace("dev", "prod")]: { search: ref.binding },
        },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({
        ...enabled,
        search: [ref, { ...ref, binding: "APP_SEARCH_OTHER" }],
      }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({
        ...enabled,
        search: [{ ...ref, apiToken: "forbidden" }],
      }),
    ).toThrow();
  });
  it("accepts native instance identifiers and rejects invalid names", () => {
    for (const instance_name of ["docs_dev", "docs-dev", "a".repeat(64)])
      expect(
        validatePlatformConfig({ search: [{ ...ref, instance_name }] })
          .search[0].instance_name,
      ).toBe(instance_name);
    for (const instance_name of [
      "docs--dev",
      "docs-",
      "-docs",
      "Docs",
      "a".repeat(65),
      "",
    ])
      expect(() =>
        validatePlatformConfig({ search: [{ ...ref, instance_name }] }),
      ).toThrow();
  });
  it("binds only Runtime and does not bind namespace-wide management", () => {
    const state = newInstallation({
      account: "a".repeat(32),
      name: "search",
      owner: "owner@example.test",
      subdomain: "test",
    });
    state.config = validatePlatformConfig(enabled);
    const release = {
      directory: "/tmp/fixture",
      manifest: {
        compatibilityDate: "2026-10-10",
        compatibilityFlags: ["nodejs_compat"],
        digest: "a".repeat(64),
      },
    };
    const runtime = workerConfiguration(state, release, "runtime");
    expect(runtime.ai_search).toEqual([
      { binding: ref.binding, instance_name: ref.instance_name },
    ]);
    expect(runtime.ai_search_namespaces).toBeUndefined();
    expect(
      workerConfiguration(state, release, "admin", "/tmp/fixture").ai_search,
    ).toBeUndefined();
  });
  it("requires disable, drain, then detach; never guesses that provider cleanup succeeded", async () => {
    const disabled = { search: [ref] };
    await validateSearchTransition(enabled, disabled, async () => {
      throw Error("not needed");
    });
    await expect(
      validateSearchTransition(enabled, {}, async () => ({
        search: { remaining: 0 },
      })),
    ).rejects.toThrow("Disable");
    await expect(
      validateSearchTransition(disabled, {}, async () => ({
        search: { remaining: 1 },
      })),
    ).rejects.toThrow("pending");
    await expect(
      validateSearchTransition(disabled, {}, async () => ({})),
    ).rejects.toThrow();
    await validateSearchTransition(disabled, {}, async (s) => {
      expect(s).toBe(scope);
      return { search: { remaining: 0 } };
    });
  });
});
