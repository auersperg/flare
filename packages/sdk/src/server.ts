import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Validator, Schema } from "./schema.js";
import { schemaContract } from "./schema.js";
import type { ReadDatabase, WriteDatabase } from "./database.js";
export { defineSchema, defineTable, schemaContract } from "./schema.js";
export type {
  Validator,
  Schema,
  Doc,
  Value,
  Input,
  SchemaContract,
} from "./schema.js";
export type { ReadDatabase, WriteDatabase, Page } from "./database.js";
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

export interface QueryContext<S extends Schema = Schema> {
  readonly db: ReadDatabase<S>;
  readonly auth: Auth | null;
}
export interface MutationContext<S extends Schema = Schema> {
  readonly db: WriteDatabase<S>;
  readonly auth: Auth | null;
  readonly jobs: {
    cancel(id: string): Promise<boolean>;
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
  readonly schedules: {
    set(input: {
      name: string;
      path: string;
      cron: string;
      args: Json;
    }): Promise<{ id: string }>;
    cancel(name: string): Promise<boolean>;
    list(): Promise<
      { name: string; path: string; cron: string; enabled: boolean }[]
    >;
  };
  readonly secrets: { get(name: string): Promise<string> };
  readonly files: {
    upload(
      body: ReadableStream<Uint8Array>,
      contentType: string,
      options: { name: string; size: number },
    ): Promise<string>;
    download(id: string): Promise<Response>;
    generateUploadUrl(input: {
      name: string;
      type: string;
      size: number;
    }): Promise<{ id: string; url: string; expiresAt: number }>;
    getDownloadUrl(id: string): Promise<{ url: string; expiresAt: number }>;
    delete(id: string): Promise<{ deleted: boolean }>;
    list(input?: { cursor?: string | null; limit?: number }): Promise<{
      page: {
        id: string;
        name: string;
        type: string;
        size: number;
        state: string;
        createdAt: number;
      }[];
      continueCursor: string | null;
      isDone: boolean;
    }>;
  };
}
type Context<
  K extends FunctionKind,
  S extends Schema = Schema,
> = K extends "action"
  ? ActionContext
  : K extends "mutation"
    ? MutationContext<S>
    : QueryContext<S>;
export interface Definition<
  K extends FunctionKind = FunctionKind,
  I = any,
  O = any,
  S extends Schema = Schema,
> {
  readonly kind: K;
  readonly input: Validator<any, I>;
  readonly output: Validator<O, any>;
  readonly auth: "required" | "public" | "internal";
  readonly handler: (ctx: Context<K, S>, args: I) => O | Promise<O>;
}
function declare<K extends FunctionKind, S extends Schema = Schema>(kind: K) {
  return <IV extends Validator, OV extends Validator>(options: {
    input: IV;
    output: OV;
    auth?: "required" | "public" | "internal";
    handler: (
      ctx: Context<K, S>,
      args: StandardSchemaV1.InferOutput<IV>,
    ) =>
      | StandardSchemaV1.InferInput<OV>
      | Promise<StandardSchemaV1.InferInput<OV>>;
  }): Definition<
    K,
    StandardSchemaV1.InferOutput<IV>,
    StandardSchemaV1.InferInput<OV>,
    S
  > => Object.freeze({ ...options, kind, auth: options.auth ?? "required" });
}
export const query = declare("query");
export const mutation = declare("mutation");
export const action = declare("action");
export function createFunctions<S extends Schema>() {
  return {
    query: declare<"query", S>("query"),
    mutation: declare<"mutation", S>("mutation"),
    action,
  };
}
export interface FunctionTree {
  [key: string]: Definition<any, any, any, any> | FunctionTree;
}
export function defineApp<const T extends FunctionTree>(options: {
  functions: T;
  schema: Schema;
}) {
  flatten(options.functions);
  schemaContract(options.schema);
  return Object.freeze(options);
}
export function flatten(
  tree: FunctionTree,
): Record<string, Definition<any, any, any, any>> {
  const out: Record<string, Definition<any, any, any, any>> = Object.create(
    null,
  );
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
        const definition = value as Definition<any, any, any, any>;
        if (!["query", "mutation", "action"].includes(definition.kind))
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
  return { protocol: 1, runtimeAbi: 4, functions };
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
