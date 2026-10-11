/** Pure form-contract helpers. No HTML strings, network or platform capabilities. */
export type Field = {
  name: string;
  type: string;
  required?: boolean;
  value?: unknown;
  choices?: unknown[];
  minimum?: number;
  maximum?: number;
  defaultMode?: boolean;
  nullable?: boolean;
  description?: string;
};
export function values(
  items: Field[],
  read: (key: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  items.forEach((f, i) => {
    const mode = read(`m${i}`);
    if (!["value", "omit", "null"].includes(String(mode)))
      throw Error(`Invalid value mode: ${f.name}`);
    if (mode === "omit") {
      if (f.required && !f.defaultMode) throw Error(`${f.name} is required`);
      return;
    }
    if (mode === "null") {
      if (!f.nullable) throw Error(`${f.name} cannot be null`);
      Object.defineProperty(out, f.name, {
        value: null,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return;
    }
    const raw = String(read(`v${i}`) ?? "");
    let value: unknown = raw;
    if (f.choices) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n >= f.choices.length)
        throw Error(`Invalid ${f.name}`);
      value = f.choices[n];
    } else if (f.type === "number" || f.type === "integer") {
      const n = Number(raw);
      if (
        !raw.trim() ||
        !Number.isFinite(n) ||
        (f.type === "integer" && !Number.isSafeInteger(n)) ||
        (f.minimum !== undefined && n < f.minimum) ||
        (f.maximum !== undefined && n > f.maximum)
      )
        throw Error(`Invalid number: ${f.name}`);
      value = n;
    } else if (f.type === "boolean") {
      if (raw !== "true" && raw !== "false")
        throw Error(`Invalid boolean: ${f.name}`);
      value = raw === "true";
    } else if (["object", "array", "json"].includes(f.type)) {
      value = JSON.parse(raw);
      if (
        f.type === "json"
          ? false
          : f.type === "array"
            ? !Array.isArray(value)
            : !value || typeof value !== "object" || Array.isArray(value)
      )
        throw Error(`Invalid ${f.type}: ${f.name}`);
    }
    Object.defineProperty(out, f.name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return out;
}
export function contractFields(schema: any): Field[] {
  return Object.entries(schema?.properties ?? {}).map(
    ([name, original]: [string, any]) => {
      const alternatives =
        original.anyOf ??
        (Array.isArray(original.type)
          ? original.type.map((type: string) => ({ type }))
          : [original]);
      const p = {
        ...original,
        ...alternatives.find((v: any) => v.type !== "null"),
      };
      const nullable = alternatives.some(
        (v: any) => v.type === "null" || v.const === null,
      );
      const types = new Set(
        alternatives
          .filter((v: any) => v.type !== "null")
          .map((v: any) => v.type),
      );
      const choices =
        original.enum ??
        (alternatives.every((v: any) => Object.hasOwn(v, "const"))
          ? alternatives.map((v: any) => v.const)
          : p.enum);
      return {
        name,
        type: types.size === 1 && typeof p.type === "string" ? p.type : "json",
        ...(nullable ? { nullable: true } : {}),
        ...(typeof p.description === "string"
          ? { description: p.description }
          : {}),
        required: schema.required?.includes(name),
        value: p.default,
        choices,
        minimum: p.minimum,
        maximum: p.maximum,
      };
    },
  );
}
