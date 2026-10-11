import { useState, useRef } from "react";
import { fileMetadata, uploadFile } from "@auersperg/flare";
import { RefreshCw, Download, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StatusBadge } from "./status-badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import { api, message, scopePath, scalar, type Row } from "../lib/model";
import { useResource, Status, Empty, Grid } from "./common";
import type { Scope } from "./dashboard";
type StoredFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  state: string;
  createdAt: number;
};
export function FilesView({ project, env, session }: Scope) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1);
  const path = scopePath(project, env),
    r = useResource<{
      page: StoredFile[];
      isDone: boolean;
      continueCursor: string | null;
    }>(
      path + "/files" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    ),
    file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [hasFile, setHasFile] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState("");
  const writable = session.role !== "viewer";
  async function upload() {
    const selected = file.current?.files?.[0];
    if (!selected) return;
    setBusy(true);
    setError("");
    setProgress("");
    let attempted = false;
    try {
      const metadata = fileMetadata(selected);
      if (env === "prod" && !confirm(`Upload to production ${project.name}?`))
        return;
      setProgress("Preparing upload…");
      attempted = true;
      const grant = await api<{ url: string }>(path + "/file-upload", {
        ...metadata,
        ...(env === "prod" ? { confirm: project.id } : {}),
      });
      setProgress(`Uploading ${selected.name}…`);
      await uploadFile(grant, selected);
      if (file.current) file.current.value = "";
      setHasFile(false);
      setProgress("Upload complete");
    } catch (e) {
      setProgress("");
      setError(
        message(e) +
          (attempted
            ? ". Check the refreshed list before retrying. Incomplete uploads expire automatically; they are not queue jobs."
            : ""),
      );
    } finally {
      setBusy(false);
      if (attempted) r.refresh();
    }
  }
  async function download(id: string) {
    setError("");
    try {
      const grant = await api<{ url: string }>(
        path + "/file-download?id=" + encodeURIComponent(id),
      );
      const link = document.createElement("a");
      link.href = grant.url;
      link.rel = "noreferrer";
      link.click();
    } catch (e) {
      setError(message(e));
    }
  }
  async function remove(id: string) {
    if (!confirm(`Permanently delete this ${env} file?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(path + "/file-delete", {
        id,
        ...(env === "prod" ? { confirm: project.id } : {}),
      });
      r.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="page-title">Files</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload snapshot"
          title="Reload snapshot"
          onClick={r.refresh}
          disabled={r.loading}
        >
          <RefreshCw />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Private R2 storage · streaming uploads · maximum 10 MiB · download links
        expire after 5 minutes. 50 files per page.
      </p>
      <Status loading={r.loading} error={error || r.error} />
      {progress && (
        <p role="status" className="text-xs text-muted-foreground">
          {progress}
        </p>
      )}
      {writable && (
        <div className="flex flex-wrap gap-2">
          <Input
            ref={file}
            type="file"
            className="max-w-sm"
            disabled={busy}
            aria-label="Choose file to upload"
            onChange={(e) => setHasFile(!!e.target.files?.length)}
          />
          <Button onClick={upload} disabled={busy || !hasFile}>
            Upload file
          </Button>
        </div>
      )}
      {r.data?.page.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              {["Name", "Type", "Size", "State", "Created", "Actions"].map(
                (x) => (
                  <TableHead key={x}>{x}</TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.data.page.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.type}</TableCell>
                <TableCell>
                  {row.size >= 1048576
                    ? `${(row.size / 1048576).toFixed(1)} MiB`
                    : row.size < 1024
                      ? `${row.size} B`
                      : `${(row.size / 1024).toFixed(1)} KiB`}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.state}>
                    {row.state === "pending"
                      ? "Awaiting upload"
                      : row.state === "uploading"
                        ? "Uploading / recovering"
                        : row.state}
                  </StatusBadge>
                </TableCell>
                <TableCell>
                  {new Date(row.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={`Download ${row.name}`}
                      disabled={row.state !== "ready" || busy}
                      onClick={() => void download(row.id)}
                    >
                      <Download />
                    </Button>
                    {writable && (
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`Delete ${row.name}`}
                        disabled={busy}
                        onClick={() => void remove(row.id)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        r.data && <Empty title="No stored files" />
      )}
      {r.data && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Page {cursors.length} · {r.data.page.length} files
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={r.loading || cursors.length === 1}
              onClick={() => setCursors((previous) => previous.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={r.loading || r.data.isDone}
              onClick={() => {
                if (r.data?.continueCursor)
                  setCursors((previous) => [
                    ...previous,
                    r.data!.continueCursor,
                  ]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
export function SchedulesView({ project, env, session }: Scope) {
  const path = scopePath(project, env),
    r = useResource<{
      pending: Row[];
      recent: Row[];
      crons: { name: string; path: string; cron: string; enabled: boolean }[];
    }>(path + "/jobs");
  const [error, setError] = useState("");
  async function pause(name: string) {
    if (env === "prod" && !confirm(`Pause production cron ${name}?`)) return;
    try {
      await api(path + "/cron-cancel", {
        name,
        ...(env === "prod" ? { confirm: project.id } : {}),
      });
      r.refresh();
    } catch (e) {
      setError(message(e));
    }
  }
  async function cancelPending(id: string) {
    if (env === "prod" && !confirm("Cancel this pending production job?"))
      return;
    setError("");
    try {
      const result = await api<{ cancelled: boolean }>(path + "/job-cancel", {
        id,
        ...(env === "prod" ? { confirm: project.id } : {}),
      });
      if (!result.cancelled)
        setError("This job is already enqueued; it cannot be cancelled here.");
    } catch (e) {
      setError(message(e));
    } finally {
      r.refresh();
    }
  }
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">Schedules</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload snapshot"
          title="Reload snapshot"
          onClick={r.refresh}
          disabled={r.loading}
        >
          <RefreshCw />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Durable scheduling → transactional outbox → Cloudflare Queues.
        At-least-once delivery; handlers must be idempotent. Times use UTC.
      </p>
      <Status loading={r.loading} error={r.error || error} />
      <Tabs defaultValue="scheduled">
        <TabsList variant="line">
          <TabsTrigger value="scheduled">Scheduled Functions</TabsTrigger>
          <TabsTrigger value="cron">Cron Jobs</TabsTrigger>
        </TabsList>
        <TabsContent value="scheduled" className="space-y-4 pt-4">
          <h2 className="section-title">Waiting to enqueue</h2>
          {r.data &&
            (r.data.pending.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {["Function", "Due (UTC)", "Job ID", ""].map((label, i) => (
                      <TableHead key={i}>{label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.data.pending.map((row) => (
                    <TableRow key={String(row.id)}>
                      <TableCell className="font-mono">
                        {String(row.path)}
                      </TableCell>
                      <TableCell>
                        {new Date(Number(row.dueAt)).toISOString()}
                      </TableCell>
                      <TableCell className="font-mono">
                        {String(row.id)}
                      </TableCell>
                      <TableCell>
                        {session.role !== "viewer" && (
                          <Button
                            variant="outline"
                            disabled={r.loading}
                            onClick={() => void cancelPending(String(row.id))}
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty title="No delayed jobs" />
            ))}
          <h2 className="section-title">Recent queue deliveries</h2>
          {r.data &&
            (r.data.recent.length ? (
              <Grid
                rows={r.data.recent}
                columns={["id", "path", "state", "attempts", "error", "at"]}
                renderCell={(column, value) =>
                  column === "state" ? (
                    <StatusBadge status={String(value)} />
                  ) : column === "at" && typeof value === "number" ? (
                    new Date(value).toLocaleString()
                  ) : (
                    scalar(value)
                  )
                }
              />
            ) : (
              <Empty title="No queue deliveries yet" />
            ))}
        </TabsContent>
        <TabsContent value="cron" className="space-y-4 pt-4">
          {r.data?.crons.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {["Name", "Function", "Cron (UTC)", "State", ""].map(
                    (x, i) => (
                      <TableHead key={i}>{x}</TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.data.crons.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell className="font-mono">{row.path}</TableCell>
                    <TableCell className="font-mono">{row.cron}</TableCell>
                    <TableCell>
                      <StatusBadge
                        status={row.enabled ? "Enabled" : "Paused"}
                      />
                    </TableCell>
                    <TableCell>
                      {session.role !== "viewer" && row.enabled && (
                        <Button
                          variant="outline"
                          onClick={() => void pause(row.name)}
                        >
                          Pause
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            r.data && <Empty title="No cron jobs" />
          )}
          <p className="text-xs text-muted-foreground">
            Define schedules through an application action using
            ctx.schedules.set(). Five-field cron expressions, minimum one
            minute, maximum 20 per environment. No permanent frontend timers.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
