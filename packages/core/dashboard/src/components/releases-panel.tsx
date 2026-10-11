import { useState } from "react";
import { Button } from "./ui/button";
import { StatusBadge } from "./status-badge";
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
import { api, scopePath } from "../lib/model";
import { FunctionBadge } from "./function-badge";
import type { Scope } from "./dashboard";
type Release = { hash: string; at: number };
export default function ReleasesPanel(scope: Scope & { refresh: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {scope.env === "dev" ? "Development releases" : "Production releases"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ReleaseList {...scope} />
      </CardContent>
    </Card>
  );
}

function ReleaseList(scope: Scope & { refresh: () => void }) {
  const [selected, setSelected] = useState<string>(),
    [modal, setModal] = useState<Modal>();
  const path = scopePath(scope.project, scope.env),
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
      productionId:
        promote || scope.env === "prod" ? scope.project.id : undefined,
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
                  <StatusBadge status="Active" />
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
                  {writable && health.data?.active !== release.hash && (
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
                  {writable && scope.env === "dev" && (
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
                    <TableCell>
                      <StatusBadge status={fn.auth} />
                    </TableCell>
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
