import { describe, it, expect } from "bun:test";
import {
  validatePlatformConfig,
  accessConfiguration,
} from "../packages/flare/src/cli/platform-config.mjs";
import {
  configurationDigest,
  newInstallation,
} from "../packages/flare/src/cli/platform-state.mjs";
import { workerConfiguration } from "../packages/flare/src/cli/platform.mjs";
import { platformHealth } from "../packages/flare/src/cli/platform-health.mjs";
const scope = "00000000-0000-4000-8000-000000000001/dev";
describe("Managed native capabilities", () => {
  it("canonicalizes grants, binds only Runtime and never accepts values", () => {
    const config = validatePlatformConfig({
      capabilities: {
        [scope]: {
          outbound: ["api.example.com", "api.example.com"],
          secrets: { KEY: "APP_SECRET_KEY" },
        },
      },
      secrets: [
        {
          binding: "APP_SECRET_KEY",
          store_id: "a".repeat(32),
          secret_name: "app-key",
        },
      ],
    });
    expect(config.capabilities[scope].outbound).toEqual(["api.example.com"]);
    const state = newInstallation({
      account: "a".repeat(32),
      name: "proof",
      owner: "owner@example.test",
      subdomain: "test",
    });
    state.config = config;
    const release = {
      directory: "/fixture",
      manifest: { digest: "b".repeat(64) },
    };
    expect(
      workerConfiguration(state, release, "runtime").secrets_store_secrets,
    ).toEqual(config.secrets);
    expect(
      JSON.parse(
        workerConfiguration(state, release, "runtime").vars.APP_CAPABILITIES,
      ),
    ).toEqual(config.capabilities);
    expect(
      workerConfiguration(state, release, "admin").secrets_store_secrets,
    ).toBeUndefined();
    expect(
      workerConfiguration(state, release, "admin").vars.APP_CAPABILITIES,
    ).toBeUndefined();
    expect(() =>
      validatePlatformConfig({
        secrets: [{ ...config.secrets[0], value: "never-store-this" }],
      }),
    ).toThrow();
  });
  it.each([
    "*.example.com",
    "http://example.com",
    "127.0.0.1",
    "example.local",
    "api.example.com/path",
  ])("rejects non-exact public HTTPS host %s", (host) =>
    expect(() =>
      validatePlatformConfig({
        capabilities: { [scope]: { outbound: [host] } },
      }),
    ).toThrow(),
  );
  it("rejects unknown fields, dangling grants and unused references", () => {
    expect(() =>
      validatePlatformConfig({ accountToken: "forbidden" }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({
        capabilities: { [scope]: { secrets: { KEY: "DEV_SIGNING_KEY" } } },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformConfig({
        secrets: [
          {
            binding: "APP_SECRET_KEY",
            store_id: "a".repeat(32),
            secret_name: "key",
          },
        ],
      }),
    ).toThrow();
  });
});
describe("Semantic Access and bounded live health", () => {
  const app = {
    id: "fixture",
    domain: "dashboard.example.com",
    aud: "aud",
    updated_at: "old",
    session_duration: "8h",
  };
  const rules = [
    {
      id: "policy",
      decision: "allow",
      include: [{ email: { email: "owner@example.test" } }],
      updated_at: "old",
    },
  ];
  it("ignores only known response timestamps, guards security and unknown fields", () => {
    const digest = configurationDigest(accessConfiguration(app, rules));
    expect(
      configurationDigest(
        accessConfiguration({ ...app, updated_at: "new" }, [
          { ...rules[0], updated_at: "new" },
        ]),
      ),
    ).toBe(digest);
    for (const changed of [
      { ...app, session_duration: "24h" },
      { ...app, future_security_option: true },
    ])
      expect(configurationDigest(accessConfiguration(changed, rules))).not.toBe(
        digest,
      );
    expect(
      configurationDigest(
        accessConfiguration(app, [{ ...rules[0], decision: "bypass" }]),
      ),
    ).not.toBe(digest);
  });
  it("reports installed checkpoint separately, verifies expected runtime and Access challenge", async () => {
    const state = {
      id: "fixture",
      addresses: { runtimeHost: "runtime.example.com", adminHost: app.domain },
      installed: { version: "test", digest: "digest" },
      access: {
        id: app.id,
        aud: app.aud,
        issuer: "https://team.cloudflareaccess.com",
        snapshotFormat: 2,
        snapshot: configurationDigest(accessConfiguration(app, rules)),
      },
    };
    const cf = { api: async () => app, list: async () => rules };
    const ready = async (url) =>
      url.includes("/health")
        ? Response.json({
            readiness: "control-plane-ready",
            installationId: "fixture",
            version: "test",
            platformPayload: "digest",
          })
        : new Response(null, {
            status: 302,
            headers: { location: state.access.issuer + "/login" },
          });
    expect((await platformHealth(cf, state, ready)).status).toBe("ready");
    expect(
      (
        await platformHealth(cf, state, async () => {
          throw Error("network");
        })
      ).runtime.status,
    ).toBe("unavailable");
    expect(
      (
        await platformHealth(cf, state, async () =>
          Response.json({ version: "other" }),
        )
      ).runtime.status,
    ).toBe("mismatch");
    expect(
      (await platformHealth(cf, state, async () => new Response("public")))
        .dashboard.status,
    ).toBe("not-verified-closed");
    expect(
      (
        await platformHealth(
          { ...cf, list: async () => [{ ...rules[0], decision: "bypass" }] },
          state,
          ready,
        )
      ).access.status,
    ).toBe("drift");
  });
});
