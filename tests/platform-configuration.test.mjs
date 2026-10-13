import { describe, expect, it } from "bun:test";
import { workerConfiguration } from "../packages/flare/src/cli/platform.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";
import { bindingNames } from "./fixtures/rpc-contract.ts";

function bindings(config) {
  return [
    ...Object.keys(config.vars),
    ...(config.d1_databases ?? []).map((b) => b.binding),
    ...(config.r2_buckets ?? []).map((b) => b.binding),
    ...(config.services ?? []).map((b) => b.binding),
    ...(config.worker_loaders ?? []).map((b) => b.binding),
    ...(config.durable_objects?.bindings ?? []).map((b) => b.name),
    ...(config.queues?.producers ?? []).map((b) => b.binding),
    ...(config.ratelimits ?? []).map((b) => b.name),
    ...(config.assets ? [config.assets.binding] : []),
  ];
}

describe("Single managed platform configuration", () => {
  it("agrees with typed native bindings using the sole managed generator", async () => {
    const state = newInstallation({
      account: "a".repeat(32),
      name: "binding",
      owner: "owner@example.test",
      subdomain: "test",
    });
    state.resources.catalog.id = crypto.randomUUID();
    const release = {
      directory: "/verified-payload",
      manifest: { compatibilityDate: "2026-10-10", digest: "b".repeat(64) },
    };
    for (const role of ["admin", "runtime"]) {
      const config = workerConfiguration(state, release, role);
      const expected = bindingNames[role].filter(
        (key) => key !== "DEV_SIGNING_KEY",
      ); // Supplied as a secret, never a var.
      for (const key of expected) {
        expect(bindings(config)).toContain(key);
      }
      expect(config.vars.DEV_SIGNING_KEY).toBeUndefined();
      expect(config.services).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            role === "admin"
              ? { binding: "RUNTIME", entrypoint: "RuntimeControl" }
              : { binding: "ADMIN_API", entrypoint: "AdminControl" },
          ),
        ]),
      );
      expect(config.compatibility_date).toBe(
        release.manifest.compatibilityDate,
      );
      expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
      expect(config.preview_urls).toBe(false);
      if (role === "runtime") {
        expect(config.durable_objects.bindings).toEqual([
          { name: "SUPERVISORS", class_name: "EnvironmentSupervisor" },
        ]);
        expect(config.exports).toEqual({
          EnvironmentSupervisor: { type: "durable-object", storage: "sqlite" },
        });
        expect(config.queues.consumers[0]).toEqual(
          expect.objectContaining({
            max_retries: 3,
            max_concurrency: 4,
            max_batch_size: 10,
          }),
        );
      }
    }
  });
  it("keeps bootstrap and adopted namespace differences explicit", () => {
    const state = newInstallation({
      account: "a".repeat(32),
      name: "binding",
      owner: "owner@example.test",
      subdomain: "test",
    });
    state.rateLimitNamespace = "17916201";
    const release = {
      directory: "/verified-payload",
      manifest: { compatibilityDate: "2026-10-10", digest: "b".repeat(64) },
    };
    expect(
      workerConfiguration(state, release, "runtime", true).services,
    ).toEqual([]);
    expect(
      workerConfiguration(state, release, "runtime").ratelimits[0].namespace_id,
    ).toBe("17916201");
  });
});
