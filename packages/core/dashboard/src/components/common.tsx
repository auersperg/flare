import {
  useEffect,
  useId,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "./ui/table";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Empty as EmptyRoot,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "./ui/empty";
import {
  Field as FormField,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "./ui/field";
import { api, message, scalar, type Row } from "../lib/model";
import { values, type Field } from "../lib/presentation";

export function useResource<T>(path: string) {
  const [state, setState] = useState<{
    path: string;
    data?: T;
    error?: string;
    loading: boolean;
  }>({ path, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ path, loading: true });
    void api<T>(path, undefined, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setState({ path, data, loading: false });
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setState({ path, error: message(e), loading: false });
      });
    return () => abort.abort();
  }, [path, version]);
  const visible = state.path === path ? state : { path, loading: true };
  return { ...visible, refresh: () => setVersion((v) => v + 1) };
}
export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
export function Status({
  loading,
  error,
}: {
  loading: boolean;
  error?: string;
}) {
  return error ? (
    <ErrorNotice>{error}</ErrorNotice>
  ) : loading ? (
    <p role="status" className="p-4 text-xs text-muted-foreground">
      Loading…
    </p>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <EmptyRoot>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
    </EmptyRoot>
  );
}
export function Choice({
  value,
  onChange,
  items,
  label,
  className,
  name,
  disabled,
  id,
}: {
  name?: string;
  disabled?: boolean;
  id?: string;
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <Select
      name={name}
      disabled={disabled}
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      items={items}
    >
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function Grid({
  rows,
  columns,
  labels = {},
  renderCell,
}: {
  rows: Row[];
  columns: string[];
  labels?: Record<string, string>;
  renderCell?: (column: string, value: unknown) => ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead key={c}>{labels[c] ?? c}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, i) => (
          <TableRow key={i}>
            {columns.map((c) => (
              <TableCell key={c} className="max-w-sm truncate">
                {renderCell
                  ? renderCell(c, row[c])
                  : ["at", "dueAt"].includes(c) && typeof row[c] === "number"
                    ? new Date(row[c]).toLocaleString()
                    : scalar(row[c])}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function Value({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  if (depth > 4)
    return <span className="text-muted-foreground">Nested value</span>;
  if (Array.isArray(value)) {
    const items = value.slice(0, 100);
    if (
      items.length &&
      items.every((v) => v && typeof v === "object" && !Array.isArray(v))
    )
      return (
        <Grid
          rows={items}
          columns={[...new Set(items.flatMap((v) => Object.keys(v)))].slice(
            0,
            40,
          )}
        />
      );
    return value.length ? (
      <ol className="list-inside list-decimal space-y-2">
        {items.map((v, i) => (
          <li key={i}>
            <Value value={v} depth={depth + 1} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="text-muted-foreground">Empty list</span>
    );
  }
  if (value && typeof value === "object")
    return (
      <dl className="grid grid-cols-[minmax(80px,auto)_1fr] gap-4">
        {Object.entries(value)
          .slice(0, 40)
          .map(([key, v]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 overflow-auto">
                <Value value={v} depth={depth + 1} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return <span className="break-all">{scalar(value)}</span>;
}
export function Fields({ items }: { items: Field[] }) {
  return (
    <FieldGroup>
      {!items.length && (
        <p className="text-muted-foreground">No arguments required.</p>
      )}
      {items.map((f, i) => (
        <FieldInput key={f.name} field={f} index={i} />
      ))}
    </FieldGroup>
  );
}
function FieldInput({ field: f, index: i }: { field: Field; index: number }) {
  const initial =
    f.value === null && f.nullable
      ? "null"
      : f.value === undefined && (!f.required || f.defaultMode)
        ? "omit"
        : "value";
  const [mode, setMode] = useState(initial),
    [selection, setSelection] = useState(
      f.choices
        ? String(Math.max(0, f.choices.indexOf(f.value)))
        : String(f.value === true),
    );
  const id = useId();
  return (
    <FormField>
      <FieldLabel htmlFor={id}>
        <span>
          {f.name}
          {f.required ? " *" : ""}
        </span>
        <span className="font-normal text-muted-foreground">{f.type}</span>
      </FieldLabel>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {f.choices || f.type === "boolean" ? (
            <Choice
              id={id}
              name={`v${i}`}
              label={f.name}
              className="w-full"
              disabled={mode !== "value"}
              value={selection}
              onChange={setSelection}
              items={
                f.choices
                  ? f.choices.map((v, n) => ({
                      value: String(n),
                      label: String(v),
                    }))
                  : [
                      { value: "false", label: "false" },
                      { value: "true", label: "true" },
                    ]
              }
            />
          ) : ["object", "array", "json"].includes(f.type) ? (
            <Textarea
              id={id}
              name={`v${i}`}
              disabled={mode !== "value"}
              defaultValue={
                f.value === undefined ? "" : JSON.stringify(f.value, null, 2)
              }
              placeholder={
                f.type === "json"
                  ? "JSON value"
                  : f.type === "array"
                    ? "[]"
                    : "{}"
              }
            />
          ) : (
            <Input
              id={id}
              name={`v${i}`}
              type={["number", "integer"].includes(f.type) ? "number" : "text"}
              step={f.type === "integer" ? 1 : "any"}
              min={f.minimum}
              max={f.maximum}
              disabled={mode !== "value"}
              defaultValue={
                f.value === null || f.value === undefined ? "" : String(f.value)
              }
            />
          )}
        </div>
        <Choice
          name={`m${i}`}
          className="w-32 shrink-0"
          label={`Value mode for ${f.name}`}
          value={mode}
          onChange={setMode}
          items={[
            { value: "value", label: "Value" },
            ...(!f.required || f.defaultMode
              ? [{ value: "omit", label: f.defaultMode ? "Default" : "Omit" }]
              : []),
            ...(f.nullable ? [{ value: "null", label: "NULL" }] : []),
          ]}
        />
      </div>
      {f.description && <FieldDescription>{f.description}</FieldDescription>}
    </FormField>
  );
}
export function readFields(form: HTMLFormElement, items: Field[]) {
  const data = new FormData(form);
  return values(items, (key) => data.get(key));
}
export type Modal = {
  title: string;
  description: string;
  fields?: Field[];
  content?: ReactNode;
  productionId?: string;
  submit: (form: HTMLFormElement) => Promise<void>;
};
export function FormDialog({
  modal,
  onClose,
}: {
  modal: Modal;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-auto"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{modal.title}</DialogTitle>
          <DialogDescription>{modal.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e: SubmitEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              const form = e.currentTarget;
              if (
                modal.productionId &&
                new FormData(form).get("confirm") !== modal.productionId
              )
                throw Error("Project ID does not match");
              await modal.submit(form);
              onClose();
            } catch (e) {
              setError(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {modal.fields && <Fields items={modal.fields} />} {modal.content}
          {modal.productionId && (
            <FormField>
              <FieldLabel htmlFor="production-confirm">
                Production change: type project ID
              </FieldLabel>
              <code className="block select-all">{modal.productionId}</code>
              <Input
                id="production-confirm"
                name="confirm"
                required
                autoComplete="off"
              />
            </FormField>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
