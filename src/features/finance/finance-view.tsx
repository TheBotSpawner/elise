"use client";

import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Plus,
  Search,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import type { FinanceOverview } from "@/application/finance-service";
import { EmptyState } from "@/components/shared/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  UNCLASSIFIED,
  type AccountType,
  type BudgetUsage,
  type FinanceAccount,
  type FinanceBook,
  type FinanceCategory,
  type FinanceTransaction,
  type GroupTotal,
  type PeriodPreset,
} from "@/core/capabilities/finance";
import { compareAmounts } from "@/core/finance/money";
import { resolvePeriod, shiftPeriod } from "@/core/periods";
import { financeTrendVisual, type VisualizationSpec } from "@/core/workspace/visualization";
import { useInsightText } from "@/features/chat/finance-cards";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction, setDefaultCurrencyAction } from "./actions";
import { COMMON_CURRENCIES, share, useMoney, usePeriodLabel } from "./format";
import { TransactionDialog } from "./transaction-dialog";

/**
 * Finance Workspace (ADR-052): Book selector, period navigation, KPIs per currency, then
 * Movements / Analysis / Budgets (Reports opens its own page). Every number comes from the
 * Finance tools; the screen never adds currencies or does its own arithmetic on totals.
 */

const PRESETS: PeriodPreset[] = [
  "this_month",
  "last_month",
  "last_30_days",
  "last_90_days",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
];

function useFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const set = (patch: Record<string, string | null>) => {
    // The live URL, not this render's copy: a delayed call (search debounce) must not undo a
    // change made in between (tab, Book, period).
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };
  return { params, set };
}

const chip = (active: boolean) =>
  cn(
    "h-8 shrink-0 rounded-full px-3 text-[13px] transition-colors",
    active ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg",
  );

function BookSelector({ books, value }: { books: FinanceBook[]; value: string | undefined }) {
  const { t } = useI18n();
  const { set } = useFilters();
  if (!books.length) return null;
  const options: [string | null, string][] = [
    [null, t.finance.ws.allBooks],
    ...books.map((b) => [b.id, b.name] as [string, string]),
    [UNCLASSIFIED, t.finance.ws.unclassified],
  ];
  return (
    <div
      role="radiogroup"
      aria-label={t.finance.ws.book}
      className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
    >
      {options.map(([id, name]) => (
        <button
          key={id ?? "all"}
          type="button"
          role="radio"
          aria-checked={(value ?? null) === id}
          onClick={() => set({ book: id })}
          className={chip((value ?? null) === id)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function PeriodBar({ overview, today }: { overview: FinanceOverview; today: string }) {
  const { t } = useI18n();
  const label = usePeriodLabel();
  const { set } = useFilters();
  const [from, setFrom] = useState(overview.period.from);
  const [to, setTo] = useState(overview.period.to);
  // Date pickers only when asked for; ‹ › keep the bar compact.
  const [custom, setCustom] = useState(false);
  const go = (dir: -1 | 1) => {
    const p = shiftPeriod(overview.period, dir);
    set({ period: null, from: p.from, to: p.to });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" aria-label={t.finance.ws.prev} onClick={() => go(-1)}>
          <ChevronLeft />
        </Button>
        <span className="min-w-36 text-center text-[14px] font-medium">
          {label(overview.period)}
        </span>
        <Button size="sm" variant="ghost" aria-label={t.finance.ws.next} onClick={() => go(1)}>
          <ChevronRight />
        </Button>
      </div>
      <Select
        aria-label={t.finance.period}
        value={
          custom
            ? "custom"
            : // ‹ › onto a whole preset span (e.g. back to this month) shows that preset.
              (PRESETS.find((p) => {
                const x = resolvePeriod(p, today);
                return x.from === overview.period.from && x.to === overview.period.to;
              }) ?? "custom")
        }
        className="h-9 w-auto"
        onChange={(e) => {
          if (e.target.value === "custom") return setCustom(true);
          setCustom(false);
          set({
            period: e.target.value === "this_month" ? null : e.target.value,
            from: null,
            to: null,
          });
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
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to && from <= to) set({ period: null, from, to });
          }}
        >
          <Input
            type="date"
            aria-label={t.finance.ws.from}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-auto"
          />
          <Input
            type="date"
            aria-label={t.finance.ws.to}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-auto"
          />
          <Button size="sm" type="submit" variant="secondary">
            {t.finance.ws.apply}
          </Button>
        </form>
      )}
    </div>
  );
}

/** One card per currency: never a merged total across currencies. */
function CurrencyCards({ overview }: { overview: FinanceOverview }) {
  const { t } = useI18n();
  const money = useMoney();
  const { totals } = overview.summary.current;
  return (
    <ul className={cn("grid gap-3", totals.length > 1 && "md:grid-cols-2 xl:grid-cols-3")}>
      {totals.map((c) => {
        const change = overview.summary.changes.find((x) => x.currency === c.currency);
        return (
          <li
            key={c.currency}
            className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3.5"
          >
            <span className="type-label text-faint">{c.currency}</span>
            <dl className="flex flex-col gap-1.5">
              {(
                [
                  ["income", c.income, change?.income ?? null],
                  ["expenses", c.expense, change?.expense ?? null],
                  ["net", c.net, null],
                ] as const
              ).map(([key, value, pct]) => (
                <div
                  key={key}
                  className={cn(
                    "flex items-baseline justify-between gap-3",
                    key === "net" && "border-t border-border pt-1.5",
                  )}
                >
                  <dt className="text-[12.5px] text-muted">
                    {t.finance[key]}
                    {pct !== null && (
                      <span
                        className="ml-1.5 text-[11.5px] text-faint"
                        title={t.finance.vsPrevious}
                      >
                        {t.finance.change(pct)}
                      </span>
                    )}
                  </dt>
                  <dd
                    className={cn(
                      "font-mono text-[14.5px] whitespace-nowrap md:text-[15.5px]",
                      key === "income" && "text-success",
                      key === "net" && "font-medium",
                      key === "net" && value.startsWith("-") && "text-danger-text",
                    )}
                  >
                    {money(value, c.currency)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function TypeIcon({ type }: { type: FinanceTransaction["type"] }) {
  const { t } = useI18n();
  if (type === "income")
    return (
      <ArrowDownRight
        className="size-3.5 shrink-0 text-success"
        aria-label={t.finance.types.income}
      />
    );
  if (type === "transfer")
    return (
      <ArrowLeftRight
        className="size-3.5 shrink-0 text-muted"
        aria-label={t.finance.types.transfer}
      />
    );
  return (
    <ArrowUpRight className="size-3.5 shrink-0 text-muted" aria-label={t.finance.types.expense} />
  );
}

function signed(tx: FinanceTransaction, money: (a: string, c: string) => string) {
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "−" : "";
  return `${sign}${money(tx.amount, tx.currency)}`;
}

function TransactionRow({
  tx,
  showBook,
  onOpen,
}: {
  tx: FinanceTransaction;
  showBook: boolean;
  onOpen: (tx: FinanceTransaction) => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const label = tx.counterparty || tx.description || tx.category || "—";
  const meta = [
    tx.type === "transfer"
      ? `${tx.account ?? "—"} → ${tx.toAccount ?? "—"}`
      : [tx.category, tx.subcategory].filter(Boolean).join(" › "),
    tx.type !== "transfer" ? (tx.account ?? tx.paymentMethod) : null,
    tx.provenance.source !== "ELISE Finance" ? tx.provenance.source : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(tx)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-active focus-visible:bg-active focus-visible:outline-none md:px-5"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[14px]">
            <TypeIcon type={tx.type} />
            <span className="truncate">{label}</span>
            {showBook && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                {tx.book ?? t.finance.ws.unclassified}
              </span>
            )}
            {tx.status !== "completed" && (
              <span className="bg-approval-soft shrink-0 rounded-full px-2 py-0.5 text-[11px] text-approval-text">
                {t.finance.statuses[tx.status]}
              </span>
            )}
          </span>
          {meta && <span className="block truncate text-[12px] text-faint">{meta}</span>}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[13.5px]",
            tx.type === "income" && "text-success",
            tx.type === "transfer" && "text-muted",
          )}
        >
          {signed(tx, money)}
        </span>
      </button>
    </li>
  );
}

/** Movements grouped by day, newest first. */
function TransactionList({
  rows,
  showBook,
  onOpen,
}: {
  rows: FinanceTransaction[];
  showBook: boolean;
  onOpen: (tx: FinanceTransaction) => void;
}) {
  const { locale } = useI18n();
  const heading = new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const days = new Map<string, FinanceTransaction[]>();
  for (const tx of rows) days.set(tx.date, [...(days.get(tx.date) ?? []), tx]);
  return (
    <div className="flex flex-col gap-4">
      {[...days.entries()].map(([date, txs]) => (
        <section key={date} className="flex flex-col gap-1.5">
          <h3 className="px-1 text-[12.5px] text-faint first-letter:uppercase">
            {heading.format(new Date(`${date}T00:00:00Z`))}
          </h3>
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {txs.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} showBook={showBook} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DetailDialog({
  tx,
  onClose,
  onEdit,
}: {
  tx: FinanceTransaction | null;
  onClose: () => void;
  onEdit: (tx: FinanceTransaction) => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ws = t.finance.ws;
  const run = (tool: string, args: unknown, done: () => void) =>
    startTransition(async () => {
      const r = await financeToolAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        done();
        router.refresh();
      }
    });
  const archive = (x: FinanceTransaction) =>
    run("finance.archiveTransaction", { transaction: x.id }, () => {
      onClose();
      toast.success(t.finance.archived, {
        duration: 10_000,
        action: {
          label: ws.undo,
          onClick: () =>
            void financeToolAction("finance.restoreTransaction", { transaction: x.id }).then(
              (r) => {
                if (r.ok) {
                  toast.success(ws.restored);
                  router.refresh();
                } else toast.error(errorText(t, r.error));
              },
            ),
        },
      });
    });
  const receiptLink = tx?.receipt && /^https?:\/\//i.test(tx.receipt) ? tx.receipt : null;
  const rows: [string, string | null | undefined][] = tx
    ? [
        [t.finance.date, tx.date],
        [t.finance.status, t.finance.statuses[tx.status]],
        [ws.book, tx.book ?? (tx.readOnly ? null : ws.unclassified)],
        [
          t.finance.category,
          tx.type === "transfer"
            ? null
            : [tx.category, tx.subcategory].filter(Boolean).join(" › ") || null,
        ],
        [
          t.finance.account,
          tx.type === "transfer"
            ? `${tx.account ?? "—"} → ${tx.toAccount ?? "—"}`
            : (tx.account ?? tx.paymentMethod),
        ],
        [t.finance.counterparty, tx.counterparty],
        [t.finance.description, tx.description],
        [t.finance.project, tx.project],
        [ws.receipt, receiptLink ? null : tx.receipt],
        [t.finance.notes, tx.notes],
        [
          ws.origin,
          tx.readOnly
            ? `${tx.provenance.source}${tx.provenance.row ? ` · ${t.finance.wizard.row(tx.provenance.row)}` : ""}`
            : tx.origin
              ? ws.origins[tx.origin]
              : null,
        ],
      ]
    : [];
  return (
    <Dialog
      open={tx !== null}
      onClose={onClose}
      busy={pending}
      title={tx ? signed(tx, money) : ws.detail}
      description={
        tx
          ? `${t.finance.types[tx.type]} · ${tx.counterparty || tx.description || tx.category || ""}`
          : undefined
      }
    >
      {tx && (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[14px]">
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-words whitespace-pre-wrap">{v}</dd>
                </div>
              ))}
            {receiptLink && (
              <>
                <dt className="text-muted">{ws.receipt}</dt>
                <dd>
                  <a
                    href={receiptLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent-text underline underline-offset-2"
                  >
                    {ws.openReceipt}
                  </a>
                </dd>
              </>
            )}
          </dl>
          {tx.readOnly ? (
            <p className="text-[13px] text-muted">{t.finance.readOnly}</p>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="ghost"
                className="mr-auto hover:text-danger-text"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(t.finance.archiveConfirm)) archive(tx);
                }}
              >
                {t.finance.archive}
              </Button>
              {tx.status === "pending" && (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(
                      "finance.updateTransaction",
                      { transaction: tx.id, status: "completed" },
                      onClose,
                    )
                  }
                >
                  {ws.markPaid}
                </Button>
              )}
              <Button disabled={pending} onClick={() => onEdit(tx)}>
                {ws.editAction}
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function AccountDialog({
  open,
  onClose,
  account,
  books,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing. */
  account: FinanceAccount | null;
  books: FinanceBook[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("credit_card");
  const [currency, setCurrency] = useState("");
  const [book, setBook] = useState("");
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const marker = open ? (account?.id ?? "new") : null;
  if (marker !== openedFor) {
    setOpenedFor(marker);
    if (marker) {
      setName(account?.name ?? "");
      setType(account?.type ?? "credit_card");
      setCurrency(account?.currency ?? "");
      setBook(books.find((b) => b.id === account?.defaultBookId)?.name ?? "");
    }
  }
  const run = (tool: string, args: unknown) =>
    startTransition(async () => {
      const r = await financeToolAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        router.refresh();
        onClose();
      }
    });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={pending}
      title={account ? t.finance.editAccount : t.finance.addAccount}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (account)
            run("finance.updateAccount", {
              account: account.name,
              name,
              type,
              currency: currency || null,
              ...(books.length ? { book: book || null } : {}),
            });
          else run("finance.createAccount", { name, type, ...(currency ? { currency } : {}) });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="acct-name">{t.finance.accountName}</Label>
          <Input
            id="acct-name"
            data-autofocus=""
            required
            maxLength={80}
            value={name}
            placeholder={t.finance.accountNamePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acct-type">{t.finance.accountType}</Label>
            <Select
              id="acct-type"
              value={type}
              onChange={(e) => setType(e.target.value as AccountType)}
            >
              {(Object.keys(t.finance.accountTypes) as AccountType[]).map((k) => (
                <option key={k} value={k}>
                  {t.finance.accountTypes[k]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acct-currency">{t.finance.currency}</Label>
            <Select
              id="acct-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">{t.finance.anyCurrency}</option>
              {[...new Set([currency, ...COMMON_CURRENCIES].filter(Boolean))].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {account && books.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acct-book">{t.finance.ws.defaultBook}</Label>
            <Select id="acct-book" value={book} onChange={(e) => setBook(e.target.value)}>
              <option value="">{t.finance.ws.noBook}</option>
              {books.map((b) => (
                <option key={b.id} value={b.name}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {account && (
            <Button
              variant="ghost"
              className="mr-auto hover:text-danger-text"
              disabled={pending}
              onClick={() => {
                if (window.confirm(t.finance.archiveAccountConfirm(account.name)))
                  run("finance.updateAccount", { account: account.name, archived: true });
              }}
            >
              {t.finance.archive}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t.finance.cancel}
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {t.finance.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CategoryDialog({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: FinanceCategory[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [type, setType] = useState<"expense" | "income">("expense");
  const [parent, setParent] = useState("");
  return (
    <Dialog open={open} onClose={onClose} busy={pending} title={t.finance.addCategory}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await financeToolAction("finance.createCategory", {
              name,
              type,
              ...(parent ? { parent } : {}),
            });
            if (!r.ok) toast.error(errorText(t, r.error));
            else {
              setName("");
              setParent("");
              router.refresh();
              onClose();
            }
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cat-name">{t.finance.accountName}</Label>
          <Input
            id="cat-name"
            data-autofocus=""
            required
            maxLength={80}
            value={name}
            placeholder={t.finance.categoryPlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-type">{t.finance.accountType}</Label>
            <Select
              id="cat-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as "expense" | "income");
                setParent("");
              }}
            >
              <option value="expense">{t.finance.expenses}</option>
              <option value="income">{t.finance.income}</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-parent">{t.finance.parentCategory}</Label>
            <Select id="cat-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">{t.finance.noParent}</option>
              {categories
                .filter((c) => !c.parentId && (c.type === type || c.type === "both"))
                .map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t.finance.cancel}
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {t.finance.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Ranked, clickable bars (drill-down): one currency, one type. */
function RankedBars({
  title,
  groups,
  currency,
  onPick,
  noneLabel,
}: {
  title: string;
  groups: GroupTotal[];
  currency: string;
  onPick?: (key: string) => void;
  /** Shown for the "—" group (e.g. "Sin categoría"); without it that group is left out. */
  noneLabel?: string;
}) {
  const money = useMoney();
  const { t } = useI18n();
  const rows = groups
    .filter((g) => g.currency === currency && (noneLabel || g.key !== "—"))
    .sort((a, b) => compareAmounts(b.total, a.total))
    .slice(0, 8);
  if (!rows.length) return null;
  const max = rows[0]!.total;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
      <h2 className="type-label text-faint">
        {title} · {currency}
      </h2>
      <ul className="flex flex-col gap-1">
        {rows.map((g) => (
          <li key={g.key}>
            <button
              type="button"
              disabled={!onPick || g.key === "—"}
              onClick={() => onPick?.(g.key)}
              title={onPick ? t.finance.ws.drill : undefined}
              className="flex w-full flex-col gap-1 rounded-lg px-1.5 py-1 text-left text-[13.5px] enabled:hover:bg-active"
            >
              <span className="flex w-full justify-between gap-3">
                <span className="truncate">{g.key === "—" ? noneLabel : g.key}</span>
                <span className="shrink-0 font-mono text-[12.5px] text-muted">
                  {money(g.total, currency)}
                </span>
              </span>
              <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${share(g.total, max)}%` }}
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ spec }: { spec: VisualizationSpec }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-5 py-4">
      <h2 className="type-label text-faint">{spec.title}</h2>
      <Visualization spec={spec} size="medium" />
    </section>
  );
}

function Analysis({ overview, currency }: { overview: FinanceOverview; currency: string }) {
  const { t, locale } = useI18n();
  const { set } = useFilters();
  const ws = t.finance.ws;
  const series = overview.trend.find((s) => s.currency === currency);
  const trend = series ? financeTrendVisual(series, locale) : null;
  const expenses = overview.summary.current.byCategory
    .filter((g) => g.type === "expense" && g.currency === currency)
    .sort((a, b) => compareAmounts(b.total, a.total));
  const top = expenses.slice(0, expenses.length > 6 ? 5 : 6);
  const rest = expenses.slice(top.length).reduce((n, g) => n + Number(g.total), 0);
  const donut: VisualizationSpec | null =
    expenses.length >= 2
      ? {
          type: "donut",
          title: `${ws.expensesByCategory} · ${currency}`,
          format: { kind: "currency", currency },
          rows: [
            ...top.map((g) => ({
              label: (g.key === "—" ? t.finance.noCategory : g.key).slice(0, 60),
              value: Math.round(Number(g.total)),
            })),
            ...(rest > 0 ? [{ label: ws.other, value: Math.round(rest) }] : []),
          ],
        }
      : null;
  const a = overview.analysis;
  const income = (gs: GroupTotal[]) => gs.filter((g) => g.type === "income");
  const expense = (gs: GroupTotal[]) => gs.filter((g) => g.type === "expense");
  const drill = (patch: Record<string, string | null>) => set({ tab: null, ...patch });
  if (!overview.summary.current.count)
    return <p className="px-1 py-4 text-[14px] text-muted">{ws.noData}</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {trend && (
        <div className="lg:col-span-2">
          <Card spec={trend.spec} />
        </div>
      )}
      {donut && <Card spec={donut} />}
      <RankedBars
        title={ws.expensesByCategory}
        groups={expense(overview.summary.current.byCategory)}
        currency={currency}
        noneLabel={t.finance.noCategory}
        onPick={(category) => drill({ category, type: "expense" })}
      />
      <RankedBars
        title={ws.incomeByCategory}
        groups={income(overview.summary.current.byCategory)}
        currency={currency}
        noneLabel={t.finance.noCategory}
        onPick={(category) => drill({ category, type: "income" })}
      />
      {a && (
        <>
          <RankedBars
            title={ws.topClients}
            groups={income(a.counterparties)}
            currency={currency}
            onPick={(q) => drill({ q, type: "income" })}
          />
          <RankedBars
            title={ws.topProviders}
            groups={expense(a.counterparties)}
            currency={currency}
            onPick={(q) => drill({ q, type: "expense" })}
          />
          <RankedBars title={ws.byProject} groups={expense(a.projects)} currency={currency} />
          <RankedBars
            title={`${ws.byBook} · ${t.finance.expenses}`}
            groups={expense(a.books)}
            currency={currency}
            onPick={(name) => {
              const b = overview.books.find((x) => x.name === name);
              drill({ book: b?.id ?? UNCLASSIFIED });
            }}
          />
        </>
      )}
    </div>
  );
}

function Budgets({ overview }: { overview: FinanceOverview }) {
  const { t, locale } = useI18n();
  const money = useMoney();
  const ws = t.finance.ws;
  const b = overview.budgets;
  if (!b || !b.usages.length)
    return (
      <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
        {ws.noBudgets}
      </p>
    );
  const month = new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${b.month}-01T00:00:00Z`));
  const tone = (u: BudgetUsage) =>
    u.state === "over" ? "bg-danger" : u.state === "warning" ? "bg-approval" : "bg-accent";
  return (
    <section className="flex flex-col gap-3">
      <h2 className="type-label text-faint first-letter:uppercase">{ws.budgetMonth(month)}</h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {b.usages.map((u) => (
          <li
            key={u.id}
            className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[14px] font-medium">
                {[u.category, u.subcategory].filter(Boolean).join(" › ")}
                {u.book && !overview.filters.book && (
                  <span className="ml-1.5 text-[12px] font-normal text-faint">{u.book}</span>
                )}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[12px]",
                  u.state === "over"
                    ? "text-danger-text"
                    : u.state === "warning"
                      ? "text-approval-text"
                      : "text-faint",
                )}
              >
                {(u.percentTenths / 10).toFixed(0)}% · {ws.budgetStates[u.state]}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round(u.percentTenths / 10))}
              aria-label={u.category}
            >
              <span
                className={cn("block h-full rounded-full", tone(u))}
                style={{ width: `${Math.min(100, u.percentTenths / 10)}%` }}
              />
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 text-[12.5px] text-muted">
              <span className="font-mono">
                {money(u.spent, u.currency)} / {money(u.amount, u.currency)}
              </span>
              <span>
                {u.remaining.startsWith("-")
                  ? ws.overBy(money(u.remaining.slice(1), u.currency))
                  : ws.left(money(u.remaining, u.currency))}
              </span>
            </div>
            {(u.pending > 0 || u.otherCurrencies > 0) && (
              <p className="text-[12px] text-faint">
                {[
                  u.pending ? ws.budgetPending(u.pending) : "",
                  u.otherCurrencies ? ws.budgetOther(u.otherCurrencies) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FinanceView({
  overview,
  workspaceId,
  today,
}: {
  overview: FinanceOverview;
  workspaceId: string;
  today: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const insight = useInsightText();
  const { params, set } = useFilters();
  const ws = t.finance.ws;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [viewing, setViewing] = useState<FinanceTransaction | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountEditing, setAccountEditing] = useState<FinanceAccount | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [q, setQ] = useState(overview.filters.q ?? "");
  const [, startTransition] = useTransition();
  useRealtimeRefresh(workspaceId, [
    "finance_transactions",
    "finance_accounts",
    "finance_categories",
    "finance_sources",
    "imports",
  ]);

  // Search follows typing with a short pause.
  useEffect(() => {
    if ((overview.filters.q ?? "") === q) return;
    const timer = setTimeout(() => set({ q: q.trim() || null }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` is recreated per render
  }, [q]);

  const f = overview.filters;
  const s = overview.summary;
  const currencies = s.current.totals.map((c) => c.currency);
  const [chartCurrency, setChartCurrency] = useState<string | null>(null);
  const shown = chartCurrency && currencies.includes(chartCurrency) ? chartCurrency : currencies[0];
  const filtered = Boolean(
    f.q || f.type || f.category || f.account || f.currency || f.source || f.status,
  );
  const currentBook = overview.books.find((b) => b.id === f.book) ?? null;
  const empty =
    !filtered &&
    !f.book &&
    s.current.count === 0 &&
    overview.transactions.length === 0 &&
    f.period === "this_month";

  const reportQuery = new URLSearchParams({ from: overview.period.from, to: overview.period.to });
  if (currentBook) reportQuery.set("book", currentBook.name);
  for (const k of ["type", "category", "account", "currency"] as const)
    if (f[k]) reportQuery.set(k, f[k]!);

  const dialogs = (
    <>
      <TransactionDialog
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        transaction={editing}
        accounts={overview.accounts}
        categories={overview.categories}
        books={overview.books}
        defaultBook={currentBook?.name ?? null}
        defaultCurrency={overview.settings.defaultCurrency ?? currencies[0] ?? null}
        today={today}
      />
      <DetailDialog
        tx={viewing}
        onClose={() => setViewing(null)}
        onEdit={(x) => {
          setViewing(null);
          setEditing(x);
        }}
      />
      <AccountDialog
        open={accountOpen || accountEditing !== null}
        account={accountEditing}
        books={overview.books}
        onClose={() => {
          setAccountOpen(false);
          setAccountEditing(null);
        }}
      />
      <CategoryDialog
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        categories={overview.categories}
      />
    </>
  );

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Link href="/my-elise/finance/sources" className={buttonVariants({ variant: "secondary" })}>
        <FileSpreadsheet />
        {t.finance.sources}
      </Link>
      <Button onClick={() => setAdding(true)}>
        <Plus />
        {ws.quickAdd}
      </Button>
    </div>
  );

  // Dialogs stay at one place in the tree: a refresh that swaps the empty state for the list
  // must not remount (and wipe) a form the user is typing in.
  const emptyBody = (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BookSelector books={overview.books} value={f.book} />
        {actions}
      </div>
      <EmptyState
        icon={Wallet}
        title={t.finance.emptyTitle}
        body={t.finance.emptyBody}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setAdding(true)}>
              <Plus />
              {ws.quickAdd}
            </Button>
            <Link
              href="/my-elise/finance/sources"
              className={buttonVariants({ variant: "secondary" })}
            >
              {t.finance.importFile}
            </Link>
          </div>
        }
      />
    </div>
  );

  const tabs = (["movements", "analysis", "budgets"] as const).map((k) => (
    <button
      key={k}
      type="button"
      role="tab"
      aria-selected={f.tab === k}
      onClick={() => set({ tab: k === "movements" ? null : k })}
      className={cn(
        "-mb-px h-10 shrink-0 border-b-2 px-1 text-[14px] transition-colors",
        f.tab === k
          ? "border-fg font-medium text-fg"
          : "border-transparent text-muted hover:text-fg",
      )}
    >
      {ws.tabs[k]}
    </button>
  ));

  const body = empty ? (
    emptyBody
  ) : (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BookSelector books={overview.books} value={f.book} />
        {actions}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border">
        <div role="tablist" aria-label={t.finance.title} className="flex gap-5 overflow-x-auto">
          {tabs}
          <Link
            href={`/my-elise/finance/reports?${reportQuery.toString()}`}
            className="-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-1 text-[14px] text-muted hover:text-fg"
          >
            <FileText className="size-4" aria-hidden />
            {ws.tabs.reports}
          </Link>
        </div>
      </div>

      <PeriodBar
        key={`${overview.period.from}|${overview.period.to}`}
        overview={overview}
        today={today}
      />

      {s.current.totals.length > 0 ? (
        <CurrencyCards overview={overview} />
      ) : (
        <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
          {t.finance.nothingMatches}
        </p>
      )}
      {(s.current.excluded.pending > 0 || s.truncated || (s.current.transfers ?? 0) > 0) && (
        <p className="-mt-3 text-[12.5px] text-faint">
          {[
            s.current.excluded.pending > 0 ? t.finance.excluded(s.current.excluded.pending) : "",
            s.current.transfers ? ws.transfers(s.current.transfers) : "",
            currencies.length > 1 ? t.finance.separateCurrencies : "",
            s.truncated ? t.finance.partial : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}

      {f.tab === "movements" && (
        <>
          {s.insights.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="type-label text-faint">{t.finance.insights}</h2>
              <ul className="flex flex-col gap-1.5 text-[14px]">
                {s.insights.map((i, n) => (
                  <li key={n} className="flex gap-2">
                    <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                    {insight(i)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="type-label text-faint">
                {t.finance.transactions} · {t.finance.matching(overview.matching)}
              </h2>
              {filtered && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQ("");
                    set({
                      q: null,
                      type: null,
                      category: null,
                      account: null,
                      currency: null,
                      source: null,
                      status: null,
                    });
                  }}
                >
                  {t.finance.clearFilters}
                </Button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              <div className="relative sm:col-span-2 md:col-span-3">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
                  aria-hidden
                />
                <Input
                  aria-label={t.finance.search}
                  placeholder={t.finance.search}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                aria-label={t.finance.types.expense}
                value={params.get("type") ?? ""}
                onChange={(e) => set({ type: e.target.value || null })}
              >
                <option value="">{t.finance.all}</option>
                <option value="expense">{t.finance.expenses}</option>
                <option value="income">{t.finance.income}</option>
                <option value="transfer">{t.finance.types.transfer}</option>
              </Select>
              <Select
                aria-label={t.finance.category}
                value={params.get("category") ?? ""}
                onChange={(e) => set({ category: e.target.value || null })}
              >
                <option value="">{t.finance.allCategories}</option>
                {[...new Set([f.category, ...overview.categories.map((c) => c.name)])]
                  .filter(Boolean)
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </Select>
              <Select
                aria-label={t.finance.account}
                value={params.get("account") ?? ""}
                onChange={(e) => set({ account: e.target.value || null })}
              >
                <option value="">{t.finance.allAccounts}</option>
                {overview.accounts.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t.finance.currency}
                value={params.get("currency") ?? ""}
                onChange={(e) => set({ currency: e.target.value || null })}
              >
                <option value="">{t.finance.allCurrencies}</option>
                {[...new Set([...currencies, ...COMMON_CURRENCIES])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t.finance.status}
                value={f.status ?? ""}
                onChange={(e) => set({ status: e.target.value || null })}
              >
                <option value="">{t.finance.all}</option>
                <option value="pending">{ws.pendingOnly}</option>
              </Select>
            </div>
            {overview.transactions.length === 0 ? (
              <p className="px-1 py-4 text-[14px] text-muted">{t.finance.nothingMatches}</p>
            ) : (
              <>
                <TransactionList
                  rows={overview.transactions}
                  showBook={!f.book && overview.books.length > 0}
                  onOpen={setViewing}
                />
                {overview.matching > overview.transactions.length && (
                  <p className="px-1 text-[12.5px] text-faint">
                    {ws.more(overview.matching - overview.transactions.length)}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="type-label text-faint">{t.finance.accounts}</h2>
              <Button size="sm" variant="ghost" onClick={() => setAccountOpen(true)}>
                <Plus />
                {t.finance.addAccount}
              </Button>
            </div>
            {overview.accounts.length === 0 ? (
              <p className="text-[13.5px] text-muted">{t.finance.noAccounts}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {overview.accounts.map((a) => {
                  const book = overview.books.find((b) => b.id === a.defaultBookId);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setAccountEditing(a)}
                        aria-label={`${t.finance.editAccount}: ${a.name}`}
                        className="rounded-full bg-surface-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-active"
                      >
                        {a.name}
                        <span className="text-faint">
                          {" · "}
                          {t.finance.accountTypes[a.type]}
                          {a.currency ? ` · ${a.currency}` : ""}
                          {book ? ` · ${book.name}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Label htmlFor="default-currency">{t.finance.defaultCurrency}</Label>
              <Select
                id="default-currency"
                value={overview.settings.defaultCurrency ?? ""}
                className="h-9 w-auto"
                onChange={(e) =>
                  startTransition(async () => {
                    const r = await setDefaultCurrencyAction(e.target.value || null);
                    if (!r.ok) toast.error(errorText(t, r.error));
                    else router.refresh();
                  })
                }
              >
                <option value="">{t.finance.notSet}</option>
                {COMMON_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <span className="text-[12.5px] text-faint">{t.finance.defaultCurrencyHint}</span>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="type-label text-faint">{t.finance.categories}</h2>
              <Button size="sm" variant="ghost" onClick={() => setCategoryOpen(true)}>
                <Plus />
                {t.finance.addCategory}
              </Button>
            </div>
            {(["expense", "income"] as const).map((type) => {
              const list = overview.categories.filter((c) => c.type === type || c.type === "both");
              if (!list.length) return null;
              return (
                <div key={type} className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] text-faint">
                    {type === "expense" ? t.finance.expenses : t.finance.income}
                  </span>
                  <ul className="flex flex-wrap gap-1.5">
                    {list.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => set({ category: c.name })}
                          className="rounded-full bg-surface-2 px-3 py-1 text-[13px] text-muted transition-colors hover:text-fg"
                        >
                          {c.parent ? `${c.parent} › ${c.name}` : c.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        </>
      )}

      {f.tab === "analysis" && shown && (
        <section className="flex flex-col gap-3">
          {currencies.length > 1 && (
            <div role="radiogroup" aria-label={t.finance.currency} className="flex gap-1.5">
              {currencies.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === shown}
                  onClick={() => setChartCurrency(c)}
                  className={chip(c === shown)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <Analysis overview={overview} currency={shown} />
        </section>
      )}
      {f.tab === "analysis" && !shown && (
        <p className="px-1 py-4 text-[14px] text-muted">{ws.noData}</p>
      )}

      {f.tab === "budgets" && <Budgets overview={overview} />}
    </div>
  );
  return (
    <>
      {body}
      {dialogs}
    </>
  );
}
