import { useEffect, useState } from "react";
import { api, message, type Project } from "../lib/model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldGroup } from "./ui/field";
import { Choice, ErrorNotice } from "./common";
export default function CliApproval() {
  const id = new URLSearchParams(location.search).get("cli") ?? "";
  const [code, setCode] = useState(""),
    [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState("new"),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      api<{ code: string }>(
        "cli/approval?id=" + encodeURIComponent(id),
        undefined,
        abort.signal,
      ),
      api<Project[]>("projects", undefined, abort.signal),
    ])
      .then(([login, rows]) => {
        setCode(login.code);
        setProjects(rows);
        setProject("new");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(message(e));
      });
    return () => abort.abort();
  }, [id]);
  async function approve() {
    setBusy(true);
    setError("");
    try {
      let selected = project;
      if (selected === "new") {
        const created = await api<{ id: string }>("projects", {
          name,
          customer: "Applications",
          origins: [],
        });
        selected = created.id;
        // Keep selection after creation if approval fails; don't create another project on retry.
        setProjects((rows) => [
          ...rows,
          { id: created.id, name, customer: "Applications" },
        ]);
        setProject(selected);
      }
      await api("cli/approval", { id, project: selected });
      setDone(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="mb-4 text-xl font-semibold">Connect Flared CLI</h1>
      {done ? (
        <p>Connected. Return to your terminal. You can close this tab.</p>
      ) : (
        <FieldGroup>
          <p>
            Approve only a login you just started. Compare this code with your
            terminal:
          </p>
          <strong className="text-2xl font-mono">{code || "Loading…"}</strong>
          <p>
            Grants this computer deployment access to the selected project,
            including production. The credential expires in 30 days and can be
            revoked in Settings.
          </p>
          <Field>
            <FieldLabel>Project</FieldLabel>
            <Choice
              label="CLI project"
              value={project}
              onChange={setProject}
              items={[
                ...projects.map((p) => ({ value: p.id, label: p.name })),
                { value: "new", label: "Create new project" },
              ]}
            />
          </Field>
          {project === "new" && (
            <Field>
              <FieldLabel>New project name</FieldLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </Field>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <Button
            disabled={
              busy || !code || !project || (project === "new" && !name.trim())
            }
            onClick={approve}
          >
            Approve connection
          </Button>
        </FieldGroup>
      )}
    </main>
  );
}
