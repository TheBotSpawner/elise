"use client";

import { motion, type MotionProps } from "motion/react";
import Link from "next/link";

import type { ToolDisplay } from "@/core/agents/tools";
import type { FinanceInsight, FinanceTransaction } from "@/core/capabilities/finance";
import { compareAmounts } from "@/core/finance/money";
import { share, useDay, useMoney, usePeriodLabel } from "@/features/finance/format";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type D<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

const CARD =
  "flex flex-col gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

function Header({ label }: { label: string }) {
  return (
    <Link href="/my-elise/finance" className="type-label text-faint hover:text-accent-text">
      {label}
    </Link>
  );
}

export function useInsightText() {
  const { t } = useI18n();
  return (i: FinanceInsight) =>
    i.kind === "large_transaction"
      ? t.finance.insight.large(i.transaction.label, i.times)
      : i.kind === "category_up"
        ? t.finance.insight.up(i.category, i.percent)
        : t.finance.insight.down(i.category, i.percent);
}

/** Income / expenses / net, one row per currency: never one merged total. */
export function CurrencyTotals({
  totals,
  compact = false,
}: {
  totals: D<"finance_summary">["summary"]["current"]["totals"];
  compact?: boolean;
}) {
  const { t } = useI18n();
  const money = useMoney();
  return (
    <table className="w-full text-[14px]">
      <thead className="text-left text-[12px] text-faint">
        <tr>
          <th className="py-1 font-normal">{t.finance.currency}</th>
          <th className="py-1 text-right font-normal">{t.finance.income}</th>
          <th className="py-1 text-right font-normal">{t.finance.expenses}</th>
          {!compact && <th className="py-1 text-right font-normal">{t.finance.net}</th>}
        </tr>
      </thead>
      <tbody className="font-mono text-[13px]">
        {totals.map((c) => (
          <tr key={c.currency} className="border-t border-border">
            <td className="py-1.5 font-sans font-medium">{c.currency}</td>
            <td className="py-1.5 text-right text-success">{money(c.income, c.currency)}</td>
            <td className="py-1.5 text-right">{money(c.expense, c.currency)}</td>
            {!compact && (
              <td className={cn("py-1.5 text-right", c.net.startsWith("-") && "text-danger-text")}>
                {money(c.net, c.currency)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FinanceSummaryCard({
  display,
  rise,
}: {
  display: D<"finance_summary">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const period = usePeriodLabel();
  const insight = useInsightText();
  const s = display.summary;
  const top = s.current.byCategory.filter((c) => c.type === "expense").slice(0, 4);
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Header label={`${t.finance.title} · ${period(s.period)}`} />
      {s.current.totals.length === 0 ? (
        <p className="text-[14px] text-muted">{t.finance.nothingMatches}</p>
      ) : (
        <CurrencyTotals totals={s.current.totals} />
      )}
      {s.current.totals.length > 1 && (
        <p className="text-[12.5px] text-faint">{t.finance.separateCurrencies}</p>
      )}
      {top.length > 0 && (
        <ul className="flex flex-col gap-1 text-[13.5px]">
          {top.map((c) => (
            <li key={`${c.currency}${c.key}`} className="flex justify-between gap-3">
              <span className="truncate text-muted">{c.key}</span>
              <span className="shrink-0 font-mono text-[12.5px]">{money(c.total, c.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {s.insights.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-border pt-2 text-[13.5px]">
          {s.insights.slice(0, 3).map((i, n) => (
            <li key={n}>{insight(i)}</li>
          ))}
        </ul>
      )}
      <Footer sources={s.sources.map((x) => x.name)} excluded={s.current.excluded.pending} />
    </motion.section>
  );
}

function Footer({ sources, excluded }: { sources: string[]; excluded: number }) {
  const { t } = useI18n();
  if (!sources.length && !excluded) return null;
  return (
    <p className="text-[12px] text-faint">
      {[...new Set(sources)].join(" · ")}
      {excluded > 0 && ` · ${t.finance.excluded(excluded)}`}
    </p>
  );
}

export function FinanceBreakdownCard({
  display,
  rise,
}: {
  display: D<"finance_breakdown">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const period = usePeriodLabel();
  const b = display.breakdown;
  const groups = b.groups.slice(0, 10);
  const max = (currency: string, type: string) =>
    groups
      .filter((g) => g.currency === currency && g.type === type)
      .reduce((m, g) => (compareAmounts(g.total, m) > 0 ? g.total : m), "0");
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Header label={`${t.finance.title} · ${period(b.period)}`} />
      {b.totals.length > 0 && <CurrencyTotals totals={b.totals} compact={b.groupBy !== null} />}
      {groups.length > 0 && (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => {
            const pct = share(g.total, max(g.currency, g.type));
            return (
              <li
                key={`${g.type}${g.currency}${g.key}`}
                className="flex flex-col gap-1 text-[13.5px]"
              >
                <span className="flex justify-between gap-3">
                  <span className="truncate">{g.key}</span>
                  <span className="shrink-0 font-mono text-[12.5px] text-muted">
                    {money(g.total, g.currency)}
                  </span>
                </span>
                <span className="h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      g.type === "income" ? "bg-success" : "bg-accent",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Footer sources={b.sources.map((s) => s.name)} excluded={b.excluded.pending} />
    </motion.section>
  );
}

export function TransactionLine({ t: tx }: { t: FinanceTransaction }) {
  const money = useMoney();
  const day = useDay();
  return (
    <span className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-3 text-[14px]">
      <span className="font-mono text-[12px] text-faint">{day(tx.date)}</span>
      <span className="min-w-0">
        <span className="block truncate">
          {tx.counterparty || tx.description || tx.category || "—"}
        </span>
        <span className="block truncate text-[12px] text-faint">
          {[tx.category, tx.account ?? tx.paymentMethod, tx.provenance.source]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[13px]",
          tx.type === "income" ? "text-success" : "text-fg",
          tx.status !== "completed" && "text-muted",
        )}
      >
        {tx.type === "income" ? "+" : "−"}
        {money(tx.amount, tx.currency)}
      </span>
    </span>
  );
}

export function FinanceTransactionsCard({
  display,
  rise,
}: {
  display: D<"finance_transactions">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  if (!display.transactions.length) return null;
  return (
    <motion.section {...rise} aria-label={t.finance.transactions} className={CARD}>
      <Header label={`${t.finance.transactions} · ${t.finance.matching(display.total)}`} />
      <ul className="flex flex-col gap-2">
        {display.transactions.slice(0, 10).map((tx) => (
          <li key={tx.id}>
            <TransactionLine t={tx} />
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

export function FinanceTransactionCard({
  display,
  rise,
}: {
  display: D<"finance_transaction">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const label =
    display.change === "archived"
      ? t.finance.archived
      : display.change === "shown"
        ? t.finance.types[display.transaction.type]
        : display.change === "created"
          ? t.finance.recorded
          : t.finance.saved;
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Header label={`${t.finance.title} · ${label}`} />
      <div className={cn(display.change === "archived" && "line-through opacity-60")}>
        <TransactionLine t={display.transaction} />
      </div>
      {display.transaction.project && (
        <p className="text-[12.5px] text-faint">
          {t.finance.project}: {display.transaction.project}
        </p>
      )}
    </motion.section>
  );
}

export function FinanceListCard({
  display,
  rise,
}: {
  display: D<"finance_accounts"> | D<"finance_categories">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const items =
    display.kind === "finance_accounts"
      ? display.accounts.map((a) => ({
          id: a.id,
          label: a.currency ? `${a.name} · ${a.currency}` : a.name,
        }))
      : display.categories.map((c) => ({
          id: c.id,
          label: c.parent ? `${c.parent} › ${c.name}` : c.name,
        }));
  if (!items.length) return null;
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Header
        label={display.kind === "finance_accounts" ? t.finance.accounts : t.finance.category}
      />
      <ul className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <li key={i.id} className="rounded-full bg-surface-2 px-3 py-1 text-[13px] text-muted">
            {i.label}
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

/** ADR-101: each account's recorded balance, per currency, with where the number comes from. */
export function FinanceBalancesCard({
  display,
  rise,
}: {
  display: D<"finance_balances">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const day = useDay();
  if (!display.balances.length) return null;
  const b = t.finance.balance;
  return (
    <motion.section {...rise} aria-label={b.title} className={CARD}>
      <Header label={`${t.finance.title} · ${b.title} · ${b.asOf(day(display.asOf))}`} />
      <ul className="flex flex-col divide-y divide-border">
        {display.balances.map(({ account, rows, beforeOpening }) => (
          <li key={account.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-medium">{account.name}</span>
              <span className="flex flex-col items-end font-mono text-[15px]">
                {beforeOpening ? (
                  <span className="font-sans text-[12.5px] text-faint">—</span>
                ) : rows.length ? (
                  rows.map((r) => (
                    <span
                      key={r.currency}
                      className={cn(compareAmounts(r.balance, "0") < 0 && "text-danger-text")}
                    >
                      {money(r.balance, r.currency)}
                    </span>
                  ))
                ) : (
                  <span>{account.currency ? money("0", account.currency) : "0"}</span>
                )}
              </span>
            </div>
            {beforeOpening && <p className="text-[12.5px] text-faint">{b.beforeOpening}</p>}
            {!beforeOpening && account.openingBalanceSet === false && (
              <p className="text-[12.5px] text-faint">{b.openingUnset}</p>
            )}
            {rows
              .filter((r) => r.pendingCount > 0)
              .map((r) => (
                <p key={r.currency} className="text-[12.5px] text-faint">
                  {b.pending(r.pendingCount, money(r.pending, r.currency))}
                </p>
              ))}
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-faint">{b.provenance}</p>
    </motion.section>
  );
}

export function FinanceBooksCard({
  display,
  rise,
}: {
  display: D<"finance_books">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  if (!display.books.length) return null;
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Header label={t.finance.ws.books} />
      <ul className="flex flex-wrap gap-1.5">
        {display.books.map((b) => (
          <li key={b.id}>
            <Link
              href={`/my-elise/finance?book=${b.id}`}
              className="rounded-full bg-surface-2 px-3 py-1 text-[13px] text-muted hover:text-fg"
            >
              {b.name}
              {b.isDefault ? " ✓" : ""}
            </Link>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

/** Spent / budget per category, flagged at 80% and over 100% (numbers from ELISE). */
export function FinanceBudgetsCard({
  display,
  rise,
}: {
  display: D<"finance_budgets">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const money = useMoney();
  if (!display.budgets.length) return null;
  return (
    <motion.section {...rise} aria-label={t.finance.title} className={CARD}>
      <Link
        href="/my-elise/finance?tab=budgets"
        className="type-label text-faint hover:text-accent-text"
      >
        {t.finance.ws.tabs.budgets} · {display.month}
      </Link>
      <ul className="flex flex-col gap-2.5">
        {display.budgets.map((u) => (
          <li key={u.id} className="flex flex-col gap-1 text-[13.5px]">
            <span className="flex justify-between gap-3">
              <span className="truncate">
                {[u.category, u.subcategory, u.book].filter(Boolean).join(" · ")}
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-[12.5px]",
                  u.state === "over"
                    ? "text-danger-text"
                    : u.state === "warning"
                      ? "text-approval-text"
                      : "text-muted",
                )}
              >
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
    </motion.section>
  );
}

/** The report's headline per currency plus its preview and PDF links. */
export function FinanceReportCard({
  display,
  rise,
}: {
  display: D<"finance_report">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const period = usePeriodLabel();
  const r = display.report;
  return (
    <motion.section {...rise} aria-label={t.finance.reports.title} className={CARD}>
      <Header label={t.finance.reports.title} />
      <p className="text-[14px] text-muted">
        {period(r.period)} · {r.book ?? t.finance.reports.allBooks}
      </p>
      {r.totals.length > 0 ? (
        <CurrencyTotals totals={r.totals} />
      ) : (
        <p className="text-[13.5px] text-muted">{t.finance.reports.noTransactions}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <a
          href={display.pdfUrl}
          download
          className="rounded-full bg-fg px-3.5 py-1.5 text-[13px] text-bg hover:opacity-90"
        >
          {t.finance.reports.download}
        </a>
        <Link
          href={display.previewUrl}
          className="rounded-full bg-surface-2 px-3.5 py-1.5 text-[13px] text-muted hover:text-fg"
        >
          {t.finance.reports.configure}
        </Link>
      </div>
    </motion.section>
  );
}
