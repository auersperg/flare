import { describe, expect, it } from "bun:test";
import {
  productionAcceptance,
  productionProfile,
} from "../scripts/production-acceptance.mjs";
import { newInstallation } from "../packages/flare/src/cli/platform-state.mjs";
import fixture from "./fixtures/production-app.ts";

describe("Disposable production acceptance safeguards", () => {
  it("derives job ownership server-side instead of expecting a session in an internal job", async () => {
    let scheduled;
    await fixture.functions.load.schedule.handler(
      {
        auth: { subject: "actual-owner" },
        jobs: {
          schedule: (...args) => {
            scheduled = args;
            return "job-id";
          },
        },
      },
      { key: "key", owner: "spoofed-owner" },
    );
    expect(scheduled).toEqual([
      "effects/run",
      { key: "key", owner: "actual-owner" },
      { delaySeconds: 5 },
    ]);
    let inserted;
    const attempt = await fixture.functions.effects.attempt.handler(
      {
        auth: null,
        db: {
          query: () => ({ withIndex: () => ({ first: async () => null }) }),
          insert: async (_table, row) => {
            inserted = row;
            return "row-id";
          },
        },
      },
      { key: "key", owner: "actual-owner" },
    );
    expect(attempt).toBe(1);
    expect(inserted.owner).toBe("actual-owner");
  });
  it("keeps the agreed profile fixed rather than relaxing thresholds after a run", () => {
    expect(Object.isFrozen(productionProfile)).toBe(true);
    expect(productionProfile).toEqual({
      clients: 10,
      subscriptions: 20,
      queryPerSecond: 5,
      mutationPerSecond: 1,
      durationSeconds: 600,
      p95Milliseconds: 1000,
      rpoSeconds: 86400,
      rtoSeconds: 3600,
    });
  });

  it("rejects a normal installation before SDK imports, requests or writes", async () => {
    const account = "a".repeat(32);
    const state = newInstallation({
      account,
      name: "personal",
      owner: "owner@example.test",
      subdomain: "example",
    });
    let requests = 0;
    await expect(
      productionAcceptance({
        cf: {
          account,
          api() {
            requests++;
            throw Error("Must not run");
          },
        },
        state,
      }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  });
});
