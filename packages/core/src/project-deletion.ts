import { fail, uuid } from "./security.js";

export function authorizeProjectDeletion(
  actor: { role: string; projectId: string | null },
  project: { id: string; name: string },
  input: { confirm?: unknown; name?: unknown },
) {
  if (actor.role !== "owner" || actor.projectId) fail("FORBIDDEN");
  if (input.confirm !== uuid(project.id) || input.name !== project.name)
    fail("INVALID_CONFIRMATION");
}

/** Idempotent cleanup. Retain only audit and immutable URL/ID reservations. */
export async function deleteProject(
  catalog: D1Database,
  runtime: {
    prepareDestroy(scope: string): Promise<unknown>;
    destroy(scope: string): Promise<unknown>;
  },
  projectId: string,
) {
  const id = uuid(projectId);
  // Persist the barrier and revoke deployment credentials before touching data.
  await catalog.batch([
    catalog
      .prepare("INSERT OR IGNORE INTO project_deletions VALUES (?,?)")
      .bind(id, Date.now()),
    catalog
      .prepare("UPDATE credentials SET revoked=1 WHERE projectId=?")
      .bind(id),
  ]);
  // Fence both serial gates before removing source backups or file bytes. This
  // lets an already-running cross-environment restore finish before cleanup.
  for (const env of ["dev", "prod"])
    await runtime.prepareDestroy(`${id}/${env}`);
  for (const env of ["dev", "prod"]) await runtime.destroy(`${id}/${env}`);
  // D1 batch is atomic; a failure leaves the visible project available for retry.
  await catalog.batch([
    catalog.prepare("DELETE FROM credentials WHERE projectId=?").bind(id),
    catalog.prepare("DELETE FROM environments WHERE projectId=?").bind(id),
    catalog
      .prepare("UPDATE project_aliases SET published=0 WHERE projectId=?")
      .bind(id),
    catalog.prepare("DELETE FROM projects WHERE id=?").bind(id),
  ]);
  return { deleted: true, id };
}
