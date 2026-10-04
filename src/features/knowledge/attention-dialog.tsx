"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { SourceProblem, SourceView } from "@/application/knowledge-service";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { attentionActions, attentionReason } from "@/core/knowledge/attention";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { retryItemAction, retryProblemsAction, sourceProblemsAction } from "./actions";
import { SourceIcon, useRelative } from "./ui";

/** The name a source row shows (uploads and notes are containers with a fixed name). */
export function useSourceName() {
  const { t } = useI18n();
  return (s: SourceView) =>
    s.sourceType === "upload"
      ? t.knowledge.uploadedFiles
      : s.sourceType === "note"
        ? t.knowledge.sourceTypes.note
        : s.name;
}

/** "Notion database", "Drive folder"…: what was connected, never internal ids. */
export function useSourceKind() {
  const { t } = useI18n();
  return (s: SourceView) =>
    (s.kind && t.knowledge.sourceKind[s.sourceType]?.[s.kind]) ??
    t.knowledge.sourceTypes[s.sourceType];
}

function TechnicalDetails({ rows }: { rows: [string, string | null][] }) {
  const { t } = useI18n();
  const shown = rows.filter((r): r is [string, string] => Boolean(r[1]));
  if (!shown.length) return null;
  return (
    <details className="text-[12.5px] text-faint">
      <summary className="cursor-pointer select-none hover:text-muted">
        {t.knowledge.attention.technical}
      </summary>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {shown.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="font-mono break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * "Needs attention", explained (ADR-037): the source's own problem if it has one, then only
 * the children with a problem — each with a reason in plain words and only actions that help.
 */
export function SourceAttentionDialog({
  source,
  onClose,
  onSync,
  onRemove,
}: {
  source: SourceView | null;
  onClose: () => void;
  onSync: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
}) {
  const { t } = useI18n();
  const a = t.knowledge.attention;
  const router = useRouter();
  const relative = useRelative();
  const nameOf = useSourceName();
  const kindOf = useSourceKind();
  const [data, setData] = useState<{ problems: SourceProblem[]; total: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const sourceId = source?.id ?? null;

  useEffect(() => {
    if (!sourceId) return;
    let live = true;
    void sourceProblemsAction(sourceId).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.value);
      else toast.error(errorText(t, r.error));
    });
    return () => {
      live = false;
      setData(null);
    };
  }, [sourceId, t]);

  const reload = () =>
    sourceId &&
    void sourceProblemsAction(sourceId).then((r) => {
      if (r.ok) setData(r.value);
    });

  if (!source) return null;
  const connected = source.sourceType === "google_drive" || source.sourceType === "notion";
  // The source itself failed (listing, access, a stalled sync): said first, apart from items.
  const ownProblem =
    connected && source.state === "needs_attention"
      ? attentionReason(source.lastErrorCode ?? "BACKGROUND_STALLED", null)
      : null;
  const failedItems = data?.problems.filter((p) => p.status !== "ready").length ?? 0;

  return (
    <Dialog open onClose={onClose} busy={pending} title={a.title(nameOf(source))}>
      <div className="flex flex-col gap-5">
        <p className="flex items-center gap-2 text-[13.5px] text-muted">
          <SourceIcon type={source.sourceType} size={16} />
          <span>{kindOf(source)}</span>
          <span aria-hidden>·</span>
          <span>
            {a.summary(source.counts.ready, source.counts.attention, source.counts.processing)}
          </span>
        </p>

        {ownProblem && (
          <section className="flex flex-col gap-2 rounded-xl border border-approval/40 bg-approval/5 p-3.5">
            <h3 className="type-label text-faint">{a.sourceProblem}</h3>
            <p className="text-[14px]">
              {t.knowledge.sourceDetails.errors[source.lastErrorCode ?? ""] ??
                a.reasons[ownProblem]}
            </p>
            {source.counts.ready > 0 && (
              <p className="text-[13px] text-muted">{t.knowledge.sourceDetails.stillAvailable}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {attentionActions(ownProblem).includes("reconnect") && (
                <Link
                  href="/connections"
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                >
                  {a.reconnect}
                </Link>
              )}
              {attentionActions(ownProblem).includes("retry") && (
                <Button size="sm" variant="secondary" onClick={() => onSync(source.id)}>
                  {a.retry}
                </Button>
              )}
            </div>
            <TechnicalDetails
              rows={[
                [a.code, source.lastErrorCode],
                [a.lastAttempt, source.lastRunAt && relative(source.lastRunAt)],
                ["id", source.id],
              ]}
            />
          </section>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="type-label text-faint">{a.problemItems}</h3>
            {failedItems > 0 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await retryProblemsAction(source.id);
                    if (!r.ok) return void toast.error(errorText(t, r.error));
                    toast.success(a.retried(r.value.retried));
                    reload();
                    router.refresh();
                  })
                }
              >
                {a.retryAll(data?.total ?? failedItems)}
              </Button>
            )}
          </div>
          {!data ? (
            <p className="text-[13px] text-faint">…</p>
          ) : data.problems.length === 0 ? (
            <p className="text-[13.5px] text-muted">{a.none}</p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-xl border border-border">
              {data.problems.map((p) => {
                const reason = attentionReason(p.errorCode, p.detail);
                const actions = attentionActions(reason);
                return (
                  <li key={p.id} className="flex flex-col gap-1.5 px-3.5 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Link
                        href={`/knowledge/items/${p.id}`}
                        className="min-w-0 truncate text-sm font-medium hover:text-accent-text"
                      >
                        {p.title}
                      </Link>
                      <span className="shrink-0 text-[12px] text-faint">
                        {relative(p.updatedAt)}
                      </span>
                    </div>
                    <p className="text-[13px] text-approval-text">{a.reasons[reason]}</p>
                    {p.status === "ready" && (
                      <p className="text-[12.5px] text-muted">
                        {t.knowledge.sourceDetails.stillAvailable}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      {actions.includes("retry") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const r = await retryItemAction(p.id);
                              if (!r.ok) return void toast.error(errorText(t, r.error));
                              reload();
                              router.refresh();
                            })
                          }
                        >
                          {a.retry}
                        </Button>
                      )}
                      {actions.includes("reconnect") && (
                        <Link
                          href="/connections"
                          className={buttonVariants({ size: "sm", variant: "ghost" })}
                        >
                          {a.reconnect}
                        </Link>
                      )}
                      {actions.includes("open") && p.sourceUrl && (
                        <a
                          href={p.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={buttonVariants({ size: "sm", variant: "ghost" })}
                        >
                          {a.openSource}
                        </a>
                      )}
                    </div>
                    <TechnicalDetails
                      rows={[
                        [a.code, p.errorCode],
                        [a.message, p.detail],
                        ["id", p.id],
                      ]}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {data && data.total > data.problems.length && (
            <p className="text-[12.5px] text-faint">
              {a.showingOf(data.problems.length, data.total)}
            </p>
          )}
        </section>

        {connected && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="hover:text-danger-text"
              disabled={pending}
              onClick={() => onRemove(source.id)}
            >
              {a.remove}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** From a Space card's "1 needs attention": the affected sources, each one drillable. */
export function SpaceAttentionDialog({
  open,
  sources,
  onClose,
  onPick,
}: {
  open: boolean;
  sources: SourceView[];
  onClose: () => void;
  onPick: (source: SourceView) => void;
}) {
  const { t } = useI18n();
  const nameOf = useSourceName();
  const kindOf = useSourceKind();
  const affected = sources.filter((s) => s.rollup === "needs_attention" || s.rollup === "failed");
  return (
    <Dialog open={open} onClose={onClose} title={t.knowledge.attention.spaceTitle}>
      {affected.length === 0 ? (
        <p className="text-[14px] text-muted">{t.knowledge.attention.spaceNone}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {affected.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-active"
              >
                <SourceIcon type={s.sourceType} size={16} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{nameOf(s)}</span>
                  <span className="block truncate text-[12.5px] text-muted">
                    {kindOf(s)} · {t.knowledge.rollup[s.rollup]}
                    {s.counts.attention > 0 &&
                      ` · ${t.knowledge.attentionCount(s.counts.attention)}`}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
