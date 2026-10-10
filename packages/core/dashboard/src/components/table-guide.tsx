import { useState, useId } from "react";
import { Plus, Download, Columns3 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "./ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Choice, ErrorNotice } from "./common";
import { migrationDraft } from "../lib/table-migration";
import type { Schema, Environment, Session } from "../lib/model";

export function TableGuide({
  tables,
  env,
  role,
  table,
}: {
  tables: Schema["tables"];
  env: Environment;
  role: Session["role"];
  table?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        {table ? <Columns3 /> : <Plus />}
        {role === "viewer"
          ? "Table workflow"
          : table
            ? "Edit table"
            : "Add table"}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Prepare a table migration</DialogTitle>
          <DialogDescription>
            Schema lives in application code. This prepares a draft, not a
            database change. Nothing is applied until you review and deploy a
            release.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <MigrationForm tables={tables} env={env} initialTable={table} />
        )}
      </DialogContent>
    </Dialog>
  );
}
function MigrationForm({
  tables,
  env,
  initialTable,
}: {
  tables: Schema["tables"];
  env: Environment;
  initialTable?: string;
}) {
  const [operation, setOperation] = useState<"create" | "add-column">(
    initialTable ? "add-column" : "create",
  );
  const [name, setName] = useState(initialTable ? "description" : "notes");
  const [table, setTable] = useState(initialTable ?? tables[0]?.name ?? "");
  const id = useId();
  let draft: ReturnType<typeof migrationDraft> | undefined;
  let error: string | undefined;
  try {
    draft = migrationDraft(operation, name, tables, table);
  } catch (e) {
    error = e instanceof Error ? e.message : "Invalid migration";
  }
  const download = () => {
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([draft.sql + "\n"], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${operation === "create" ? "create" : "alter"}_${operation === "create" ? name : "table"}.sql`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="min-w-0 space-y-4">
      <Tabs
        value={operation}
        onValueChange={(v) => {
          setOperation(v as typeof operation);
          setName(v === "create" ? "notes" : "description");
        }}
      >
        <TabsList>
          <TabsTrigger value="create">New table</TabsTrigger>
          <TabsTrigger value="add-column" disabled={!tables.length}>
            Add column
          </TabsTrigger>
        </TabsList>
        <TabsContent value={operation}>
          <FieldGroup>
            {operation === "add-column" && (
              <Field>
                <FieldLabel htmlFor={`${id}-table`}>Table</FieldLabel>
                <Choice
                  id={`${id}-table`}
                  label="Table to change"
                  value={table}
                  onChange={setTable}
                  items={tables.map((t) => ({ value: t.name, label: t.name }))}
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={id}>
                {operation === "create" ? "Table name" : "Column name"}
              </FieldLabel>
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
              />
              <FieldDescription>
                {operation === "create"
                  ? "Starts with a text primary key. Extend its fields in your repository before deploying."
                  : "Adds nullable text without deleting or rewriting existing rows."}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </TabsContent>
      </Tabs>
      {error ? (
        <ErrorNotice>{error}</ErrorNotice>
      ) : (
        draft && (
          <>
            <Tabs defaultValue="sql">
              <TabsList>
                <TabsTrigger value="sql">Migration SQL · draft</TabsTrigger>
                <TabsTrigger value="definition">Drizzle definition</TabsTrigger>
              </TabsList>
              <TabsContent value="sql">
                <pre className="code-block">{draft.sql}</pre>
              </TabsContent>
              <TabsContent value="definition">
                <pre className="code-block">{draft.definition}</pre>
              </TabsContent>
            </Tabs>
            <Button variant="outline" onClick={download}>
              <Download />
              Download SQL draft
            </Button>
          </>
        )
      )}
      <ol className="list-inside list-decimal space-y-2 text-xs text-muted-foreground">
        <li>Update your Drizzle schema and the app's declared tables.</li>
        <li>
          Register the reviewed SQL in the ordered Drizzle migration journal.
          Never overwrite applied migrations.
        </li>
        <li>
          Build a new release so the schema and SDK stay versioned together.
        </li>
      </ol>
      <pre className="code-block">{`flared build --entry app.ts --migrations drizzle --outdir release-next\nflared deploy --env ${env} --release release-next${env === "prod" ? " --confirm <project-UUID>" : ""}`}</pre>
      <p className="text-xs text-muted-foreground">
        Use a new output directory for each release. Schema drop/rename and
        arbitrary SQL execution are intentionally unavailable here.{" "}
        {env === "prod"
          ? "Test the migration in dev first; production deployment requires explicit confirmation."
          : "Refresh Data or Schema after the cloud release activates."}
      </p>
    </div>
  );
}
