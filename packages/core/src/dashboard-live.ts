import { scopeForDeletion } from "./maintenance.js";
import { fail } from "./security.js";

export type DashboardIdentity = { email: string; expires: number };
export function dashboardIdentity(value: unknown): DashboardIdentity {
  const v = value as DashboardIdentity | null;
  if (
    !v ||
    typeof v.email !== "string" ||
    v.email.length > 254 ||
    !/^\S+@\S+\.\S+$/.test(v.email) ||
    !Number.isSafeInteger(v.expires) ||
    v.expires <= Date.now() ||
    v.expires > Date.now() + 600000
  )
    fail("UNAUTHORIZED");
  return { email: v.email.toLowerCase(), expires: v.expires };
}
/** Internal service RPC only. Recheck membership before every push; hints
 * contain no records/credentials. This is not the app query protocol. */
export async function dashboardAllowed(
  catalog: D1Database,
  scope: string,
  email: string,
) {
  const project = scopeForDeletion(scope).split("/")[0];
  const row = await catalog
    .prepare(
      "SELECT m.role FROM members m JOIN projects p ON p.id=? JOIN environments e ON e.projectId=p.id AND e.env=? WHERE m.email=? AND NOT EXISTS (SELECT 1 FROM project_deletions d WHERE d.projectId=p.id)",
    )
    .bind(project, scope.split("/")[1], email)
    .first<{ role: string }>();
  return !!row && ["owner", "editor", "viewer"].includes(row.role);
}
