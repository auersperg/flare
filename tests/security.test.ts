import { describe, it, expect, jest, afterEach, type Mock } from "bun:test";
import {
  verifyJwt,
  devToken,
  verifyDevToken,
  jsonBody,
  origins,
  projectCustomer,
  uuid,
  validateOidc,
  capture,
  unwrap,
  fail,
  accessEmail,
  accessAssertion,
} from "../packages/core/src/security.js";
import {
  compatibleSchema,
  validateRelease,
} from "../packages/core/src/release.js";
const base = {
  issuer: "https://identity.example",
  audience: "flare-test",
  jwks: "https://identity.example/jwks",
};
const encode = (x: unknown) =>
  Buffer.from(JSON.stringify(x)).toString("base64url");
async function jwt(patch: any = {}, header: any = {}) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const kid = crypto.randomUUID(),
    jwk = await crypto.subtle.exportKey("jwk", pair.publicKey),
    url = "https://identity.example/" + kid;
  const response = Response.json({ keys: [{ ...jwk, kid, alg: "RS256" }] });
  const mock = Object.assign(async () => response.clone(), {
    preconnect: fetch.preconnect,
  });
  jest.spyOn(globalThis, "fetch").mockImplementation(mock);
  const h = encode({ alg: "RS256", kid, ...header }),
    p = encode({
      iss: base.issuer,
      aud: base.audience,
      sub: "owner",
      exp: Date.now() / 1000 + 600,
      ...patch,
    }),
    s = Buffer.from(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(h + "." + p),
      ),
    ).toString("base64url");
  return { token: h + "." + p + "." + s, config: { ...base, jwks: url } };
}
afterEach(() => jest.restoreAllMocks());
describe("Flare security boundary", () => {
  it("verifies native RS256 and caches configured JWKS", async () => {
    const { token, config } = await jwt();
    expect((await verifyJwt(token, config)).subject).toBe("owner");
    await verifyJwt(token, config);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("refreshes JWKS on key rotation without waiting for normal cache expiry", async () => {
    const first = await jwt();
    await verifyJwt(first.token, first.config);
    const second = await jwt();
    expect((await verifyJwt(second.token, first.config)).subject).toBe("owner");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("single-flights concurrent JWKS fetches", async () => {
    const x = await jwt();
    await Promise.all(
      Array.from({ length: 5 }, () => verifyJwt(x.token, x.config)),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds unknown-kid refresh attempts", async () => {
    const x = await jwt({}, { kid: "unknown" });
    for (let i = 0; i < 5; i++)
      await expect(verifyJwt(x.token, x.config)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { iss: "https://wrong.example" },
    { aud: "other-project" },
    { exp: Date.now() / 1000 - 60 },
    { sub: "" },
    { nbf: Date.now() / 1000 + 600 },
  ])("rejects wrong identity context %j", async (patch) => {
    const x = await jwt(patch);
    await expect(verifyJwt(x.token, x.config)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("rejects forged JWT signatures and algorithm confusion", async () => {
    const x = await jwt();
    const parts = x.token.split(".");
    parts[1] = encode({
      iss: base.issuer,
      aud: base.audience,
      sub: "attacker",
      exp: Date.now() / 1000 + 600,
    });
    await expect(verifyJwt(parts.join("."), x.config)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const y = await jwt({}, { alg: "none" });
    await expect(verifyJwt(y.token, y.config)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("does not follow token-controlled keys or redirects", async () => {
    const x = await jwt({}, { jku: "https://attacker.example" });
    await verifyJwt(x.token, x.config);
    expect((fetch as unknown as Mock<typeof fetch>).mock.calls[0][0]).toBe(
      x.config.jwks,
    );
    expect(
      (fetch as unknown as Mock<typeof fetch>).mock.calls[0][1]?.redirect,
    ).toBe("manual");
  });
  it("developer identity is bound to dev, issuer and project", async () => {
    const token = await devToken(
      "test-secret",
      "https://runtime.example",
      "a/dev",
      "owner",
    );
    expect(
      (
        await verifyDevToken(
          token,
          "test-secret",
          "https://runtime.example",
          "a/dev",
        )
      ).subject,
    ).toBe("owner");
    for (const scope of ["b/dev", "a/prod"])
      await expect(
        verifyDevToken(token, "test-secret", "https://runtime.example", scope),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      verifyDevToken(token, "different", "https://runtime.example", "a/dev"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("limits streamed bodies even without Content-Length", async () => {
    const req = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"x":"' + "a".repeat(100) + '"}',
    });
    await expect(jsonBody(req, 30)).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });
  it("requires exact origins, HTTPS identity and immutable IDs", () => {
    expect(
      origins(["http://localhost:5173", "https://app.example"]),
    ).toHaveLength(2);
    for (const x of ["*", "https://app.example/path", "http://remote.example"])
      expect(() => origins([x])).toThrow();
    expect(() =>
      validateOidc({ ...base, jwks: "https://attacker.example/jwks" }),
    ).toThrow();
    expect(() => uuid("../another")).toThrow();
  });
});
describe("release compatibility", () => {
  const next: any = {
    schema: {
      tasks: {
        document: {
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: false,
        },
        indexes: {},
      },
    },
    manifest: { runtimeAbi: 4, functions: {} },
    release: { hash: "a" },
  };
  it("rejects legacy ABI instead of maintaining compatibility", () =>
    expect(() =>
      compatibleSchema(null, { ...next, manifest: { runtimeAbi: 3 } }),
    ).toThrow());
  it("rejects unbounded/undeclared schema indexes", () =>
    expect(() =>
      compatibleSchema(null, {
        ...next,
        schema: {
          tasks: { ...next.schema.tasks, indexes: { bad: ["missing"] } },
        },
      }),
    ).toThrow());
  it("accepts native document schema", () =>
    expect(() => compatibleSchema(null, next)).not.toThrow());
  it("rejects unverified bundles before activation", async () =>
    await expect(validateRelease({} as any)).rejects.toMatchObject({
      code: "INVALID_RELEASE",
    }));
});

describe("native RPC errors", () => {
  it("preserves deliberate status codes across serialized envelopes", async () => {
    const out = JSON.parse(
      JSON.stringify(await capture(async () => fail("CONFLICT"))),
    );
    expect(() => unwrap(out)).toThrow();
    expect(out).toEqual({ ok: false, code: "CONFLICT" });
  });
  it("sanitizes unknown exceptions rather than exposing stack or secrets", async () => {
    const out = await capture(async () => {
      throw Error("PRIVATE_SENTINEL");
    });
    expect(out).toEqual({ ok: false, code: "OPERATION_FAILED" });
  });
  it("preserves false/null values without interpreting them as failures", async () => {
    expect(unwrap(await capture(async () => false))).toBe(false);
    expect(unwrap(await capture(async () => null))).toBe(null);
  });
});

describe("native Worker Access", () => {
  it("accepts only the expected platform-verified Access app", async () => {
    const getIdentity = jest.fn(async () => ({ email: "Adam@auer.wien" }));
    expect(
      await accessEmail({ aud: "flare", getIdentity } as any, "flare"),
    ).toBe("adam@auer.wien");
    expect(getIdentity).toHaveBeenCalledTimes(1);
  });
  it("rejects missing Access context and another matched app before loading identity", async () => {
    await expect(accessEmail(undefined, "flare")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const getIdentity = jest.fn();
    await expect(
      accessEmail({ aud: "other-app", getIdentity } as any, "flare"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getIdentity).not.toHaveBeenCalled();
  });
  it("rejects missing user identity even if an Access application matched", async () => {
    await expect(
      accessEmail(
        { aud: "flare", getIdentity: async () => undefined } as any,
        "flare",
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("Access assertion transport behind Static Assets", () => {
  it("reads signed assertion header or exactly one Access cookie", () => {
    expect(
      accessAssertion(
        new Request("https://app.test", {
          headers: {
            "CF-Access-Jwt-Assertion": "signed.header.jwt",
            cookie: "CF_Authorization=other",
          },
        }),
      ),
    ).toBe("signed.header.jwt");
    expect(
      accessAssertion(
        new Request("https://app.test", {
          headers: {
            cookie: "other=x; CF_Authorization=signed.cookie.jwt; another=y",
          },
        }),
      ),
    ).toBe("signed.cookie.jwt");
  });
  it("rejects unsigned identity headers and ambiguous cookies", () => {
    for (const headers of [
      { "Cf-Access-Authenticated-User-Email": "owner@example.test" },
      { cookie: "CF_Authorization=a; CF_Authorization=b" },
      { cookie: "CF_Authorization=" },
    ] as Record<string, string>[])
      expect(() =>
        accessAssertion(new Request("https://app.test", { headers })),
      ).toThrow();
  });
  it("verifies an Access-shaped signed identity before using its email", async () => {
    const x = await jwt({
      aud: [base.audience],
      email: "owner@example.test",
      type: "app",
    });
    expect((await verifyJwt(x.token, x.config)).claims.email).toBe(
      "owner@example.test",
    );
  });
});

it("fails closed on JWKS redirect without following it", async () => {
  const x = await jwt();
  jest.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/keys" },
    }),
  );
  await expect(verifyJwt(x.token, x.config)).rejects.toMatchObject({
    code: "AUTH_UNAVAILABLE",
  });
  expect(
    (fetch as unknown as Mock<typeof fetch>).mock.calls[0][1]?.redirect,
  ).toBe("manual");
});

describe("Simple project creation", () => {
  it("defaults grouping without asking the user", () => {
    expect(projectCustomer(undefined)).toBe("Default");
    expect(projectCustomer(" Existing team ")).toBe("Existing team");
  });
  it.each([null, false, 7, {}, "", " ", "x".repeat(101)])(
    "rejects invalid explicit grouping %p",
    (value) => {
      expect(() => projectCustomer(value)).toThrow("INVALID_INPUT");
    },
  );
});
