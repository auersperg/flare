import { expect, test } from "bun:test";
import { Redactor, secretsFrom } from "../packages/codex/events.mjs";
test("redacts credential values even when split across streaming deltas", () => {
  const secret = "secret-refresh-value";
  for (let i = 1; i < secret.length; i++) {
    const r = new Redactor([secret]);
    expect(
      r.delta("hello " + secret.slice(0, i)) +
        r.delta(secret.slice(i) + " world") +
        r.delta("", true),
    ).toBe("hello [redacted] world");
  }
});
test("does not buffer ordinary words or expose protocol credentials", () => {
  const r = new Redactor(
    secretsFrom(
      { tokens: { access_token: "credential-value" } },
      "mcp-private-value",
    ),
  );
  expect(r.delta("One ")).toBe("One ");
  expect(r.delta("two.")).toBe("two.");
  expect(r.text("credential-value mcp-private-value")).toBe(
    "[redacted] [redacted]",
  );
});
