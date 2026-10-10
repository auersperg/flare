import { environment, fail, uuid } from "./security.js";

// Deliberately no public HTTP handler. Only account-controlled service bindings
// can request physical deletion, with an exact immutable environment scope.
export function scopeForDeletion(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_INPUT");
  const parts = value.split("/");
  if (parts.length !== 2) fail("INVALID_INPUT");
  return `${uuid(parts[0])}/${environment(parts[1])}`;
}
export async function eraseEnvironment(
  ctx: Pick<DurableObjectState, "storage" | "facets">,
) {
  ctx.facets.delete("app");
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  // Only this tiny marker survives. It prevents old tokens and at-least-once
  // queue messages from resurrecting a deleted environment.
  ctx.storage.sql.exec("CREATE TABLE _flared_deleted (id INTEGER PRIMARY KEY)");
  ctx.storage.sql.exec("INSERT INTO _flared_deleted VALUES (1)");
  await ctx.storage.sync();
}
