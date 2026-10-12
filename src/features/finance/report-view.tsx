"use client";

import { Download, RefreshCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

import { buttonVariants, Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  DEFAULT_REPORT_SECTIONS,
  REPORT_SECTIONS,
  resolvePeriod,
  type FinanceBook,
  type GroupTotal,
  type PeriodPreset,
  type ReportSection,
} from "@/core/capabilities/finance";
import type { FinanceReport } from "@/core/finance/report";
import { financeTrendVisual, type VisualizationSpec } from "@/core/workspace/visualization";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { COMMON_CURRENCIES, useMoney, usePeriodLabel } from "./format";

const PRESETS: PeriodPreset[] = [
  "last_30_days",
  "this_month",
  "last_month",
  "last_90_days",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
];

/**
 * Report configurator + preview (ADR-052). Every change rewrites the URL; the server rebuilds
 * the dataset with the same tool the PDF and chat use, so preview and download always match.
 */
export function ReportView({
  report,
  books,
  today,
}: {
  report: FinanceReport;
  books: FinanceBook[];
  today: string;
}) {
  const { t } = useI18n();
  const r = t.finance.reports;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  // Checkboxes answer at once; the server rebuilds the dataset behind them.
  const [sections, setSections] = useOptimistic(report.sections);
  const preset =
    PRESETS.find((p) => {
      const x = resolvePeriod(p, today);
      return x.from === report.period.from && x.to === report.period.to;
    }) ?? "custom";
  const [custom, setCustom] = useState(preset === "custom");
  const [from, setFrom] = useState(report.period.from);
  const [to, setTo] = useState(report.period.to);
  const set = (patch: Record<string, string | null>, optimistic?: ReportSection[]) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    startTransition(() => {
      if (optimistic) setSections(optimistic);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    });
  };
  const query = new URLSearchParams(params.toString());
  query.set("from", report.period.from);
  query.set("to", report.period.to);
  const toggle = (s: ReportSection) => {
    const next = sections.includes(s)
      ? sections.filter((x) => x !== s)
      : REPORT_SECTIONS.filter((x) => x === s || sections.includes(x));
    const isDefault =
      next.length === DEFAULT_REPORT_SECTIONS.length &&
      DEFAULT_REPORT_SECTIONS.every((x) => next.includes(x));
    set({ sections: isDefault ? null : next.join(",") || "summary" }, next);
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 lg:sticky lg:top-4">
        <h2 className="type-label text-faint">{r.configure}</h2>
        {books.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rep-book">{r.scope}</Label>
            <Select
              id="rep-book"
              value={report.book ?? ""}
              onChange={(e) => set({ book: e.target.value || null })}
            >
              <option value="">{r.allBooks}</option>
              {books.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rep-period">{t.finance.period}</Label>
          <Select
            id="rep-period"
            value={custom ? "custom" : preset}
            onChange={(e) => {
              if (e.target.value === "custom") return setCustom(true);
              setCustom(false);
              const p = resolvePeriod(e.target.value as PeriodPreset, today);
              set({ from: p.from, to: p.to });
            }}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t.finance.periods[p]}
              </option>
            ))}
            <option value="custom">{t.finance.ws.custom}</option>
          </Select>
          {custom && (
            <form
              className="grid grid-cols-2 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (from && to && from <= to) set({ from, to });
              }}
            >
              <Input
                type="date"
                aria-label={t.finance.ws.from}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                type="date"
                aria-label={t.finance.ws.to}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <Button size="sm" type="submit" variant="secondary" className="col-span-2">
                {t.finance.ws.apply}
              </Button>
            </form>
          )}
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-medium">{r.configure}</legend>
          {REPORT_SECTIONS.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                checked={sections.includes(s)}
                onChange={() => toggle(s)}
                className="size-4 accent-[var(--accent)]"
              />
              {r.sections[s]}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rep-rc">{r.reportingCurrency}</Label>
          <Select
            id="rep-rc"
            value={params.get("rc") ?? ""}
            onChange={(e) => set({ rc: e.target.value || null })}
          >
            <option value="">{r.noConversion}</option>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2 pt-1">
          <a
            href={`/api/finance/report?${query.toString()}`}
            className={buttonVariants({ variant: "primary" })}
            download
          >
            <Download />
            {r.download}
          </a>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => startTransition(() => router.refresh())}
          >
            <RefreshCw className={cn(pending && "animate-spin")} />
            {r.regenerate}
          </Button>
        </div>
      </aside>
      <ReportPreview report={report} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h2 className="type-label text-accent-text">{title}</h2>
      {children}
    </section>
  );
}

function hbar(title: string, groups: GroupTotal[], currency: string): VisualizationSpec | null {
  const rows = groups
    .filter((g) => g.currency === currency)
    .map((g) => ({ label: g.key.slice(0, 60), value: Math.round(Number(g.total)) }));
  return rows.length ? { type: "hbar", title, format: { kind: "currency", currency }, rows } : null;
}

export function ReportPreview({ report }: { report: FinanceReport }) {
  const { t, locale } = useI18n();
  const r = t.finance.reports;
  const ws = t.finance.ws;
  const money = useMoney();
  const period = usePeriodLabel();
  const has = (s: ReportSection) => report.sections.includes(s);
  const currencies = report.totals.map((c) => c.currency);
  return (
    <article className="flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-surface px-5 py-6 md:px-8">
      <header className="flex flex-col gap-1">
        <span className="type-label text-accent-text">ELISE</span>
        <h1 className="text-[22px] font-semibold">{r.title}</h1>
        <p className="text-[14px] text-muted">
          {period(report.period)} · {report.book ?? r.allBooks}
        </p>
      </header>

      {(has("summary") || has("kpis")) && (
        <Section title={r.sections.summary}>
          {report.totals.length === 0 ? (
            <p className="text-[14px] text-muted">{r.noTransactions}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-[14px]">
                <thead>
                  <tr className="text-left text-[12px] text-muted">
                    <th className="py-1 font-normal" />
                    <th className="py-1 text-right font-normal">{t.finance.income}</th>
                    <th className="py-1 text-right font-normal">{t.finance.expenses}</th>
                    <th className="py-1 text-right font-normal">{t.finance.net}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.totals.map((c) => (
                    <tr key={c.currency} className="border-t border-border">
                      <td className="py-2 font-medium">{c.currency}</td>
                      <td className="py-2 text-right font-mono text-success">
                        {money(c.income, c.currency)}
                      </td>
                      <td className="py-2 text-right font-mono">{money(c.expense, c.currency)}</td>
                      <td
                        className={cn(
                          "py-2 text-right font-mono font-medium",
                          c.net.startsWith("-") && "text-danger-text",
                        )}
                      >
                        {money(c.net, c.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[12.5px] text-faint">
            {[
              currencies.length > 1 ? t.finance.separateCurrencies : "",
              report.excluded.pending ? t.finance.excluded(report.excluded.pending) : "",
              report.transfers ? ws.transfers(report.transfers) : "",
              report.truncated ? r.truncated : "",
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
          {report.converted && (
            <div className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3 text-[13.5px]">
              <span className="text-[12px] text-muted">
                {r.reportingCurrency} {report.converted.currency}
              </span>
              <span className="font-mono">
                {t.finance.income} {money(report.converted.income, report.converted.currency)} ·{" "}
                {t.finance.expenses} {money(report.converted.expense, report.converted.currency)} ·{" "}
                {t.finance.net} {money(report.converted.net, report.converted.currency)}
              </span>
              {report.converted.ratesUsed.length > 0 && (
                <span className="text-[12px] text-faint">
                  {r.ratesUsed}:{" "}
                  {report.converted.ratesUsed
                    .map((x) => `1 ${x.from} = ${x.rate} ${x.to} (${x.date})`)
                    .join("; ")}
                </span>
              )}
              {report.converted.unconverted.map((u) => (
                <span key={u.currency} className="text-[12px] text-approval-text">
                  {r.unconverted(u.currency, u.count)}
                </span>
              ))}
            </div>
          )}
        </Section>
      )}

      {has("trend") &&
        report.trend.map((s) => {
          const v = financeTrendVisual(s, locale);
          return v ? (
            <Section key={s.currency} title={`${r.sections.trend} · ${s.currency}`}>
              <Visualization spec={v.spec} size="medium" />
            </Section>
          ) : null;
        })}

      {has("categories") &&
        currencies.map((c) => {
          const specs = [
            hbar(`${ws.expensesByCategory} · ${c}`, report.expenseCategories, c),
            hbar(`${ws.incomeByCategory} · ${c}`, report.incomeCategories, c),
          ].filter((x): x is VisualizationSpec => x !== null);
          return specs.length ? (
            <Section key={c} title={`${r.sections.categories} · ${c}`}>
              <div className="grid gap-5 md:grid-cols-2">
                {specs.map((spec) => (
                  <div key={spec.title} className="flex flex-col gap-2">
                    <h3 className="text-[13px] text-muted">{spec.title}</h3>
                    <Visualization spec={spec} size="small" />
                  </div>
                ))}
              </div>
            </Section>
          ) : null;
        })}

      {has("budgets") && report.budgets.length > 0 && (
        <Section title={`${r.sections.budgets} · ${r.budgetMonths(report.budgetMonths)}`}>
          <ul className="flex flex-col gap-2.5">
            {report.budgets.map((u) => (
              <li key={u.id} className="flex flex-col gap-1 text-[13.5px]">
                <span className="flex justify-between gap-3">
                  <span className="truncate">
                    {[u.category, u.subcategory, u.book].filter(Boolean).join(" · ")}
                  </span>
                  <span className="shrink-0 font-mono text-[12.5px] text-muted">
                    {money(u.spent, u.currency)} / {money(u.amount, u.currency)} ·{" "}
                    {(u.percentTenths / 10).toFixed(0)}%
                  </span>
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      u.state === "over"
                        ? "bg-danger"
                        : u.state === "warning"
                          ? "bg-approval"
                          : "bg-accent",
                    )}
                    style={{ width: `${Math.min(100, u.percentTenths / 10)}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {has("counterparties") &&
        currencies.map((c) => {
          const specs = [
            hbar(`${ws.topClients} · ${c}`, report.clients, c),
            hbar(`${ws.topProviders} · ${c}`, report.providers, c),
            hbar(`${ws.byProject} · ${c}`, report.projects, c),
          ].filter((x): x is VisualizationSpec => x !== null);
          return specs.length ? (
            <Section key={c} title={`${r.sections.counterparties} · ${c}`}>
              <div className="grid gap-5 md:grid-cols-2">
                {specs.map((spec) => (
                  <div key={spec.title} className="flex flex-col gap-2">
                    <h3 className="text-[13px] text-muted">{spec.title}</h3>
                    <Visualization spec={spec} size="small" />
                  </div>
                ))}
              </div>
            </Section>
          ) : null;
        })}

      {has("transactions") && report.transactions.length > 0 && (
        <Section title={`${r.sections.transactions} (${report.transactions.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted">
                  <th className="py-1 font-normal">{t.finance.date}</th>
                  <th className="py-1 font-normal">{t.finance.counterparty}</th>
                  <th className="py-1 font-normal">{t.finance.category}</th>
                  <th className="py-1 font-normal">{t.finance.account}</th>
                  <th className="py-1 text-right font-normal">{t.finance.amount}</th>
                </tr>
              </thead>
              <tbody>
                {report.transactions.slice(0, 500).map((tx) => (
                  <tr key={tx.id} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3 font-mono text-[12px] whitespace-nowrap text-muted">
                      {tx.date}
                    </td>
                    <td className="py-1.5 pr-3">
                      {tx.counterparty || tx.description || "—"}
                      {tx.status === "pending" && (
                        <span className="ml-1.5 text-[11.5px] text-approval-text">
                          {t.finance.statuses.pending}
                        </span>
                      )}
                      {!report.book && tx.book && (
                        <span className="ml-1.5 text-[11.5px] text-faint">{tx.book}</span>
                      )}
                      {has("notes") && tx.notes && (
                        <span className="block text-[12px] text-faint">{tx.notes}</span>
                      )}
                      {has("receipts") && tx.receipt && (
                        <span className="block text-[12px] break-all text-faint">
                          {ws.receipt}: {tx.receipt}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">
                      {tx.type === "transfer"
                        ? t.finance.types.transfer
                        : [tx.category, tx.subcategory].filter(Boolean).join(" › ") || "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">
                      {tx.type === "transfer"
                        ? `${tx.account ?? "—"} → ${tx.toAccount ?? "—"}`
                        : (tx.account ?? tx.paymentMethod ?? "—")}
                    </td>
                    <td
                      className={cn(
                        "py-1.5 text-right font-mono whitespace-nowrap",
                        tx.type === "income" && "text-success",
                      )}
                    >
                      {tx.type === "income" ? "+" : tx.type === "expense" ? "−" : ""}
                      {money(tx.amount, tx.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </article>
  );
}
