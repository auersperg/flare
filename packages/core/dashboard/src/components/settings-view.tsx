import BackupsPanel from "./backups-panel";
import { useState, type SubmitEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Field, FieldLabel, FieldGroup } from "./ui/field";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import {
  useResource,
  Status,
  ErrorNotice,
  FormDialog,
  type Modal,
} from "./common";
import { api, message, scopePath, type Settings } from "../lib/model";
import type { Scope } from "./dashboard";
export default function SettingsView({
  onDeleted,
  ...scope
}: Scope & { onDeleted: () => void }) {
  const path = scopePath(scope.project, scope.env),
    r = useResource<Settings>(path + "/settings");
  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">Settings</h1>
      <p className="text-xs text-muted-foreground">
        Environment identity and frontend permissions.
      </p>
      <Status {...r} />
      {r.data && (
        <>
          <SettingsForm {...scope} settings={r.data} refresh={r.refresh} />
          <BackupsPanel {...scope} />
        </>
      )}
      {scope.session.role === "owner" && (
        <DeleteProject {...scope} onDeleted={onDeleted} />
      )}
    </div>
  );
}
function DeleteProject({
  project,
  onDeleted,
}: Scope & { onDeleted: () => void }) {
  const [modal, setModal] = useState<Modal>();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Delete project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground">
            Permanently delete both development and production: data, users,
            files, releases, backups and schedules. This cannot be undone.
          </p>
          {project.deleting ? (
            <p role="alert">Deletion was started. Retry to finish cleanup.</p>
          ) : null}
          <Button
            variant="destructive"
            onClick={() =>
              setModal({
                title: "Delete project",
                description: `Delete ${project.name} and both environments permanently? The short URL stays reserved; other projects are not affected.`,
                destructive: true,
                submitLabel: "Delete project",
                content: (
                  <Field>
                    <FieldLabel htmlFor="delete-project-name">
                      Type the project name: {project.name}
                    </FieldLabel>
                    <Input
                      id="delete-project-name"
                      name="name"
                      required
                      autoComplete="off"
                      maxLength={100}
                    />
                  </Field>
                ),
                submit: async (form) => {
                  const name = new FormData(form).get("name");
                  if (name !== project.name)
                    throw Error("Project name does not match");
                  try {
                    await api(`projects/${project.id}/delete`, {
                      name,
                      confirm: project.id,
                    });
                  } catch (error) {
                    // A lost response may follow successful deletion. Verify the
                    // catalog before treating NOT_FOUND as an already-finished delete.
                    if (
                      message(error) !== "NOT_FOUND" ||
                      (await api<{ id: string }[]>("projects")).some(
                        (p) => p.id === project.id,
                      )
                    )
                      throw error;
                  }
                  onDeleted();
                },
              })
            }
          >
            Delete project
          </Button>
        </CardContent>
      </Card>
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </>
  );
}
function SettingsForm({
  project,
  env,
  session,
  settings,
  refresh,
}: Scope & { settings: Settings; refresh: () => void }) {
  const path = scopePath(project, env),
    write = session.role !== "viewer";
  const [modal, setModal] = useState<Modal>(),
    [credential, setCredential] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const approve = (
    title: string,
    description: string,
    work: (confirm?: string) => Promise<void>,
  ) =>
    setModal({
      title,
      description,
      productionId: env === "prod" ? project.id : undefined,
      submit: async (form) =>
        work(
          env === "prod"
            ? String(new FormData(form).get("confirm"))
            : undefined,
        ),
    });
  const save = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!write) return;
    const f = new FormData(e.currentTarget),
      body = {
        origins: String(f.get("origins"))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        oidc: ["issuer", "audience", "jwks"].some((k) =>
          String(f.get(k)).trim(),
        )
          ? Object.fromEntries(
              ["issuer", "audience", "jwks"].map((k) => [
                k,
                String(f.get(k)).trim(),
              ]),
            )
          : null,
      };
    approve(
      "Save environment",
      "Updates frontend origins and user token verification. Existing applications continue to use this environment.",
      async (confirm) => {
        await api(path + "/settings", { ...body, confirm });
        refresh();
      },
    );
  };
  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Card>
        <CardHeader>
          <CardTitle>Cloud URL</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <code className="block select-all break-all">{settings.url}</code>
          <p className="text-muted-foreground">
            Permanent project name. Existing UUID URLs remain valid.
          </p>
          {!settings.alias && session.role === "owner" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const alias = new FormData(e.currentTarget).get("alias");
                void perform(async () => {
                  await api(`projects/${project.id}/alias`, { alias });
                  refresh();
                });
              }}
            >
              <Input
                name="alias"
                aria-label="Short URL name"
                required
                maxLength={48}
                pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
                placeholder="crm"
              />
              <Button type="submit" disabled={busy}>
                Set short URL
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Environment access</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="max-w-xl" onSubmit={save}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-origins">
                  Frontend origins · one per line
                </FieldLabel>
                <Textarea
                  id="settings-origins"
                  name="origins"
                  defaultValue={settings.origins.join("\n")}
                  disabled={!write}
                />
              </Field>
              <h3 className="text-sm font-medium">
                Authentication · OIDC / RS256
              </h3>
              <Field>
                <FieldLabel htmlFor="settings-issuer">Issuer</FieldLabel>
                <Input
                  id="settings-issuer"
                  type="url"
                  name="issuer"
                  defaultValue={settings.oidc?.issuer ?? ""}
                  disabled={!write}
                  placeholder="https://your-provider.example"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-audience">Audience</FieldLabel>
                <Input
                  id="settings-audience"
                  name="audience"
                  defaultValue={settings.oidc?.audience ?? ""}
                  disabled={!write}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="settings-jwks">JWKS URL</FieldLabel>
                <Input
                  id="settings-jwks"
                  type="url"
                  name="jwks"
                  defaultValue={settings.oidc?.jwks ?? ""}
                  disabled={!write}
                  placeholder="https://your-provider.example/.well-known/jwks.json"
                />
              </Field>
              <p className="text-muted-foreground">
                Leave all three empty to disable OIDC. Protected production
                functions remain closed.
              </p>
              {write && <Button type="submit">Save environment</Button>}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>CLI access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p>
            Project-scoped deploy credential, valid for 30 days. Never put it in
            frontend code. Keep it in your shell or CI secret store.
          </p>
          {session.role === "owner" && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  approve(
                    "Issue CLI credential",
                    "The token is shown once. It grants deployment rights only for this project.",
                    async (confirm) => {
                      const x = await api<{ token: string; platform: string }>(
                        path + "/credential",
                        { confirm },
                      );
                      setCredential(
                        `export FLARE_DEPLOY_TOKEN=${x.token}\nflare link --platform ${x.platform} --project ${project.id}\nflare deploy --env dev --release ./release`,
                      );
                    },
                  )
                }
              >
                Issue credential
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  approve(
                    "Revoke project credentials",
                    "All existing CLI credentials for this project will stop working.",
                    async (confirm) => {
                      await api(path + "/revoke-credentials", { confirm });
                      setCredential("Credentials revoked.");
                    },
                  )
                }
              >
                Revoke credentials
              </Button>
            </div>
          )}
          {credential && (
            <>
              <pre className="code-block">{credential}</pre>
              <Button variant="ghost" onClick={() => setCredential("")}>
                Clear from view
              </Button>
            </>
          )}
        </CardContent>
      </Card>
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </>
  );
}
