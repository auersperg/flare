import type { ReactNode } from "react";
import { Badge } from "./ui/badge";

const statusVariants = new Map<
  string,
  "success" | "warning" | "info" | "destructive" | "secondary"
>([
  ...["ready", "active", "enabled", "ok", "completed", "development"].map(
    (status) => [status, "success"] as const,
  ),
  ...[
    "pending",
    "paused",
    "activating",
    "restoring",
    "incomplete",
    "required",
  ].map((status) => [status, "warning"] as const),
  ...[
    "uploading",
    "running",
    "queued",
    "enqueued",
    "production",
    "public registration",
    "public",
  ].map((status) => [status, "info"] as const),
  ...["error", "failed", "blocked", "unavailable"].map(
    (status) => [status, "destructive"] as const,
  ),
]);

/** Unknown states stay neutral, never imply success. The label remains readable without color. */
export function StatusBadge({
  status,
  children,
}: {
  status: string;
  children?: ReactNode;
}) {
  return (
    <Badge variant={statusVariants.get(status.toLowerCase()) ?? "secondary"}>
      {children ?? status}
    </Badge>
  );
}
