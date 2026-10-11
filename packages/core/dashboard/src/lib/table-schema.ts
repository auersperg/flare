/** Schema-only guidance: storage/index changes are handled atomically by native facet activation. */
export function schemaDraft(
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
      definition: `import {defineSchema,defineTable,z} from "@auersperg/flare/server";\n\nexport default defineSchema({\n  ${name}: defineTable(z.object({title:z.string()})),\n});`,
      notes:
        "No SQL migration needed. Edit flare/schema.ts and run bunx --bun --package @auersperg/flare flare dev.",
    };
  }
  const selected = tables.find((t) => t.name === table);
  if (!selected) throw Error("Select an existing table.");
  if (selected.columns.some((c) => c.name.toLowerCase() === name))
    throw Error("This field already exists.");
  return {
    definition: `// Add to ${selected.name}'s document validator in flare/schema.ts:\n${name}: z.string().optional(),\n\n// Existing documents remain valid. Use defaults or review existing data for required fields.`,
    notes:
      "No ALTER TABLE or SQL journal. Deploy the validated document schema with the application.",
  };
}
