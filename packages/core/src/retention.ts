/** Queue deliveries expire within 14 days. Thirty days is a bounded deduplication window, not exactly-once. */
export const jobRetentionMs = 30 * 86400000;
export function collectJobHistory(sql: SqlStorage, now: number): number {
  let deleted = 0;
  for (const statement of [
    "DELETE FROM receipts WHERE id IN (SELECT id FROM receipts WHERE at<? ORDER BY at LIMIT 1000)",
    "DELETE FROM job_events WHERE id IN (SELECT id FROM job_events WHERE state IN ('completed','failed') AND at<? ORDER BY at LIMIT 1000)",
  ])
    deleted += sql.exec(statement, now - jobRetentionMs).rowsWritten;
  return deleted;
}

const catalogDeadlines = new WeakMap<D1Database, number>();
/** Bounded on administrative writes; no cron, polling, or idle wake-up. A native
 * D1 lease prevents concurrent isolates from duplicating the sweep. */
export async function collectCatalog(database: D1Database, now = Date.now()) {
  if (now < (catalogDeadlines.get(database) ?? 0)) return;
  const next = now + 86400000;
  const claim = await database
    .prepare(
      "UPDATE maintenance SET next=? WHERE id=1 AND next<=? RETURNING id",
    )
    .bind(next, now)
    .first();
  catalogDeadlines.set(database, claim ? next : now + 60000);
  if (!claim) return;
  const statements = [
    database
      .prepare(
        "DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at<? ORDER BY at LIMIT 1000)",
      )
      .bind(now - 90 * 86400000),
    database
      .prepare(
        "DELETE FROM credentials WHERE hash IN (SELECT hash FROM credentials WHERE expiresAt<? ORDER BY expiresAt LIMIT 1000)",
      )
      .bind(now - 14 * 86400000),
    database
      .prepare(
        "DELETE FROM cli_logins WHERE id IN (SELECT id FROM cli_logins WHERE expiresAt<? ORDER BY expiresAt LIMIT 1000)",
      )
      .bind(now),
  ];
  const result = await database.batch(statements);
  if (result.some((value) => Number(value.meta.changes) >= 1000)) {
    catalogDeadlines.set(database, now + 60000);
    await database
      .prepare("UPDATE maintenance SET next=? WHERE id=1")
      .bind(now + 60000)
      .run();
  }
}

/** Five successful builds remain available regardless of age. Callers additionally protect facet outbox references. */
export const releaseRetentionQuery =
  "SELECT hash FROM releases WHERE at<? AND hash NOT IN (SELECT hash FROM release_history ORDER BY at DESC,hash DESC LIMIT 5) AND hash NOT IN (SELECT active FROM activation WHERE active IS NOT NULL UNION SELECT candidate FROM activation WHERE candidate IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM job_events WHERE job_events.release=releases.hash AND state!='completed') ORDER BY at LIMIT 100";
