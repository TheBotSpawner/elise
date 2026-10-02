"use client";

import { Database, Loader2, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { Inspection, SourceView } from "@/application/structured-service";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { RecordValue } from "@/core/capabilities/structured";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { discoverAction, inspectAction, saveMappingAction } from "./actions";

type Row = { propertyId: string; key: string; label: string; include: boolean };
type Found = {
  dataSourceId: string;
  databaseId: string;
  name: string;
  fields: number;
  mappedAs: string | null;
};

export function formatValue(v: RecordValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ") || "—";
  if (typeof v === "boolean") return v ? "✓" : "—";
  if (typeof v === "object")
    return v.end
      ? `${v.start.slice(0, 10)} → ${v.end.slice(0, 10)}`
      : v.start.slice(0, 16).replace("T", " ");
  return String(v);
}

/**
 * Connect (or remap) a Notion database: choose it, review ELISE's interpretation of every
 * field, decide what ELISE may change, see real rows, then confirm. Nothing is active before.
 */
export function StructuredSetup({
  workspaces,
  edit,
}: {
  workspaces: { connectionId: string; name: string; status: string }[];
  edit?: SourceView | null;
}) {
  const { t } = useI18n();
  const s = t.structured;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const connected = workspaces.filter((w) => w.status === "connected");
  const [connectionId, setConnectionId] = useState(
    edit?.connectionId ?? connected[0]?.connectionId ?? "",
  );
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState(edit?.name ?? "");
  const [context, setContext] = useState(edit?.context ?? "");
  const [perms, setPerms] = useState(
    edit?.permissions ?? { read: true, create: true, update: true, archive: false },
  );
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (e: { message: string; code: string }) => setError(errorText(t, e));

  // Browse what this workspace shared with ELISE (debounced search).
  useEffect(() => {
    if (edit || !connectionId) return;
    let live = true;
    const timer = setTimeout(() => {
      void discoverAction(connectionId, query).then((r) => {
        if (!live) return;
        if (r.ok) setFound(r.value);
        else fail(r.error);
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fail is stable enough for this effect
  }, [connectionId, query, edit]);

  const inspect = (dataSourceId: string) =>
    startTransition(async () => {
      setError(null);
      const r = await inspectAction(connectionId, dataSourceId);
      if (!r.ok) return fail(r.error);
      const current = edit?.fields ?? null;
      setInspection(r.value);
      setRows(
        r.value.fields.map((f) => {
          const saved = current?.find((c) => c.propertyId === f.propertyId);
          return saved
            ? { propertyId: f.propertyId, key: saved.key, label: saved.label, include: true }
            : {
                propertyId: f.propertyId,
                key: f.key,
                label: f.label,
                include: !current || f.isTitle,
              };
        }),
      );
      if (!edit) setName(r.value.name);
    });

  useEffect(() => {
    if (edit) inspect(edit.dataSourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once in edit mode
  }, []);

  const property = (id: string) => inspection?.properties.find((p) => p.id === id);
  const shown =
    inspection?.fields
      .filter((f) => rows.find((r) => r.propertyId === f.propertyId)?.include)
      .slice(0, 4) ?? [];

  if (!connected.length) return <p className="text-[14px] text-muted">{s.needsNotion}</p>;

  return (
    <div className="flex flex-col gap-8">
      {!edit && !inspection && (
        <section className="flex flex-col gap-3">
          {connected.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notion-ws">{s.notionWorkspace}</Label>
              <Select
                id="notion-ws"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {connected.map((w) => (
                  <option key={w.connectionId} value={w.connectionId}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <Input
              aria-label={s.search}
              placeholder={s.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <p className="text-[12.5px] text-faint">{s.searchHint}</p>
          {found === null ? (
            <p className="flex items-center gap-2 text-[13.5px] text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {s.reading}
            </p>
          ) : found.length === 0 ? (
            <p className="text-[13.5px] text-muted">{s.nothingFound}</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
              {found.map((d) => (
                <li key={d.dataSourceId}>
                  <button
                    type="button"
                    disabled={pending || Boolean(d.mappedAs)}
                    onClick={() => inspect(d.dataSourceId)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-active disabled:opacity-60"
                  >
                    <Database className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{d.name}</span>
                      <span className="block text-[12.5px] text-faint">
                        {d.mappedAs ? s.mappedAs(d.mappedAs) : s.fieldsCount(d.fields)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {pending && !inspection && (
        <p className="flex items-center gap-2 text-[13.5px] text-muted" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {s.reading}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13.5px] text-danger-text">
          {error}
        </p>
      )}

      {inspection && (
        <>
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="type-label text-faint">{s.fields}</h2>
                <p className="text-[13px] text-muted">{s.fieldsHint}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAdvanced(!advanced)}
                aria-pressed={advanced}
              >
                {s.advanced}
              </Button>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border bg-surface">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-3 border-b border-border px-4 py-2 text-[12px] text-faint sm:grid">
                <span>{s.notionField}</span>
                <span>{s.interpretation}</span>
                <span>{s.use}</span>
              </div>
              <ul className="divide-y divide-border">
                {rows.map((r, i) => {
                  const p = property(r.propertyId);
                  const f = inspection.fields.find((x) => x.propertyId === r.propertyId);
                  if (!p || !f) return null;
                  const set = (patch: Partial<Row>) =>
                    setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <li
                      key={r.propertyId}
                      className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center sm:gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{p.name}</span>
                        <span className="flex items-center gap-1.5 text-[12px] text-faint">
                          {s.types[p.type]}
                          {!f.writable && (
                            <span
                              title={s.readOnlyHint}
                              className="rounded bg-surface-2 px-1.5 py-px"
                            >
                              {s.readOnly}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <Input
                            aria-label={`${s.interpretation}: ${p.name}`}
                            value={r.label}
                            maxLength={80}
                            disabled={!r.include}
                            onChange={(e) => set({ label: e.target.value })}
                            className="h-9"
                          />
                          {inspection.fromAI.includes(r.key) && (
                            <Sparkles
                              className="size-3.5 shrink-0 text-accent-text"
                              aria-label={s.suggested}
                            />
                          )}
                        </span>
                        {advanced && (
                          <Input
                            aria-label={`${s.fieldKey}: ${p.name}`}
                            value={r.key}
                            maxLength={40}
                            onChange={(e) => set({ key: e.target.value })}
                            className="h-8 font-mono text-[12.5px]"
                          />
                        )}
                      </span>
                      <Switch
                        checked={r.include || p.isTitle}
                        disabled={p.isTitle}
                        aria-label={`${s.use}: ${p.name}`}
                        onCheckedChange={(v) => set({ include: v })}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-name">{s.name}</Label>
              <Input
                id="src-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="src-context">{s.context}</Label>
              <Input
                id="src-context"
                value={context}
                maxLength={200}
                placeholder={s.contextPlaceholder}
                aria-describedby="src-context-hint"
                onChange={(e) => setContext(e.target.value)}
              />
              <p id="src-context-hint" className="text-[12.5px] text-faint">
                {s.contextHint}
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="type-label text-faint">{s.access}</h2>
            <p className="text-[13.5px]">✓ {s.read}</p>
            {(["create", "update", "archive"] as const).map((k) => (
              <label key={k} className="flex items-center gap-3 text-[13.5px]">
                <Switch
                  checked={perms[k]}
                  onCheckedChange={(v) => setPerms({ ...perms, [k]: v })}
                  aria-label={
                    s[
                      k === "create"
                        ? "allowCreate"
                        : k === "update"
                          ? "allowUpdate"
                          : "allowArchive"
                    ]
                  }
                />
                {
                  s[
                    k === "create" ? "allowCreate" : k === "update" ? "allowUpdate" : "allowArchive"
                  ]
                }
              </label>
            ))}
            <p className="text-[12.5px] text-faint">{s.accessHint}</p>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="type-label text-faint">{s.preview}</h2>
            {inspection.sample.length === 0 ? (
              <p className="text-[13.5px] text-muted">{s.previewEmpty}</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-max text-left text-[13px]">
                  <thead className="bg-surface-2 text-muted">
                    <tr>
                      {shown.map((f) => (
                        <th key={f.propertyId} className="px-3 py-2 font-medium">
                          {rows.find((r) => r.propertyId === f.propertyId)?.label ?? f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {inspection.sample.map((rec, i) => (
                      <tr key={i} className="border-t border-border">
                        {shown.map((f) => (
                          <td key={f.propertyId} className="max-w-56 truncate px-3 py-1.5">
                            {formatValue(rec.values[f.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => router.back()} disabled={pending}>
              {t.finance.cancel}
            </Button>
            <Button
              disabled={pending || !name.trim()}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const r = await saveMappingAction(
                    {
                      connectionId,
                      dataSourceId: inspection.dataSourceId,
                      name,
                      context: context || null,
                      fields: rows.map((x) => ({
                        ...x,
                        include: x.include || Boolean(property(x.propertyId)?.isTitle),
                      })),
                      permissions: {
                        create: perms.create,
                        update: perms.update,
                        archive: perms.archive,
                      },
                    },
                    edit?.id,
                  );
                  if (!r.ok) return fail(r.error);
                  toast.success(s.saved);
                  router.push(`/connections/sources/${r.value}`);
                })
              }
              className={cn(pending && "opacity-70")}
            >
              {edit ? s.saveChanges : s.save}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
