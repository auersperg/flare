import { expect, it, jest } from "bun:test";
import { InvocationSummaries } from "../packages/core/src/observability";
it("does not write SQL for successful queries and bounds ephemeral summaries", () => {
  const exec = jest.fn(() => ({ toArray: () => [] }));
  const log = new InvocationSummaries({ exec } as any);
  for (let i = 0; i < 201; i++)
    log.record({
      at: i,
      path: "tasks/list",
      kind: "query",
      status: "ok",
      ms: 1,
    });
  expect(exec).not.toHaveBeenCalled();
  const rows = log.list();
  expect(rows.length).toBe(100);
  expect(rows[0].at).toBe(200);
  expect(rows.at(-1)!.at).toBe(101);
  expect(exec).toHaveBeenCalledTimes(1);
});
it("keeps durable write/error summaries but never throws on diagnostic SQL failure", () => {
  const exec = jest.fn(() => {
    throw Error("diagnostics unavailable");
  });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const log = new InvocationSummaries({ exec } as any);
    expect(() =>
      log.record({
        at: 1,
        path: "tasks/add",
        kind: "mutation",
        status: "ok",
        ms: 1,
      }),
    ).not.toThrow();
    expect(() =>
      log.record({
        at: 2,
        path: "tasks/list",
        kind: "query",
        status: "error",
        ms: 1,
      }),
    ).not.toThrow();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(() => log.list()).toThrow(); // Dashboard must not claim telemetry is available.
  } finally {
    warn.mockRestore();
  }
});
