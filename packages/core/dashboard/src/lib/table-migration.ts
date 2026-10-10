/** Offline scaffolding only. SQL is reviewed and deployed with the application's immutable release. */
export function migrationDraft(
  operation: "create" | "add-column",
  name: string,
  tables: { name: string; columns: { name: string }[] }[],
  table?: string,
) {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(name) || name.startsWith("sqlite_"))
    throw Error(
      "Use 1–48 lowercase letters, digits or underscores; start with a letter. sqlite_ is reserved.",
    );
  if (operation === "create") {
    if (tables.some((t) => t.name.toLowerCase() === name))
      throw Error("This table already exists.");
    return {
      definition: `import { sqliteTable, text } from 'drizzle-orm/sqlite-core';\n\nexport const newTable = sqliteTable('${name}', {\n  id: text('id').primaryKey(),\n});\n\n// Import newTable and add it to defineApp({ tables: { …, newTable }, … }).`,
      sql: `CREATE TABLE "${name}" (\n  "id" text PRIMARY KEY NOT NULL\n);`,
    };
  }
  const selected = tables.find((t) => t.name === table);
  if (!selected) throw Error("Select an existing table.");
  if (selected.columns.some((c) => c.name.toLowerCase() === name))
    throw Error("This column already exists.");
  const identifier = `"${selected.name.replaceAll('"', '""')}"`;
  return {
    definition: `// Add a nullable column to the existing Drizzle table definition:\n${name}: text('${name}'),\n\n// Existing rows retain NULL. Avoid destructive schema changes in production.`,
    sql: `ALTER TABLE ${identifier} ADD COLUMN "${name}" text;`,
  };
}
