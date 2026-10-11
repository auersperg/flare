import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { StatusBadge } from "../packages/core/dashboard/src/components/status-badge";
import SettingsView from "../packages/core/dashboard/src/components/settings-view";
import {
  FunctionBadge,
  functionColors,
} from "../packages/core/dashboard/src/components/function-badge";
import { schemaDraft } from "../packages/core/dashboard/src/lib/table-schema";
import { describe, it, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Grid,
  Value,
  Fields,
} from "../packages/core/dashboard/src/components/common";
import {
  values,
  contractFields,
} from "../packages/core/dashboard/src/lib/presentation";
const grid = (rows: Record<string, unknown>[], columns: string[]) =>
  renderToStaticMarkup(createElement(Grid, { rows, columns }));
const result = (value: unknown) =>
  renderToStaticMarkup(createElement(Value, { value }));
const fields = (items: any[]) =>
  renderToStaticMarkup(createElement(Fields, { items }));
describe("Dashboard presentation", () => {
  it("escapes untrusted keys, values and attributes", () => {
    expect(result("<script>")).toBe(
      '<span class="break-all">&lt;script&gt;</span>',
    );
    expect(grid([{ "<img>": "<script>" }], ["<img>"])).not.toContain(
      "<script>",
    );
    expect(
      fields([{ name: '"<x>', type: "string", value: '" onfocus="bad' }]),
    ).not.toContain('value="" onfocus');
  });
  it("preserves SQL null, empty strings, zero and false", () => {
    const input = [
      { name: "a", type: "string", nullable: true },
      { name: "b", type: "string" },
      { name: "c", type: "integer" },
      { name: "d", type: "boolean" },
    ];
    const data: any = {
      m0: "null",
      m1: "value",
      v1: "",
      m2: "value",
      v2: "0",
      m3: "value",
      v3: "false",
    };
    expect(values(input, (k) => data[k])).toEqual({
      a: null,
      b: "",
      c: 0,
      d: false,
    });
  });
  it("omits database defaults without inventing values", () => {
    expect(
      values(
        [{ name: "id", type: "integer", required: true, defaultMode: true }],
        () => "omit",
      ),
    ).toEqual({});
  });
  it("rejects missing, non-finite and fractional integer values", () => {
    for (const value of ["", "Infinity", "1.5"])
      expect(() =>
        values([{ name: "n", type: "integer" }], (k) =>
          k === "m0" ? "value" : value,
        ),
      ).toThrow();
  });
  it("validates required fields and nullable choices", () => {
    expect(() =>
      values([{ name: "n", type: "string", required: true }], () => "omit"),
    ).toThrow();
    expect(() =>
      values([{ name: "n", type: "string" }], () => "null"),
    ).toThrow();
  });
  it("bounds table rendering and produces structured results", () => {
    expect(
      (
        grid(
          Array.from({ length: 120 }, () => ({ a: 1 })),
          ["a"],
        ).match(/data-slot="table-cell"/g) ?? []
      ).length,
    ).toBe(100);
    expect(result([{ title: "hello" }])).toContain('data-slot="table"');
    expect(result(null)).toContain("null");
    expect(result([])).toContain("Empty list");
  });
  it("uses published input schema defaults and limits", () => {
    expect(
      contractFields({
        properties: { limit: { type: "integer", default: 50, maximum: 100 } },
      }),
    ).toEqual([
      {
        name: "limit",
        type: "integer",
        required: undefined,
        value: 50,
        choices: undefined,
        minimum: undefined,
        maximum: 100,
      },
    ]);
  });
  it("does not mutate the prototype through a column name", () => {
    const data = values([{ name: "__proto__", type: "string" }], (k) =>
      k === "m0" ? "value" : "safe",
    );
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.keys(data)).toEqual(["__proto__"]);
  });
});

describe("Dashboard standardization", () => {
  it.each(["owner", "editor", "viewer"] as const)(
    "exposes project deletion only to the owner, not %s",
    (role) => {
      const html = renderToStaticMarkup(
        createElement(SettingsView, {
          project: {
            id: "443eb045-22b8-4c1e-bfee-1eaf7b01a0f9",
            name: "Test",
            customer: "Team",
          },
          env: "dev",
          session: {
            role,
            email: "owner@example.test",
            runtime: "https://runtime.test",
          },
          onDeleted() {},
        }),
      );
      expect(html.includes(">Delete project</button>")).toBe(role === "owner");
    },
  );
  it.each([
    ["Ready", "success"],
    ["Active", "success"],
    ["Enabled", "success"],
    ["ok", "success"],
    ["completed", "success"],
    ["Development", "success"],
    ["pending", "warning"],
    ["Paused", "warning"],
    ["activating", "warning"],
    ["restoring", "warning"],
    ["Incomplete", "warning"],
    ["required", "warning"],
    ["uploading", "info"],
    ["running", "info"],
    ["queued", "info"],
    ["enqueued", "info"],
    ["Production", "info"],
    ["Public registration", "info"],
    ["public", "info"],
    ["error", "destructive"],
    ["failed", "destructive"],
    ["Blocked", "destructive"],
    ["unavailable", "destructive"],
    ["Disabled", "secondary"],
    ["Registration closed", "secondary"],
    ["not-deployed", "secondary"],
    ["internal", "secondary"],
    ["unknown-state", "secondary"],
    ["toString", "secondary"],
  ])("renders %s with the shared %s badge", (status, variant) => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status }));
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain(`data-variant="${variant}"`);
    expect(html).toContain(status);
  });
  it("keeps explicit status labels and safely escapes server content", () => {
    const html = renderToStaticMarkup(
      createElement(StatusBadge, { status: "error" }, "<INVALID_INPUT>"),
    );
    expect(html).toContain("&lt;INVALID_INPUT&gt;");
    expect(html).toContain('data-variant="destructive"');
  });
  it.each(["query", "mutation", "action"] as const)(
    "uses the native shadcn badge for %s without overriding its size",
    (kind) => {
      const html = renderToStaticMarkup(createElement(FunctionBadge, { kind }));
      expect(html).toContain('data-slot="badge"');
      expect(html).toContain(kind);
      expect(html).toContain(functionColors[kind]);
      expect(html).not.toContain("text-[10px]");
      expect(new Set(Object.values(functionColors)).size).toBe(3);
    },
  );
  it("uses native field, input-group and empty primitives", () => {
    expect(fields([{ name: "limit", type: "integer" }])).toContain(
      'data-slot="field"',
    );
    const read = (name: string) =>
      readFileSync(
        new URL(
          `../packages/core/dashboard/src/components/${name}`,
          import.meta.url,
        ),
        "utf8",
      );
    for (const name of ["data-view.tsx", "functions-view.tsx"]) {
      expect(read(name)).toContain("<InputGroup>");
      expect(read(name)).not.toMatch(/pl-8|text-\[10px\]|h-12/);
    }
    expect(read("common.tsx")).toContain("<EmptyRoot>");
    expect(read("sdk-view.tsx")).not.toContain(
      'from "../../../../flare/src/sdk/client"',
    );
    expect(read("sdk-view.tsx").replace(/\s+/g, " ")).toContain(
      "this page opens no background subscription",
    );
  });
  it("bounds column discovery to the displayed rows", () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      i === 100 ? { hiddenColumn: "not rendered" } : { title: "visible" },
    );
    expect(result(rows)).not.toContain("hiddenColumn");
  });
  it("accepts nullable scalar contracts and preserves descriptions", () => {
    const [field] = contractFields({
      required: ["name"],
      properties: {
        name: { type: ["string", "null"], description: "A label" },
      },
    });
    expect(field).toMatchObject({
      type: "string",
      nullable: true,
      description: "A label",
      required: true,
    });
    expect(values([field], () => "null")).toEqual({ name: null });
  });
  it("rejects malformed boolean and mode selections", () => {
    expect(() =>
      values([{ name: "done", type: "boolean" }], (k) =>
        k === "m0" ? "value" : "unexpected",
      ),
    ).toThrow("boolean");
    expect(() =>
      values([{ name: "title", type: "string" }], () => "unexpected"),
    ).toThrow("value mode");
  });
});

describe("Standard JSON Schema field forms", () => {
  it("preserves nullable union enums as typed choices", () => {
    const [f] = contractFields({
      properties: {
        status: {
          anyOf: [
            { type: "string", const: "open" },
            { type: "string", const: "closed" },
            { type: "null", const: null },
          ],
        },
      },
    });
    expect(f.choices).toEqual(["open", "closed", null]);
    expect(f.nullable).toBe(true);
  });
  it("uses lossless JSON input for mixed scalar unions", () => {
    const items = contractFields({
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect(items[0].type).toBe("json");
    expect(values(items, (key) => (key === "m0" ? "value" : "123"))).toEqual({
      value: 123,
    });
  });
});
describe("Document schema guidance", () => {
  it("prepares schema declarations without SQL or journal", () => {
    const create = schemaDraft("create", "notes", []);
    expect(create.definition).toContain("defineTable");
    expect(create.notes).toContain("No SQL");
    const field = schemaDraft(
      "add-column",
      "description",
      [{ name: "notes", columns: [{ name: "title" }] }],
      "notes",
    );
    expect(field.definition).toContain("z.string().optional()");
  });
  it.each([
    "",
    "x; DROP TABLE tasks",
    "sqlite_schema",
    "_flared_jobs",
    "A",
    "x".repeat(49),
  ])("rejects invalid or reserved name %s", (name) => {
    expect(() => schemaDraft("create", name, [])).toThrow();
  });
  it("rejects duplicate table/column names and missing tables", () => {
    const tables = [{ name: "Notes", columns: [{ name: "Description" }] }];
    expect(() => schemaDraft("create", "notes", tables)).toThrow("exists");
    expect(() =>
      schemaDraft("add-column", "description", tables, "Notes"),
    ).toThrow("exists");
    expect(() => schemaDraft("add-column", "value", tables, "missing")).toThrow(
      "Select",
    );
  });
  it("quotes preexisting identifiers without offering arbitrary SQL execution", () => {
    expect(
      schemaDraft(
        "add-column",
        "value",
        [{ name: 'odd"name', columns: [] }],
        'odd"name',
      ).notes,
    ).toContain("No ALTER TABLE");
    const source = readFileSync(
      new URL(
        "../packages/core/dashboard/src/components/table-guide.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source.replace(/\s+/g, " ")).toContain("not a database change");
    expect(source).not.toMatch(/\bapi\(/);
    expect(source).toContain("bunx flare");
  });
});
