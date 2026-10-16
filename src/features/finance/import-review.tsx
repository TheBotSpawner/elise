"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { EntityView, ImportInspection, ImportPreviewView } from "@/application/finance-import";
import { buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type { EntityDecision, FinanceField, FinanceMapping } from "@/core/finance/import";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { importStatusAction } from "./actions";
import { useDay } from "./format";

const SUMMARY_FIELDS: FinanceField[] = [
  "date",
  "account",
  "category",
  "description",
  "amount",
  "incomeAmount",
  "expenseAmount",
  "currency",
  "type",
];

/**
 * What ELISE understood from the file (ADR-073): how many movements, which columns it read,
 * and what each account and category name becomes — correctable in place. A name ELISE can't
 * place without the user is asked here, once, and applies to every row that uses it.
 */
export function ImportUnderstanding({
  inspection,
  preview,
  mapping,
  onDecide,
}: {
  inspection: ImportInspection;
  preview: ImportPreviewView;
  mapping: FinanceMapping;
  onDecide: (kind: "accounts" | "categories", key: string, decision: EntityDecision) => void;
}) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const day = useDay();
  const review = [...preview.entities.accounts, ...preview.entities.categories].filter(
    (e) => e.how === "review",
  ).length;
  return (
    <section className="flex flex-col gap-5" aria-live="polite">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-[16px]">
          {review ? (
            <AlertTriangle className="size-5 text-approval-text" aria-hidden />
          ) : (
            <CheckCircle2 className="size-5 text-success" aria-hidden />
          )}
          {review ? w.needsDecisions(review) : w.understood(preview.willImport)}
        </p>
        <p className="text-[13px] text-muted">
          {[
            w.detected(preview.totalRows),
            preview.dateRange && `${day(preview.dateRange.from)} → ${day(preview.dateRange.to)}`,
            preview.byCurrency.map((c) => c.currency).join(", "),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
        {SUMMARY_FIELDS.filter((f) => mapping.columns[f] !== undefined).map((f) => (
          <div key={f} className="contents">
            <dt className="text-muted">{w.fields[f]}</dt>
            <dd className="truncate">← {inspection.headers[mapping.columns[f]!] || "—"}</dd>
          </div>
        ))}
      </dl>
      {inspection.ignored.length > 0 && (
        <p className="text-[12.5px] text-faint">
          {w.ignored(inspection.ignored.map((i) => i.header).join(", "))}
        </p>
      )}

      <Entities
        title={w.accounts}
        kind="accounts"
        list={preview.entities.accounts}
        options={preview.catalog.accounts}
        open
        onDecide={onDecide}
      />
      <Entities
        title={w.categories(preview.entities.categories.length)}
        kind="categories"
        list={preview.entities.categories}
        options={preview.catalog.categories}
        open={preview.entities.categories.some((c) => c.how === "review")}
        onDecide={onDecide}
      />
      {preview.review > 0 && (
        <p className="flex items-start gap-2 text-[13px] text-approval-text">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {w.heldBack(preview.review)}
        </p>
      )}
    </section>
  );
}

function Entities({
  title,
  kind,
  list,
  options,
  open,
  onDecide,
}: {
  title: string;
  kind: "accounts" | "categories";
  list: EntityView[];
  options: { id: string; name: string; type?: string }[];
  open: boolean;
  onDecide: (kind: "accounts" | "categories", key: string, decision: EntityDecision) => void;
}) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const [shown, setShown] = useState(open);
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
        className="flex items-center gap-1.5 self-start text-[12.5px] font-medium tracking-wide text-faint uppercase hover:text-fg"
      >
        <ChevronDown
          className={cn("size-4 transition-transform", shown && "rotate-180")}
          aria-hidden
        />
        {title}
      </button>
      {shown && (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {list.map((e) => {
            const key = kind === "categories" ? `${e.type}|${e.key}` : e.key;
            const choices = options.filter(
              (o) => kind === "accounts" || o.type === e.type || o.type === "both",
            );
            const value = e.id ?? (e.how === "review" ? "" : "create");
            return (
              <li
                key={key}
                className={cn(
                  "grid grid-cols-1 items-center gap-1.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:gap-3",
                  e.how === "review" && "bg-approval-bg",
                )}
              >
                <span className="min-w-0 text-[13.5px]">
                  <span className="truncate">{e.raw}</span>
                  <span className="text-faint">
                    {" · "}
                    {w.rowsCount(e.rows)}
                    {e.how !== "exact" && e.how !== "created" ? ` · ${w.how[e.how]}` : ""}
                  </span>
                </span>
                <Select
                  aria-label={w.chooseFor(e.raw)}
                  value={value}
                  onChange={(ev) =>
                    onDecide(
                      kind,
                      key,
                      ev.target.value === "create"
                        ? { action: "create" }
                        : { action: "match", id: ev.target.value },
                    )
                  }
                >
                  {value === "" && <option value="">{w.choose}</option>}
                  <option value="create">
                    {kind === "accounts" ? w.newAccount(e.name) : w.newCategory(e.name)}
                  </option>
                  {choices.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Status =
  Awaited<ReturnType<typeof importStatusAction>> extends infer R
    ? R extends { ok: true; value: infer V }
      ? V
      : never
    : never;

/**
 * A running import, followed for real (ADR-073): processed rows as they are written. The user
 * can leave — the import keeps going in the background and its result waits in the history.
 */
export function ImportProgress({ importId }: { importId: string }) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const [status, setStatus] = useState<Status | null>(null);
  const finished =
    status &&
    (status.status === "completed" ||
      status.status === "failed" ||
      status.status === "rolled_back");
  useEffect(() => {
    if (finished) return;
    let live = true;
    const tick = async () => {
      const r = await importStatusAction(importId);
      if (live && r.ok) setStatus(r.value);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [importId, finished]);

  if (!status || !finished) {
    const total = status?.total ?? 0;
    const done = status?.processed ?? 0;
    return (
      <div className="flex flex-col gap-3" aria-live="polite">
        <p className="flex items-center gap-2 text-[15px]">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {total ? w.progress(done, total) : w.importing}
        </p>
        {total > 0 && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.round((done / total) * 100)}%` }}
            />
          </div>
        )}
        <p className="text-[13px] text-muted">{w.canLeave}</p>
      </div>
    );
  }
  if (status.status === "failed")
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-[14px] text-danger-text">
          {w.failed}
        </p>
        <Link href="/my-elise/finance/sources" className={buttonVariants({ variant: "secondary" })}>
          {t.finance.sourcesTitle}
        </Link>
      </div>
    );
  const other = status.invalid - status.review;
  return (
    <div className="flex flex-col items-start gap-4" aria-live="polite">
      <p className="flex items-center gap-2 text-[16px]">
        <CheckCircle2 className="size-5 text-success" aria-hidden />
        {w.completed}
      </p>
      <ul className="flex flex-col gap-0.5 text-[14px]">
        <li>{w.resultImported(status.imported)}</li>
        {status.duplicates > 0 && (
          <li className="text-muted">{w.resultDuplicates(status.duplicates)}</li>
        )}
        {status.review > 0 && (
          <li className="text-approval-text">{w.resultReview(status.review)}</li>
        )}
        {other > 0 && <li className="text-approval-text">{w.resultInvalid(other)}</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Link href="/my-elise/finance" className={buttonVariants()}>
          {w.openFinance}
        </Link>
        <Link href="/my-elise/finance/sources" className={buttonVariants({ variant: "secondary" })}>
          {t.finance.sourcesTitle}
        </Link>
      </div>
    </div>
  );
}
