"use client";

import { ExternalLink, Pencil, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { SourceView } from "@/application/structured-service";
import { NotionIcon } from "@/components/elise/brand-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { RecordValue } from "@/core/capabilities/structured";
import { useRelative } from "@/features/knowledge/ui";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { refreshSchemaAction, testSourceAction, unmapAction, updateSourceAction } from "./actions";
import { formatValue } from "./setup";

const DOT = {
  active: "bg-success",
  needs_attention: "bg-approval",
  paused: "bg-faint",
  archived: "bg-faint",
} as const;

export function SourceDetail({ source, workspaceId }: { source: SourceView; workspaceId: string }) {
  const { t } = useI18n();
  const s = t.structured;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [context, setContext] = useState(source.context ?? "");
  const [sample, setSample] = useState<
    { title: string; values: Record<string, RecordValue> }[] | null
  >(null);
  useRealtimeRefresh(workspaceId, ["structured_sources"]);
  const since = useRelative();

  function act<T>(
    fn: () => Promise<
      { ok: true; value: T } | { ok: false; error: { message: string; code: string } }
    >,
    done?: (v: T) => void,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        done?.(r.value);
        router.refresh();
      }
    });
  }

  const issues = source.issues;
  const labelOf = (key: string) => source.fields.find((f) => f.key === key)?.label ?? key;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-[13.5px] text-muted">
          <NotionIcon size={16} />
          Notion · {source.account}
          <span className={cn("ml-2 size-1.5 rounded-full", DOT[source.status])} aria-hidden />
          {s.status[source.status]}
        </p>
        {source.status === "paused" && (
          <p className="text-[13.5px] text-approval-text">{s.pausedHint}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/connections/sources/new?edit=${source.id}`}
            className={buttonVariants({ variant: "secondary" })}
          >
            <Pencil />
            {s.editMapping}
          </Link>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              act(
                () => testSourceAction(source.id),
                (v) => {
                  setSample(v);
                  toast.success(s.testOk(v.length));
                },
              )
            }
          >
            {s.test}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              act(
                () => refreshSchemaAction(source.id),
                () => toast.success(s.refreshed),
              )
            }
          >
            <RefreshCw />
            {s.refresh}
          </Button>
          {source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "ghost" })}
            >
              <ExternalLink />
              {s.openInNotion}
            </a>
          )}
        </div>
        {source.checkedAt && (
          <p className="text-[12.5px] text-faint">{s.lastChecked(since(source.checkedAt))}</p>
        )}
      </header>

      {issues.removed?.length ||
      issues.typeChanged?.length ||
      issues.renamed?.length ||
      issues.added?.length ? (
        <section className="flex flex-col gap-1.5 rounded-2xl border border-approval-line bg-approval-bg px-5 py-4 text-[13.5px]">
          {issues.removed?.map((k) => (
            <p key={k} className="text-approval-text">
              {s.issues.removed(labelOf(k))}
            </p>
          ))}
          {issues.typeChanged?.map((k) => (
            <p key={k} className="text-approval-text">
              {s.issues.typeChanged(labelOf(k))}
            </p>
          ))}
          {issues.renamed?.map((r) => (
            <p key={r.key}>{s.issues.renamed(r.from, r.to)}</p>
          ))}
          {issues.added?.length ? (
            <p className="text-muted">{s.issues.added(issues.added.join(", "))}</p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{s.fieldsUnderstood}</h2>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {source.fields.map((f) => (
            <li
              key={f.propertyId}
              className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 text-[13.5px]"
            >
              <span className="truncate">{f.propertyName}</span>
              <span className="text-faint" aria-hidden>
                →
              </span>
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-medium">{f.label}</span>
                <span className="shrink-0 text-[12px] text-faint">
                  {f.broken ? (
                    <span className="text-approval-text">{s.broken[f.broken]}</span>
                  ) : (
                    <>
                      {s.types[f.type]}
                      {!f.writable && ` · ${s.readOnly}`}
                    </>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{s.access}</h2>
        <p className="text-[13.5px]">✓ {s.read}</p>
        {(["create", "update", "archive"] as const).map((k) => {
          const label =
            s[k === "create" ? "allowCreate" : k === "update" ? "allowUpdate" : "allowArchive"];
          return (
            <label key={k} className="flex items-center gap-3 text-[13.5px]">
              <Switch
                checked={source.permissions[k]}
                disabled={pending}
                aria-label={label}
                onCheckedChange={(v) => act(() => updateSourceAction(source.id, { [k]: v }))}
              />
              {label}
            </label>
          );
        })}
        <p className="text-[12.5px] text-faint">{s.accessHint}</p>
        <form
          className="flex flex-col gap-1.5 pt-2 sm:max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            act(
              () => updateSourceAction(source.id, { context: context || null }),
              () => toast.success(t.connections.saved),
            );
          }}
        >
          <Label htmlFor="ctx">{s.context}</Label>
          <div className="flex gap-2">
            <Input
              id="ctx"
              value={context}
              maxLength={200}
              placeholder={s.contextPlaceholder}
              onChange={(e) => setContext(e.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={pending || context === (source.context ?? "")}
            >
              {t.connections.save}
            </Button>
          </div>
          <p className="text-[12.5px] text-faint">{s.contextHint}</p>
        </form>
      </section>

      {sample && (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{s.preview}</h2>
          {sample.length === 0 ? (
            <p className="text-[13.5px] text-muted">{s.previewEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13.5px]">
              {sample.map((r, i) => (
                <li key={i} className="truncate">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-faint">
                    {" · "}
                    {source.fields
                      .filter((f) => !f.isTitle && !f.broken)
                      .slice(0, 3)
                      .map((f) => `${f.label}: ${formatValue(r.values[f.key])}`)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="border-t border-border pt-4">
        <Button
          variant="ghost"
          className="hover:text-danger-text"
          disabled={pending}
          onClick={() => {
            if (!window.confirm(s.disconnectConfirm(source.name))) return;
            act(
              () => unmapAction(source.id),
              () => router.push("/connections"),
            );
          }}
        >
          {s.disconnect}
        </Button>
      </div>
    </div>
  );
}
