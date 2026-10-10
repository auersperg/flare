import type {
  StandardSchemaV1,
  StandardJSONSchemaV1,
} from "@standard-schema/spec";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  assertPath,
  boundedJson,
  LIMITS,
  FlaredError,
  type Auth,
  type FunctionKind,
  type FunctionRef,
  type Json,
  type Manifest,
} from "./protocol.js";

export type Validator<I = unknown, O = I> = StandardSchemaV1<I, O> &
  StandardJSONSchemaV1<I, O>;
type ReadDatabase = Pick<
  DrizzleSqliteDODatabase,
  "select" | "selectDistinct" | "$count"
>;
export interface QueryContext {
  readonly db: ReadDatabase;
  readonly auth: Auth | null;
}
export interface MutationContext {
  readonly db: DrizzleSqliteDODatabase;
  readonly auth: Auth | null;
  readonly jobs: {
    schedule(
      path: string,
      args: Json,
      options?: { delaySeconds?: number },
    ): Promise<string>;
  };
}
export interface ActionContext {
  readonly auth: Auth | null;
  runQuery<I, O>(ref: FunctionRef<I, O>, args: I): Promise<O>;
  runMutation<I, O>(ref: FunctionRef<I, O>, args: I): Promise<O>;
  readonly secrets: { get(name: string): Promise<string> };
  readonly files: {
    upload(
      body: ReadableStream<Uint8Array>,
      contentType: string,
    ): Promise<string>;
    download(id: string): Promise<Response>;
  };
}
type Context<K extends FunctionKind> = K extends "action"
  ? ActionContext
  : K extends "mutation"
    ? MutationContext
    : QueryContext;
export interface Definition<
  K extends FunctionKind = FunctionKind,
  I = any,
  O = any,
> {
  readonly kind: K;
  readonly input: Validator<any, I>;
  readonly output: Validator<O, any>;
  readonly auth: "required" | "public";
  readonly handler: (ctx: Context<K>, args: I) => O | Promise<O>;
}
function declare<K extends FunctionKind>(kind: K) {
  return <IV extends Validator, OV extends Validator>(options: {
    input: IV;
    output: OV;
    auth?: "required" | "public";
    handler: (
      ctx: Context<K>,
      args: StandardSchemaV1.InferOutput<IV>,
    ) =>
      | StandardSchemaV1.InferInput<OV>
      | Promise<StandardSchemaV1.InferInput<OV>>;
  }): Definition<
    K,
    StandardSchemaV1.InferOutput<IV>,
    StandardSchemaV1.InferInput<OV>
  > => Object.freeze({ ...options, kind, auth: options.auth ?? "required" });
}
export const query = declare("query");
export const live = declare("live");
export const mutation = declare("mutation");
export const action = declare("action");
export interface FunctionTree {
  [key: string]: Definition | FunctionTree;
}
export function defineApp<const T extends FunctionTree>(options: {
  functions: T;
  tables: Record<string, SQLiteTable>;
}) {
  flatten(options.functions);
  return Object.freeze(options);
}
export function flatten(tree: FunctionTree): Record<string, Definition> {
  const out: Record<string, Definition> = Object.create(null);
  const ancestors = new Set<object>();
  function walk(node: FunctionTree, prefix: string, depth: number) {
    if (depth > 20 || ancestors.has(node))
      throw new FlaredError("INVALID_CONTRACT", "Invalid function tree");
    ancestors.add(node);
    for (const [name, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}/${name}` : name;
      assertPath(path);
      if (
        value &&
        typeof value === "object" &&
        "handler" in value &&
        typeof value.handler === "function"
      ) {
        const definition = value as Definition;
        if (!["query", "live", "mutation", "action"].includes(definition.kind))
          throw new FlaredError("INVALID_CONTRACT", "Invalid function kind");
        if (out[path])
          throw new FlaredError("INVALID_CONTRACT", "Duplicate function path");
        out[path] = definition;
      } else if (value && typeof value === "object")
        walk(value as FunctionTree, path, depth + 1);
      else
        throw new FlaredError(
          "INVALID_CONTRACT",
          "Invalid function definition",
        );
    }
    ancestors.delete(node);
  }
  walk(tree, "", 0);
  return out;
}
export function manifest(app: { functions: FunctionTree }): Manifest {
  const functions: Manifest["functions"] = Object.create(null);
  for (const [path, fn] of Object.entries(flatten(app.functions))) {
    const input = fn.input["~standard"].jsonSchema?.input({
      target: "draft-2020-12",
    });
    const output = fn.output["~standard"].jsonSchema?.output({
      target: "draft-2020-12",
    });
    if (!input || !output)
      throw new FlaredError(
        "INVALID_CONTRACT",
        `${path} requires JSON Schema converters`,
      );
    functions[path] = { kind: fn.kind, auth: fn.auth, input, output };
  }
  boundedJson(functions, 1048576);
  return { protocol: 1, runtimeAbi: 2, functions };
}
export async function validate<V extends StandardSchemaV1>(
  validator: V,
  value: unknown,
  output = false,
): Promise<StandardSchemaV1.InferOutput<V>> {
  boundedJson(value, output ? LIMITS.outputBytes : LIMITS.inputBytes);
  const result = await validator["~standard"].validate(value);
  if (result.issues)
    throw new FlaredError(
      output ? "INVALID_OUTPUT" : "INVALID_INPUT",
      output ? "Function returned invalid data" : "Arguments failed validation",
    );
  boundedJson(result.value, output ? LIMITS.outputBytes : LIMITS.inputBytes);
  return result.value;
}
