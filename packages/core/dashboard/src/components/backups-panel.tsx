import { useState } from "react";
import { Button } from "./ui/button";
import { StatusBadge } from "./status-badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import { Status, FormDialog, useResource, type Modal } from "./common";
import { api, scopePath, type Environment } from "../lib/model";
import type { Scope } from "./dashboard";
type Backup = {
  id: string;
  at?: number;
  hash?: string;
  rows?: number;
  files?: number;
  state?: string;
};
export default function BackupsPanel(scope: Scope) {
  return (
    <div className="space-y-3 p-4 pt-0">
      <p className="text-muted-foreground">
        On-demand data, user accounts, files and backend code snapshots. Restore
        only into an empty environment. Sessions, secrets and schedules are not
        copied. No background polling.
      </p>
      <BackupList {...scope} />
    </div>
  );
}
function BackupList(scope: Scope) {
  const [source, setSource] = useState<Environment>(scope.env),
    [cursor, setCursor] = useState<string | null>(null),
    [modal, setModal] = useState<Modal>();
  const path = scopePath(scope.project, source),
    target = scopePath(scope.project, scope.env);
  const r = useResource<{ page: Backup[]; cursor: string | null }>(
    path + "/backups" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
  );
  const state = useResource<{
    id: string;
    status: string;
    source: string;
  } | null>(target + "/backup-status");
  const write = scope.session.role === "owner";
  const approve = (
    title: string,
    description: string,
    endpoint: string,
    body: object,
  ) =>
    setModal({
      title,
      description,
      productionId: scope.project.id,
      submit: async () => {
        await api(endpoint, { ...body, confirm: scope.project.id });
        r.refresh();
        state.refresh();
      },
    });
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Limits: 10,000 documents / 4 MiB data; 100 files / 100 MiB. Pause cron
        and drain jobs before creating a backup. Partial restores stay closed;
        retry the same backup ID.
      </p>
      {state.data?.status === "restoring" && (
        <p role="alert">
          <StatusBadge status="restoring">Restore in progress</StatusBadge>:{" "}
          {state.data.id}. Select its source environment and retry Restore to
          finish.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(["dev", "prod"] as const).map((env) => (
          <Button
            key={env}
            variant={source === env ? "secondary" : "outline"}
            onClick={() => {
              setSource(env);
              setCursor(null);
            }}
          >
            {env === "dev" ? "Development" : "Production"} backups
          </Button>
        ))}

        {write && (
          <Button
            onClick={() => {
              const id = crypto.randomUUID();
              approve(
                "Create backup",
                `Snapshot ${scope.env}. Backup ID: ${id}. No data will be deleted.`,
                target + "/backup-create",
                { id },
              );
            }}
          >
            Create {scope.env} backup
          </Button>
        )}
      </div>
      <Status
        loading={r.loading || state.loading}
        error={r.error || state.error}
      />
      {r.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Backup / release</TableHead>
              <TableHead>Documents</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.data.page.map((backup) => (
              <TableRow key={backup.id}>
                <TableCell>
                  {backup.at ? (
                    new Date(backup.at).toLocaleString()
                  ) : (
                    <StatusBadge status="Incomplete" />
                  )}
                </TableCell>
                <TableCell>
                  <code className="text-xs select-all">{backup.id}</code>
                  <p className="text-xs text-muted-foreground">
                    {backup.hash?.slice(0, 12) ?? "Not restorable"}
                  </p>
                </TableCell>
                <TableCell>{backup.rows ?? "—"}</TableCell>
                <TableCell>{backup.files ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    {write && source !== scope.env && backup.hash && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          approve(
                            "Restore backup",
                            `Restore ${backup.id} from ${source} into empty ${scope.env}. Existing data will never be overwritten. Origin/auth settings stay unchanged.`,
                            target + "/backup-restore",
                            { id: backup.id, sourceEnv: source },
                          )
                        }
                      >
                        Restore into {scope.env}
                      </Button>
                    )}
                    {write && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          approve(
                            "Delete backup",
                            `Permanently delete snapshot ${backup.id}. Live application data is not affected. Do not delete a backup needed by an unfinished restore.`,
                            path + "/backup-delete",
                            { id: backup.id },
                          )
                        }
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!r.data.page.length && (
              <TableRow>
                <TableCell colSpan={5}>No backups.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={!cursor}
          onClick={() => setCursor(null)}
        >
          First page
        </Button>
        <Button
          variant="outline"
          disabled={!r.data?.cursor}
          onClick={() => setCursor(r.data?.cursor ?? null)}
        >
          Next page
        </Button>
      </div>
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </div>
  );
}
