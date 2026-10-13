import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
describe("Native RPC contracts", () => {
  it("keeps contracts type-only and removes dynamic proxy clients", () => {
    const read = (path: string) => readFileSync(path, "utf8");
    const contract = read("packages/core/src/rpc-contract.ts");
    expect(contract).not.toMatch(/export (?:const|function|class)|import \{/);
    for (const role of ["admin", "runtime"]) {
      const source = read(`packages/core/src/${role}.ts`);
      expect(source).not.toContain("new Proxy");
      expect(source).not.toContain("args: any[]");
    }
    expect(read("packages/core/src/runtime.ts")).toContain(
      'fail("INVALID_OPERATION")',
    );
    expect(read("packages/core/src/runtime.ts")).toContain(
      'fail("INVALID_INPUT")',
    );
  });
});
