import { FlareError, boundedJson } from "./protocol.js";

export interface CodexTaskInput {
  /** Stable UUID for retries of the same submission; retained for seven days. */
  id: string;
  prompt: string;
  /** Trusted application instructions, separate from the user's request. */
  instructions?: string;
  /** Optional JSON artifact in /workspace; collected only on successful completion. */
  outputFile?: string;
}
export interface CodexTask {
  id: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  result?: string;
  artifact?: string;
  error?: string;
}
export interface CodexContext {
  start(input: CodexTaskInput): Promise<CodexTask>;
  status(id: string): Promise<CodexTask | null>;
  cancel(id: string): Promise<CodexTask | null>;
  /** Erase the temporary artifact and prevent its later retention. An unstarted ID is fenced. */
  discardArtifact(id: string): Promise<void>;
}
export function codexInput(op: string, input: any): void {
  boundedJson(input, 40000);
  if (
    !input ||
    Array.isArray(input) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.id,
    ) ||
    !["start", "status", "cancel", "discardArtifact"].includes(op) ||
    Object.keys(input).some(
      (k) =>
        ![
          "id",
          ...(op === "start" ? ["prompt", "instructions", "outputFile"] : []),
        ].includes(k),
    ) ||
    (op === "start" &&
      (typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        new TextEncoder().encode(input.prompt).length > 16384 ||
        (input.instructions !== undefined &&
          (typeof input.instructions !== "string" ||
            new TextEncoder().encode(input.instructions).length > 16384)) ||
        (input.outputFile !== undefined &&
          (typeof input.outputFile !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}\.json$/.test(input.outputFile)))))
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
    discardArtifact: async (id) => {
      await invoke("discardArtifact", { id });
    },
  };
}
