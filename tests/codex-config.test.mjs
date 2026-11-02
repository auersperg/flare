import { describe, expect, it } from "bun:test";
import { validatePlatformConfig } from "../packages/flare/src/cli/platform-config.mjs";
import { workerConfiguration } from "../packages/flare/src/cli/platform.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";
const scope = "00000000-0000-4000-8000-000000000001/dev";
describe("Managed Codex references", () => {
  it("generates only a private Runtime service binding and preserves the default config", () => {
    expect(validatePlatformConfig()).toEqual({ capabilities: {}, secrets: [] });
    const ref = {
      binding: "APP_CODEX_PERSONAL",
      service: "personal-codex",
      scope,
    };
    const config = {
      codex: [ref],
      capabilities: { [scope]: { codex: ref.binding } },
    };
    const state = newInstallation({
      account: "a".repeat(32),
      name: "proof",
      owner: "owner@example.test",
      subdomain: "test",
    });
    state.config = validatePlatformConfig(config);
    const release = {
      directory: "/fixture",
      manifest: { digest: "b".repeat(64) },
    };
    expect(
      workerConfiguration(state, release, "runtime").services,
    ).toContainEqual({
      binding: ref.binding,
      service: ref.service,
      entrypoint: "CodexService",
    });
    expect(
      JSON.stringify(workerConfiguration(state, release, "admin")),
    ).not.toContain("CodexService");
    expect(() =>
      validatePlatformConfig({
        ...config,
        codex: [ref, { ...ref, binding: "APP_CODEX_TWO" }],
      }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({
        ...config,
        capabilities: {
          [scope.replace("dev", "prod")]: { codex: ref.binding },
        },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({ codex: [{ ...ref, auth: "forbidden" }] }),
    ).toThrow();
  });
});
