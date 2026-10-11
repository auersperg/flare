import { useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { useResource, Status, FormDialog, type Modal } from "./common";
import { api, scopePath, type Environment } from "../lib/model";
import { FunctionBadge } from "./function-badge";
import type { Scope } from "./dashboard";
type Release = { hash: string; at: number };
export default function ReleasesPanel(scope: Scope & { refresh: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Releases</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground">
          Five recent immutable backend builds. Switching code never restores
          database contents.
        </p>
        <Button variant="outline" onClick={() => setOpen(!open)}>
          {open ? "Close releases" : "Manage releases"}
        </Button>
        {open && <ReleaseList {...scope} />}
      </CardContent>
    </Card>
  );
}
function ReleaseList(scope: Scope & { refresh: () => void }) {
  const [source, setSource] = useState<Environment>(scope.env),
    [selected, setSelected] = useState<string>(),
    [modal, setModal] = useState<Modal>();
  const path = scopePath(scope.project, source),
    target = scopePath(scope.project, scope.env);
  const history = useResource<Release[]>(path + "/history"),
    health = useResource<{ active: string }>(path + "/health");
  const writable = scope.session.role !== "viewer";
  const approve = async (hash: string, promote: boolean) => {
    const destination = promote ? scopePath(scope.project, "prod") : target;
    const current = await api<{ active: string }>(destination + "/health");
    setModal({
      title: promote ? "Promote backend to production" : "Rollback backend",
      description:
        "Activate this exact backend hash after native schema/job validation. Data, files and settings stay unchanged. Frontend is not published by this button; use the CLI release flow for that.",
      productionId: scope.project.id,
      submit: async () => {
        await api(
          destination + (promote ? "/release-promote" : "/release-rollback"),
          { hash, expected: current.active, confirm: scope.project.id },
        );
        history.refresh();
        health.refresh();
        scope.refresh();
      },
    });
  };
  const [error, setError] = useState<string>();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(["dev", "prod"] as const).map((env) => (
          <Button
            key={env}
            variant={env === source ? "secondary" : "outline"}
            onClick={() => {
              setSource(env);
              setSelected(undefined);
            }}
          >
            {env === "dev" ? "Development" : "Production"}
          </Button>
        ))}
        <Button
          variant="outline"
          onClick={() => {
            history.refresh();
            health.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      <Status
        loading={history.loading || health.loading}
        error={error || history.error || health.error}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>First published</TableHead>
            <TableHead>Backend hash</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.data?.map((release) => (
            <TableRow key={release.hash}>
              <TableCell>{new Date(release.at).toLocaleString()}</TableCell>
              <TableCell>
                <code className="text-xs">{release.hash.slice(0, 12)}</code>
                {health.data?.active === release.hash && (
                  <Badge variant="secondary">Active</Badge>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(release.hash)}
                  >
                    View contracts
                  </Button>
                  {writable &&
                    source === scope.env &&
                    health.data?.active !== release.hash && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void approve(release.hash, false).catch((e) =>
                            setError(e.message),
                          )
                        }
                      >
                        Rollback backend
                      </Button>
                    )}
                  {writable && source === "dev" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void approve(release.hash, true).catch((e) =>
                          setError(e.message),
                        )
                      }
                    >
                      Promote backend
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        These are backend builds, not Git commits or saved frontend previews.
        Old code must accept current documents; incompatible switches fail.
        Builds required by active deployments or jobs are retained beyond these
        five.
      </p>
      {selected && (
        <ReleaseDetails
          path={path}
          hash={selected}
          close={() => setSelected(undefined)}
        />
      )}
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </div>
  );
}
function ReleaseDetails({
  path,
  hash,
  close,
}: {
  path: string;
  hash: string;
  close: () => void;
}) {
  const r = useResource<{
    schema: Record<
      string,
      {
        document: { properties?: Record<string, unknown> };
        indexes: Record<string, unknown>;
      }
    >;
    manifest: {
      functions: Record<
        string,
        { kind: "query" | "mutation" | "action"; auth: string }
      >;
    };
  }>(path + "/release?hash=" + hash);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Backend release</DialogTitle>
          <DialogDescription className="break-all">{hash}</DialogDescription>
        </DialogHeader>
        <Status {...r} />
        {r.data && (
          <>
            <h3 className="font-medium">Tables</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(r.data.schema).map(([name, table]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell>
                      {Object.keys(table.document.properties ?? {}).join(
                        ", ",
                      ) || "No declared fields"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <h3 className="font-medium">Functions</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Function</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(r.data.manifest.functions).map(([name, fn]) => (
                  <TableRow key={name}>
                    <TableCell>{name}</TableCell>
                    <TableCell>
                      <FunctionBadge kind={fn.kind} />
                    </TableCell>
                    <TableCell>{fn.auth}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
