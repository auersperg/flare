import { useState } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import { useResource, Status, FormDialog, type Modal, Empty } from "./common";
import { api, scopePath } from "../lib/model";
import { values } from "../lib/presentation";
import type { Scope } from "./dashboard";
type User = { id: string; login: string; disabled: boolean; createdAt: number };
type Config = { enabled: boolean; registration: boolean };
export default function AuthView(scope: Scope) {
  const path = scopePath(scope.project, scope.env);
  const [cursor, setCursor] = useState(""),
    [modal, setModal] = useState<Modal>();
  const users = useResource<{ users: User[]; next: string | null }>(
    path +
      "/auth-users" +
      (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
  );
  const config = useResource<Config>(path + "/auth-settings");
  const owner = scope.session.role === "owner";
  const change = (
    op: string,
    title: string,
    input: Record<string, unknown>,
    fields: NonNullable<Modal["fields"]> = [],
  ) => {
    setModal({
      title,
      description:
        "Passwords and hashes cannot be read. Password changes, blocking and session revocation disconnect affected live clients. Public registration creates users, never administrators.",
      productionId: scope.env === "prod" ? scope.project.id : undefined,
      fields,
      submit: async (form) => {
        await api(path + "/" + op, {
          ...input,
          ...values(fields, (key) => new FormData(form).get(key)),
          confirm: scope.project.id,
        });
        users.refresh();
        config.refresh();
      },
    });
  };
  const password = {
    name: "password",
    type: "password",
    required: true,
    description: "15–128 characters. No recovery by email is configured.",
  };
  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Auth</h1>
      <p className="text-muted-foreground">
        Login/password authentication. Users and sessions are isolated in this{" "}
        {scope.env} environment; promotion never copies them. Credentials are
        platform-private.
      </p>
      <Status
        loading={users.loading || config.loading}
        error={users.error || config.error}
      />
      {config.data && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {config.data.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Badge variant="outline">
            {config.data.registration
              ? "Public registration"
              : "Registration closed"}
          </Badge>
          {owner && (
            <Button
              variant="outline"
              onClick={() =>
                change("auth-configure", "Configure authentication", {}, [
                  {
                    name: "enabled",
                    type: "boolean",
                    value: config.data!.enabled,
                  },
                  {
                    name: "registration",
                    type: "boolean",
                    value: config.data!.registration,
                  },
                ])
              }
            >
              Configure
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              users.refresh();
              config.refresh();
            }}
          >
            Refresh
          </Button>
          {owner && (
            <Button
              onClick={() =>
                change("auth-create", "Create user", {}, [
                  { name: "login", type: "string", required: true },
                  password,
                ])
              }
            >
              Create user
            </Button>
          )}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        A session lasts up to 12 hours. Enabling public registration permits
        anyone to create an account, not access everyone else's data: functions
        must check ownership and roles.
      </p>
      {users.data && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Login</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{user.login}</TableCell>
                  <TableCell>
                    <code>{user.id}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {user.disabled ? "Blocked" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(user.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {owner && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              change(
                                "auth-password",
                                "Change user password",
                                { id: user.id },
                                [password],
                              )
                            }
                          >
                            Change password
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              change("auth-revoke", "Revoke all sessions", {
                                id: user.id,
                              })
                            }
                          >
                            Revoke sessions
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              change(
                                "auth-disable",
                                user.disabled ? "Unblock user" : "Block user",
                                { id: user.id, disabled: !user.disabled },
                              )
                            }
                          >
                            {user.disabled ? "Unblock" : "Block"}
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!users.data.users.length && <Empty title="No users" />}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!cursor}
              onClick={() => setCursor("")}
            >
              First page
            </Button>
            <Button
              variant="outline"
              disabled={!users.data.next}
              onClick={() => setCursor(users.data!.next!)}
            >
              Next page
            </Button>
          </div>
        </>
      )}
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </div>
  );
}
