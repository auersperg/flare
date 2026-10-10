import { RefreshCw, Activity, ShieldCheck } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { TableGuide } from "./table-guide";
import { FunctionBadge } from "./function-badge";
import { scalar, type FunctionDefinition } from "../lib/model";
import { useResource, Status, Empty, Grid } from "./common";
import {
  scopePath,
  type Health,
  type Settings,
  type Schema,
  type Row,
} from "../lib/model";
import type { Scope } from "./dashboard";
export function HealthView({
  project,
  env,
  connect,
}: Scope & { connect: () => void }) {
  const h = useResource<Health>(scopePath(project, env) + "/health"),
    s = useResource<Settings>(scopePath(project, env) + "/settings");
  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Health</h1>
      <Status loading={h.loading || s.loading} error={h.error || s.error} />
      {h.data && s.data && (
        <>
          <h2 className="section-title">Summary</h2>
          <Card>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge
                    className={
                      env === "dev" ? "environment-dev" : "environment-prod"
                    }
                  >
                    {env === "dev" ? "Development" : "Production"}
                  </Badge>
                  <strong>{project.name}</strong>
                </div>
                <p className="text-muted-foreground">
                  Cloudflare · Durable Objects · SQLite
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  Release {h.data.active?.slice(0, 12) ?? "not deployed"}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-muted-foreground">Cloud URL</p>
                <code className="block select-all break-all text-xs">
                  {s.data.url}
                </code>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span
                    className={`size-1.5 rounded-full ${h.data.status === "ready" ? "bg-emerald-500" : "bg-amber-500"}`}
                  />
                  {h.data.status} · {h.data.connections} connections ·{" "}
                  {h.data.subscriptions} subscriptions
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Live connections</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <strong className="text-2xl font-semibold tabular-nums">
                  {h.data.connections}
                </strong>
                <p className="text-muted-foreground">
                  Hibernating WebSocket connections
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Subscriptions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <strong className="text-2xl font-semibold tabular-nums">
                  {h.data.subscriptions}
                </strong>
                <p className="text-muted-foreground">Active live queries</p>
              </CardContent>
            </Card>
          </div>
          <h2 className="section-title">Insights</h2>
          <Card>
            <CardContent className="flex flex-col items-start gap-4">
              {env === "prod" && !s.data.oidc ? (
                <ShieldCheck className="size-6 text-amber-500" />
              ) : (
                <Activity
                  className={
                    h.data.status === "ready"
                      ? "size-6 text-emerald-500"
                      : "size-6 text-amber-500"
                  }
                />
              )}
              <h2 className="text-base font-medium">
                {env === "prod" && !s.data.oidc
                  ? "Authentication required"
                  : `Runtime ${h.data.status}`}
              </h2>
              <p className="max-w-lg text-muted-foreground">
                {env === "prod" && !s.data.oidc
                  ? "Configure OIDC in project settings. Protected functions remain closed."
                  : "Current runtime snapshot. Recent function calls are in Logs; historical analytics are not configured."}
              </p>
              <Button variant="outline" onClick={connect}>
                Connect SDK
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
export function SchemaView({ project, env, session }: Scope) {
  const r = useResource<Schema>(scopePath(project, env) + "/schema");
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">Schema</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={r.refresh} disabled={r.loading}>
            <RefreshCw />
            Refresh
          </Button>
          {r.data && (
            <TableGuide tables={r.data.tables} env={env} role={session.role} />
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Defined in code and applied through checked migrations. System tables
        are hidden.
      </p>
      <Status {...r} />
      {r.data?.tables.map((t) => (
        <Card key={t.name}>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="font-mono">{t.name}</CardTitle>
              <TableGuide
                tables={r.data!.tables}
                env={env}
                role={session.role}
                table={t.name}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Grid
              rows={t.columns.map((c) => ({
                Field: c.name,
                Type: c.type,
                Required: !!c.notnull,
                Primary: !!c.pk,
                Default: c.dflt_value,
              }))}
              columns={["Field", "Type", "Required", "Primary", "Default"]}
            />
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                Migration SQL
              </summary>
              <pre className="code-block mt-3">{t.sql}</pre>
            </details>
          </CardContent>
        </Card>
      ))}
      {r.data && !r.data.tables.length && (
        <Empty title="No application tables" />
      )}
    </div>
  );
}
export function FilesView() {
  return (
    <div className="p-4">
      <h1 className="page-title">Files</h1>
      <Empty title="File storage is not enabled">
        File upload and browsing are not part of this minimal release.
      </Empty>
    </div>
  );
}
export function SchedulesView({ project, env }: Scope) {
  const r = useResource<{ pending: Row[]; receipts: Row[] }>(
    scopePath(project, env) + "/jobs",
  );
  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Schedules</h1>
      <Status {...r} />
      <Tabs defaultValue="scheduled">
        <TabsList variant="line">
          <TabsTrigger value="scheduled">Scheduled Functions</TabsTrigger>
          <TabsTrigger value="cron" disabled>
            Cron Jobs · not enabled
          </TabsTrigger>
        </TabsList>
        <TabsContent value="scheduled" className="space-y-4 pt-4">
          {r.data && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Pending jobs</CardTitle>
                </CardHeader>
                <CardContent>
                  {r.data.pending.length ? (
                    <Grid
                      rows={r.data.pending}
                      columns={["id", "path", "dueAt", "release"]}
                      labels={{
                        id: "Job ID",
                        path: "Function",
                        dueAt: "Scheduled for",
                        release: "Release",
                      }}
                    />
                  ) : (
                    <Empty title="No pending scheduled functions" />
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Recent deliveries</CardTitle>
                </CardHeader>
                <CardContent>
                  {r.data.receipts.length ? (
                    <Grid
                      rows={r.data.receipts}
                      columns={["id", "at"]}
                      labels={{ id: "Job ID", at: "Delivered at" }}
                    />
                  ) : (
                    <Empty title="No deliveries yet" />
                  )}
                </CardContent>
              </Card>
              <p className="text-xs text-muted-foreground">
                At-least-once delivery. This view is read-only.
              </p>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
export function LogsView({ project, env }: Scope) {
  const r = useResource<Row[]>(scopePath(project, env) + "/logs");
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Logs</h1>
        <Button variant="outline" onClick={r.refresh} disabled={r.loading}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Last 100 invocation summaries. Not Cloudflare Tail logs or billing
        analytics.
      </p>
      <Status {...r} />
      {r.data &&
        (r.data.length ? (
          <Grid
            rows={r.data}
            renderCell={(column, value) =>
              column === "kind" &&
              ["query", "live", "mutation", "action"].includes(
                String(value),
              ) ? (
                <FunctionBadge kind={value as FunctionDefinition["kind"]} />
              ) : column === "at" && typeof value === "number" ? (
                new Date(value).toLocaleString()
              ) : (
                scalar(value)
              )
            }
            columns={["at", "path", "kind", "status", "ms"]}
            labels={{
              at: "Time",
              path: "Function",
              kind: "Type",
              status: "Status",
              ms: "Duration (ms)",
            }}
          />
        ) : (
          <Empty title="No recent function calls" />
        ))}
    </div>
  );
}
