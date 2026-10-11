import ReleasesPanel from "./releases-panel";
import { RefreshCw, Activity, ShieldCheck } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
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
  session,
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
          <ReleasesPanel
            project={project}
            env={env}
            session={session}
            refresh={h.refresh}
          />
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
        Defined in code; validated documents and indexes activate atomically.
        System tables are hidden.
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
            <Grid
              rows={Object.entries(t.indexes).map(([name, fields]) => ({
                Index: name,
                Fields: fields.join(", "),
              }))}
              columns={["Index", "Fields"]}
            />
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                Document contract
              </summary>
              <pre className="code-block mt-3">
                {JSON.stringify(t.document, null, 2)}
              </pre>
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
        Last 100 invocation summaries. Successful queries are held in memory and
        disappear on hibernation/restart; writes and failures are persisted. Not
        Cloudflare Tail logs or billing analytics.
      </p>
      <Status {...r} />
      {r.data &&
        (r.data.length ? (
          <Grid
            rows={r.data}
            renderCell={(column, value) =>
              column === "kind" &&
              ["query", "mutation", "action"].includes(String(value)) ? (
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
