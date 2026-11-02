import { FlareError, boundedJson } from "./protocol.js";

export interface CodexTaskInput {
  /** Stable UUID for retries of the same submission; retained for seven days. */
  id: string;
  prompt: string;
}
export interface CodexTask {
  id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}
export interface CodexContext {
  start(input: CodexTaskInput): Promise<CodexTask>;
  status(id: string): Promise<CodexTask | null>;
  cancel(id: string): Promise<CodexTask | null>;
}
export function codexInput(op: string, input: any): void {
  boundedJson(input, 20000);
  if (
    !input ||
    Array.isArray(input) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.id,
    ) ||
    !["start", "status", "cancel"].includes(op) ||
    Object.keys(input).some(
      (k) => !["id", ...(op === "start" ? ["prompt"] : [])].includes(k),
    ) ||
    (op === "start" &&
      (typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        new TextEncoder().encode(input.prompt).length > 16384))
  )
    throw new FlareError("INVALID_ARGUMENT", "Invalid Codex task");
}
export function codexContext(
  call: (op: string, input: unknown) => Promise<any>,
): CodexContext {
  const invoke = (op: string, input: unknown) => {
    codexInput(op, input);
    return call(op, input);
  };
  return {
    start: (input) => invoke("start", input),
    status: (id) => invoke("status", { id }),
    cancel: (id) => invoke("cancel", { id }),
  };
}
