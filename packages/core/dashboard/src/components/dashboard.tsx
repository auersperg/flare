import { lazy, Suspense, useEffect, useState } from "react";
import {
  Shield,
  Activity,
  Database,
  Box,
  Code,
  File,
  Timer,
  Logs,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";
import { Field, FieldLabel, FieldGroup } from "./ui/field";
import { Choice, ErrorNotice, Status, FormDialog, type Modal } from "./common";
import {
  api,
  message,
  type Session,
  type Project,
  type Environment,
} from "../lib/model";
import { HealthView, SchemaView, LogsView } from "./overview";
const FilesView = lazy(() =>
  import("./services-view").then((m) => ({ default: m.FilesView })),
);
const SchedulesView = lazy(() =>
  import("./services-view").then((m) => ({ default: m.SchedulesView })),
);
const DataView = lazy(() => import("./data-view"));
const FunctionsView = lazy(() => import("./functions-view"));
const AuthView = lazy(() => import("./auth-view"));
const SettingsView = lazy(() => import("./settings-view"));
const SdkView = lazy(() => import("./sdk-view"));
export const sections = [
  { key: "health", label: "Health", icon: Activity },
  { key: "data", label: "Data", icon: Database },
  { key: "schema", label: "Schema", icon: Box },
  { key: "functions", label: "Functions", icon: Code },
  { key: "files", label: "Files", icon: File },
  { key: "schedules", label: "Schedules", icon: Timer },
  { key: "auth", label: "Auth", icon: Shield },
  { key: "logs", label: "Logs", icon: Logs },
] as const;
export type View = (typeof sections)[number]["key"] | "settings" | "sdk";
export type Scope = { project: Project; env: Environment; session: Session };
const CliApproval = lazy(() => import("./cli-approval"));
export default function Dashboard() {
  return new URLSearchParams(location.search).has("cli") ? (
    <Suspense fallback={<p>Loading…</p>}>
      <CliApproval />
    </Suspense>
  ) : (
    <DashboardApp />
  );
}
function DashboardApp() {
  const [session, setSession] = useState<Session>(),
    [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project>(),
    [env, setEnv] = useState<Environment>("dev"),
    [view, setView] = useState<View>("health"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [modal, setModal] = useState<Modal>(),
    [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setCollapsed(localStorage.getItem("flare.sidebar") === "collapsed");
    void Promise.all([
      api<Session>("session", undefined, abort.signal),
      api<Project[]>("projects", undefined, abort.signal),
    ])
      .then(([s, p]) => {
        if (abort.signal.aborted) return;
        setSession(s);
        setProjects(p);
        setProject(
          p.find((x) => x.id === localStorage.getItem("flare.project")) ?? p[0],
        );
        setLoading(false);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(message(e));
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, []);
  const selectProject = (id: string) => {
    const p = projects.find((p) => p.id === id);
    if (!p) return;
    setProject(p);
    setEnv("dev");
    setView("health");
    setModal(undefined);
    localStorage.setItem("flare.project", id);
  };
  const newProject = () =>
    setModal({
      title: "Create project",
      description: "Creates separate development and production environments.",
      content: (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="project-name">Project name</FieldLabel>
            <Input
              id="project-name"
              name="name"
              required
              maxLength={100}
              placeholder="CRM"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-alias">
              Short URL name (optional)
            </FieldLabel>
            <Input
              id="project-alias"
              name="alias"
              maxLength={48}
              pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
              placeholder="crm"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-origins">
              Allowed frontend origins · one per line
            </FieldLabel>
            <Textarea
              id="project-origins"
              name="origins"
              placeholder="http://127.0.0.1:5173"
            />
          </Field>
        </FieldGroup>
      ),
      submit: async (form) => {
        const f = new FormData(form);
        const created = await api<Project>("projects", {
          name: f.get("name"),
          alias: f.get("alias") || undefined,
          origins: [
            location.origin,
            ...String(f.get("origins"))
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          ],
        });
        const p = await api<Project[]>("projects");
        setProjects(p);
        setProject(p.find((p) => p.id === created.id) ?? p[0]);
        setEnv("dev");
        setView("health");
      },
    });
  const scope = project && session ? { project, env, session } : null;
  const projectDeleted = () => {
    const remaining = projects.filter((p) => p.id !== project?.id);
    setProjects(remaining);
    setProject(remaining[0]);
    setEnv("dev");
    setView("health");
    if (remaining[0]) localStorage.setItem("flare.project", remaining[0].id);
    else localStorage.removeItem("flare.project");
  };
  const navigate = (next: View) => {
    setModal(undefined);
    setView(next);
  };
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden text-sm">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-sidebar px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Choice
            label="Select project"
            value={project?.id ?? ""}
            onChange={selectProject}
            items={projects.map((p) => ({ value: p.id, label: p.name }))}
            className="max-w-48"
          />
          {scope && (
            <Tabs
              value={env}
              onValueChange={(v) => {
                if (v !== "dev" && v !== "prod") return;
                setEnv(v);
                setModal(undefined);
              }}
              aria-label="Select environment"
            >
              <TabsList>
                <TabsTrigger value="dev">Dev</TabsTrigger>
                <TabsTrigger value="prod">Production</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session?.role !== "viewer" && session && (
            <Button
              aria-label="Create project"
              size="icon-sm"
              variant="ghost"
              onClick={newProject}
            >
              <Plus />
            </Button>
          )}
          {scope && (
            <Button
              aria-label="Project settings"
              size="icon-sm"
              variant="ghost"
              onClick={() => navigate("settings")}
            >
              <Settings />
            </Button>
          )}
          {session && (
            <span
              className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-medium"
              title={session.email}
              aria-label={`Signed in as ${session.email}`}
            >
              {session.email.slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className={`flex shrink-0 flex-col border-r bg-sidebar px-2 py-3 ${collapsed ? "w-12" : "w-36"}`}
        >
          <nav aria-label="Deployment" className="flex flex-col gap-1">
            {sections.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                variant="ghost"
                disabled={!scope}
                aria-current={view === key ? "page" : undefined}
                title={collapsed ? label : undefined}
                aria-label={collapsed ? label : undefined}
                className={`w-full justify-start ${view === key ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`}
                onClick={() => navigate(key)}
              >
                <Icon className="size-4" />
                {!collapsed && label}
              </Button>
            ))}
          </nav>
          <Button
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="mt-auto justify-start text-muted-foreground"
            variant="ghost"
            onClick={() =>
              setCollapsed((v) => {
                localStorage.setItem(
                  "flare.sidebar",
                  v ? "expanded" : "collapsed",
                );
                return !v;
              })
            }
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed && "Collapse"}
          </Button>
        </aside>
        <main
          className={`min-h-0 min-w-0 flex-1 ${view === "data" ? "overflow-hidden" : "overflow-auto"}`}
          aria-label="Deployment content"
        >
          {error && (
            <div className="p-4">
              <ErrorNotice>{error}</ErrorNotice>
            </div>
          )}
          {loading ? (
            <Status loading />
          ) : scope ? (
            <Suspense fallback={<Status loading />}>
              <div
                key={`${project!.id}/${env}/${view}`}
                className={view === "data" ? "h-full min-h-0" : "min-h-full"}
              >
                {view === "health" ? (
                  <HealthView {...scope} connect={() => navigate("sdk")} />
                ) : view === "data" ? (
                  <DataView {...scope} />
                ) : view === "schema" ? (
                  <SchemaView {...scope} />
                ) : view === "functions" ? (
                  <FunctionsView {...scope} />
                ) : view === "files" ? (
                  <FilesView {...scope} />
                ) : view === "schedules" ? (
                  <SchedulesView {...scope} />
                ) : view === "auth" ? (
                  <AuthView {...scope} />
                ) : view === "logs" ? (
                  <LogsView {...scope} />
                ) : view === "settings" ? (
                  <SettingsView {...scope} onDeleted={projectDeleted} />
                ) : (
                  <SdkView {...scope} />
                )}
              </div>
            </Suspense>
          ) : !error ? (
            <div className="p-4">
              <h1 className="page-title">Select a project</h1>
              <p className="mt-2 text-muted-foreground">
                Create a project to get started.
              </p>
              {session?.role !== "viewer" && (
                <Button className="mt-4" onClick={newProject}>
                  <Plus />
                  New project
                </Button>
              )}
            </div>
          ) : null}
        </main>
      </div>
      {modal && (
        <FormDialog modal={modal} onClose={() => setModal(undefined)} />
      )}
    </div>
  );
}
