"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { importStatusAction, startChatImportAction } from "./actions";
import { COMMON_CURRENCIES, useDay } from "./format";
import { ImportProgress } from "./import-review";

type Import = SurfacePayloads["finance_import"];

/**
 * A spreadsheet from chat (ADR-075), analyzed by the Finance import pipeline: what ELISE found,
 * the one file-level choice left (its currency), and the same two ways forward as the Finance
 * screen — review everything there, or start the same durable import here.
 */
export function FinanceImportCard({ p }: { p: Import }) {
  const { t } = useI18n();
  const w = t.finance.wizard;
  const c = t.finance.chatImport;
  const day = useDay();
  const [currency, setCurrency] = useState(p.currency ?? "");
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const review = `/my-elise/finance/import/${p.importId}`;

  // Reopened later: an import already running or done shows where it is, not the buttons.
  useEffect(() => {
    let live = true;
    void importStatusAction(p.importId).then((r) => {
      if (live && r.ok && r.value.status !== "uploaded" && r.value.status !== "uploading")
        setStarted(true);
    });
    return () => {
      live = false;
    };
  }, [p.importId]);

  if (started) return <ImportProgress importId={p.importId} />;

  const needsCurrency = p.fileCurrency && !currency;
  const blocking = p.needs.filter((n) => n !== "defaultCurrency");
  const canStart = !needsCurrency && !blocking.length && p.review === 0 && p.willImport > 0;
  const count = p.invalid > 0 || p.review > 0 ? p.willImport : p.rows - p.duplicates;
  return (
    <div className="flex flex-col gap-3 text-[14px]">
      <div className="flex flex-col gap-0.5">
        <p className="truncate font-medium">{p.label}</p>
        <p className="text-muted">
          {c.found(p.rows)}
          {p.format && ` · ${p.format}`}
          {p.dateRange && ` · ${day(p.dateRange.from)} → ${day(p.dateRange.to)}`}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
        {p.typeStrategy && (
          <>
            <dt className="text-faint">{w.defaultType}</dt>
            <dd>{c.types[p.typeStrategy]}</dd>
          </>
        )}
        {p.accounts.slice(0, 3).map((a) => (
          <div key={a.raw} className="contents">
            <dt className="text-faint">{a.raw}</dt>
            <dd>{a.how === "created" ? c.newAccount(a.name) : `→ ${a.name}`}</dd>
          </div>
        ))}
      </dl>
      {p.fileCurrency && (
        <div className="flex items-center gap-3">
          <Label htmlFor={`import-currency-${p.importId}`}>{w.defaultCurrency}</Label>
          <Select
            id={`import-currency-${p.importId}`}
            value={currency}
            aria-invalid={needsCurrency}
            onChange={(e) => setCurrency(e.target.value)}
            className="h-10 w-28"
          >
            <option value="">{w.defaultTypes.none}</option>
            {COMMON_CURRENCIES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </div>
      )}
      {(p.invalid > 0 || p.review > 0 || p.duplicates > 0) && (
        <p className="text-[13px] text-muted">
          {[
            p.duplicates > 0 ? w.duplicates(p.duplicates) : null,
            p.review > 0 ? c.review(p.review) : null,
            p.invalid - p.review > 0 ? w.attention(p.invalid - p.review) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 max-sm:[&>*]:flex-1">
        <Link href={review} className={buttonVariants({ variant: "secondary" })}>
          {p.review > 0 ? c.reviewN(p.review) : c.reviewAll}
        </Link>
        <Button
          disabled={pending || !canStart}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await startChatImportAction(p.importId, currency || null);
              if (r.ok) return setStarted(true);
              setError(r.error.recovery === "review" ? c.needsReview : errorText(t, r.error));
            })
          }
        >
          {w.importN(count)}
        </Button>
      </div>
    </div>
  );
}
