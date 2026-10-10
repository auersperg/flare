import { Badge } from "./ui/badge";
import type { FunctionDefinition } from "../lib/model";

// Semantic function colors; geometry and typography stay with the shadcn preset.
export const functionColors = {
  query:
    "bg-yellow-100/50 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-200",
  mutation:
    "bg-blue-100/50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200",
  action:
    "bg-purple-100/50 text-purple-700 dark:bg-purple-900/50 dark:text-purple-200",
  live: "bg-green-100/50 text-green-700 dark:bg-green-900/50 dark:text-green-200",
} satisfies Record<FunctionDefinition["kind"], string>;

export function FunctionBadge({ kind }: { kind: FunctionDefinition["kind"] }) {
  return (
    <Badge variant="secondary" className={functionColors[kind]}>
      {kind}
    </Badge>
  );
}
