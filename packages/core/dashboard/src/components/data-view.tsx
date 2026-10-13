import { useState } from "react";
import { Database, Search, Plus, RefreshCw, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Badge } from "./ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import {
  useResource,
  Status,
  Empty,
  FormDialog,
  readFields,
  type Modal,
} from "./common";
import {
  api,
  scalar,
  scopePath,
  type Schema,
  type Page,
  type Row,
  type Column,
} from "../lib/model";
import { contractFields, type Field } from "../lib/presentation";
import type { Scope } from "./dashboard";
export function columnFields(columns: Column[], row?: Row): Field[] {
  return columns
    .filter((c) => c.name !== "_id" && c.name !== "_creationTime")
    .map((c) => {
      const f = contractFields({
        properties: {
          [c.name]: c.schema ?? {
            type: /INT|REAL/i.test(c.type) ? "number" : "string",
          },
        },
        required: c.notnull ? [c.name] : [],
      })[0];
      return {
        ...f,
        defaultMode: !row && c.dflt_value !== null,
        value: row ? row[c.name] : f.value,
      };
    });
}

export default function DataView(scope: Scope) {
  const path = scopePath(scope.project, scope.env),
    schema = useResource<Schema>(path + "/schema");
  const [table, setTable] = useState(""),
    [filter, setFilter] = useState("");
  const tables = schema.data?.tables ?? [],
    active = tables.find((t) => t.name === table)?.name ?? tables[0]?.name;
  return (
    <div className="flex h-full min-h-0">
      <section
        className="explorer-sidebar overflow-y-auto"
        aria-label="Application tables"
      >
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h1 className="page-title">Data</h1>
            <span className="text-xs text-muted-foreground">
              {tables.length} tables
            </span>
          </div>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search tables"
              placeholder="Search tables…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </InputGroup>
        </div>
        <div className="space-y-1 px-2">
          {tables
            .filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
            .map((t) => (
              <Button
                variant="ghost"
                className={`w-full justify-start gap-2 ${active === t.name ? "bg-accent" : ""}`}
                key={t.name}
                onClick={() => setTable(t.name)}
              >
                <Database />
                {t.name}
              </Button>
            ))}
        </div>
        <p className="p-4 text-xs text-muted-foreground">
          Tables are defined in code.
        </p>
      </section>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Status {...schema} />
        {active ? (
          <DataTable key={active} {...scope} table={active} />
        ) : schema.data ? (
          <Empty title="No application tables in this release" />
        ) : null}
      </section>
    </div>
  );
}
function DataTable({
  project,
  env,
  session,
  table,
}: Scope & { table: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined),
    [modal, setModal] = useState<Modal>();
  const path = scopePath(project, env),
    r = useResource<Page>(
      path +
        "/data?table=" +
        encodeURIComponent(table) +
        (cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)),
    );
  const page = r.data,
    pk = page?.columns.find((c) => c.pk === 1)?.name,
    write = session.role !== "viewer";
  const edit = (operation: "insert" | "update" | "delete", row?: Row) => {
    if (!page) return;
    const fields =
      operation === "delete" ? undefined : columnFields(page.columns, row);
    setModal({
      title:
        operation === "insert"
          ? "Add row"
          : operation === "update"
            ? "Edit row"
            : "Delete row",
      description:
        operation === "delete"
          ? "This deletes the selected row. The change is audited."
          : "Primary keys are immutable. NULL and defaults are explicit. Changes are revision-checked and audited.",
      fields,
      productionId: env === "prod" ? project.id : undefined,
      submit: async (form) => {
        await api(path + "/edit", {
          operation,
          table,
          key: row && pk ? row[pk] : undefined,
          values: fields ? readFields(form, fields) : undefined,
          expectedRevision: page.revision,
          confirm:
            env === "prod" ? new FormData(form).get("confirm") : undefined,
        });
        r.refresh();
      },
    });
  };
  return (
    <>
      <div className="detail-header">
        <div className="flex items-center gap-3">
          <h2 className="font-mono text-sm font-semibold">{table}</h2>
          {page && <Badge variant="secondary">{page.rows.length} rows</Badge>}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload snapshot"
            title="Reload snapshot"
            disabled={r.loading}
            onClick={r.refresh}
          >
            <RefreshCw />
          </Button>
          {write && (
            <Button
              disabled={!page || r.loading}
              onClick={() => edit("insert")}
            >
              <Plus />
              Add row
            </Button>
          )}
        </div>
      </div>
      <div className="flex justify-between border-b px-4 py-2 text-xs text-muted-foreground">
        <span>
          {page
            ? `${page.columns.length} columns · revision ${page.revision}`
            : "Loading table"}
        </span>
        <span>
          Snapshot · updates after edits and when returning to this tab
        </span>
      </div>
      <Status {...r} />
      {page && (
        <>
          <div
            className="min-h-0 flex-1 overflow-auto"
            aria-label="Table rows"
            role="region"
            tabIndex={0}
          >
            <Table containerClassName="overflow-visible">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  {page.columns.map((c) => (
                    <TableHead key={c.name}>
                      <span>{c.name}</span>
                      <small className="block font-normal text-muted-foreground">
                        {c.type.toLowerCase()}
                        {c.pk ? " · primary" : ""}
                      </small>
                    </TableHead>
                  ))}
                  {write && <TableHead>Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((row, i) => (
                  <TableRow key={pk ? String(row[pk]) : i}>
                    {page.columns.map((c) => (
                      <TableCell
                        className="max-w-sm truncate font-mono"
                        key={c.name}
                        title={scalar(row[c.name])}
                      >
                        {scalar(row[c.name])}
                      </TableCell>
                    ))}
                    {write && (
                      <TableCell>
                        {pk ? (
                          <div className="flex gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => edit("update", row)}
                              disabled={r.loading}
                            >
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="destructive"
                              onClick={() => edit("delete", row)}
                              disabled={r.loading}
                            >
                              Delete
                            </Button>
                          </div>
                        ) : (
                          "Read only"
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!page.rows.length && (
              <Empty title="No rows yet">
                Add a row or call a mutation from your app.
              </Empty>
            )}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-t p-4">
            <span className="text-xs text-muted-foreground">
              Up to 50 rows per page · changes are audited
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={cursor === undefined || r.loading}
                onClick={() => setCursor(undefined)}
              >
                First page
              </Button>
              <Button
                variant="outline"
                disabled={page.next === null || r.loading}
                onClick={() => setCursor(page.next ?? undefined)}
              >
                Next page
                <ChevronRight />
              </Button>
            </div>
          </footer>
        </>
      )}
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </>
  );
}
