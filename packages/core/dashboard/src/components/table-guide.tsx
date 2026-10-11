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
import { schemaDraft } from "../lib/table-schema";
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
          <DialogTitle>Define a table</DialogTitle>
          <DialogDescription>
            Schema lives in application code. This prepares a draft, not a
            database change. Nothing is applied until you review and deploy a
            release.
          </DialogDescription>
        </DialogHeader>
        {open && <SchemaForm tables={tables} env={env} initialTable={table} />}
      </DialogContent>
    </Dialog>
  );
}
function SchemaForm({
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
  let draft: ReturnType<typeof schemaDraft> | undefined;
  let error: string | undefined;
  try {
    draft = schemaDraft(operation, name, tables, table);
  } catch (e) {
    error = e instanceof Error ? e.message : "Invalid schema";
  }
  const download = () => {
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([draft.definition + "\n"], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${operation === "create" ? "create" : "alter"}_${operation === "create" ? name : "table"}.ts`;
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
            Add field
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
                {operation === "create" ? "Table name" : "Field name"}
              </FieldLabel>
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
              />
              <FieldDescription>
                {operation === "create"
                  ? "Document IDs and creation timestamps are automatic. Define fields before deploying."
                  : "Adds an optional text field; existing documents remain valid."}
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
            <Tabs defaultValue="definition">
              <TabsList>
                <TabsTrigger value="notes">Activation</TabsTrigger>
                <TabsTrigger value="definition">Document schema</TabsTrigger>
              </TabsList>
              <TabsContent value="notes">
                <pre className="code-block">{draft.notes}</pre>
              </TabsContent>
              <TabsContent value="definition">
                <pre className="code-block">{draft.definition}</pre>
              </TabsContent>
            </Tabs>
            <Button variant="outline" onClick={download}>
              <Download />
              Download schema draft
            </Button>
          </>
        )
      )}
      <ol className="list-inside list-decimal space-y-2 text-xs text-muted-foreground">
        <li>Update flared/schema.ts with the document validator.</li>
        <li>
          Cloudflare validates existing documents and updates declared SQLite
          indexes atomically.
        </li>
        <li>
          Build a new release so the schema and SDK stay versioned together.
        </li>
      </ol>
      <pre className="code-block">{`bunx flared ${env === "prod" ? "deploy" : "dev"}`}</pre>
      <p className="text-xs text-muted-foreground">
        Schema changes are versioned with code. Destructive table removal and
        arbitrary SQL execution are intentionally unavailable here.{" "}
        {env === "prod"
          ? "Test the schema in dev first; production deployment requires explicit confirmation."
          : "Reopen Data or Schema after the cloud release activates."}
      </p>
    </div>
  );
}
