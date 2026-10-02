"use client";

import { ArrowDownRight, ArrowUpRight, FileSpreadsheet, Plus, Search, Wallet } from "lucide-react";
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
  PERIODS,
  type AccountType,
  type FinanceAccount,
  type FinanceCategory,
  type FinanceTransaction,
  type GroupTotal,
} from "@/core/capabilities/finance";
import { compareAmounts } from "@/core/finance/money";
import { useInsightText } from "@/features/chat/finance-cards";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction, setDefaultCurrencyAction } from "./actions";
import { COMMON_CURRENCIES, share, useDay, useMoney, useMonth, usePeriodLabel } from "./format";
import { TransactionDialog } from "./transaction-dialog";

function useFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };
  return { params, set };
}

/** One card per currency: never a merged total across currencies. */
function CurrencyCards({ overview }: { overview: FinanceOverview }) {
  const { t } = useI18n();
  const money = useMoney();
  const { totals } = overview.summary.current;
  return (
    <div className="flex flex-col gap-2">
      <ul className={cn("grid gap-3", totals.length > 1 && "md:grid-cols-2")}>
        {totals.map((c) => {
          const change = overview.summary.changes.find((x) => x.currency === c.currency);
          return (
            <li
              key={c.currency}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4"
            >
              <span className="type-label text-faint">{c.currency}</span>
              <dl className="grid grid-cols-3 gap-3">
                {(
                  [
                    ["income", c.income, change?.income ?? null],
                    ["expenses", c.expense, change?.expense ?? null],
                    ["net", c.net, null],
                  ] as const
                ).map(([key, value, pct]) => (
                  <div key={key} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-[12.5px] text-muted">{t.finance[key]}</dt>
                    <dd
                      className={cn(
                        "truncate font-mono text-[15px] md:text-[17px]",
                        key === "income" && "text-success",
                        key === "net" && value.startsWith("-") && "text-danger-text",
                      )}
                      title={money(value, c.currency)}
                    >
                      {money(value, c.currency)}
                    </dd>
                    {pct !== null && (
                      <span className="text-[12px] text-faint">
                        {t.finance.change(pct)} {t.finance.vsPrevious}
                      </span>
                    )}
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
      {totals.length > 1 && (
        <p className="text-[12.5px] text-faint">{t.finance.separateCurrencies}</p>
      )}
    </div>
  );
}

/** Income vs expenses per month for one currency. Plain bars, computed data only. */
function MonthlyChart({ groups, currency }: { groups: GroupTotal[]; currency: string }) {
  const { t } = useI18n();
  const money = useMoney();
  const month = useMonth();
  const mine = groups.filter((g) => g.currency === currency);
  const months = [...new Set(mine.map((g) => g.key))].sort().slice(-6);
  const max = mine.reduce((m, g) => (compareAmounts(g.total, m) > 0 ? g.total : m), "0");
  const value = (m: string, type: "income" | "expense") =>
    mine.find((g) => g.key === m && g.type === type)?.total ?? "0";
  if (!months.length) return null;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
      <h2 className="type-label text-faint">
        {t.finance.overTime} · {currency}
      </h2>
      <ul className="flex h-36 items-end gap-3">
        {months.map((m) => {
          const income = value(m, "income");
          const expense = value(m, "expense");
          return (
            <li
              key={m}
              className="flex flex-1 flex-col items-center gap-1.5"
              aria-label={`${month(m)}: ${t.finance.income} ${money(income, currency)}, ${t.finance.expenses} ${money(expense, currency)}`}
            >
              <span className="flex h-28 w-full items-end justify-center gap-1" aria-hidden>
                <span
                  className="w-2.5 rounded-t bg-success/80 md:w-3.5"
                  style={{ height: `${share(income, max)}%` }}
                  title={money(income, currency)}
                />
                <span
                  className="w-2.5 rounded-t bg-accent md:w-3.5"
                  style={{ height: `${share(expense, max)}%` }}
                  title={money(expense, currency)}
                />
              </span>
              <span className="text-[11.5px] text-faint capitalize">{month(m)}</span>
            </li>
          );
        })}
      </ul>
      <p className="flex gap-4 text-[12px] text-faint" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-success/80" />
          {t.finance.income}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-accent" />
          {t.finance.expenses}
        </span>
      </p>
    </section>
  );
}

function CategoryChart({ groups, currency }: { groups: GroupTotal[]; currency: string }) {
  const { t } = useI18n();
  const money = useMoney();
  const rows = groups.filter((g) => g.type === "expense" && g.currency === currency).slice(0, 7);
  if (!rows.length) return null;
  const max = rows[0]!.total;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
      <h2 className="type-label text-faint">
        {t.finance.byCategory} · {currency}
      </h2>
      <ul className="flex flex-col gap-2.5">
        {rows.map((g) => (
          <li key={g.key} className="flex flex-col gap-1 text-[13.5px]">
            <span className="flex justify-between gap-3">
              <span className="truncate">{g.key}</span>
              <span className="shrink-0 font-mono text-[12.5px] text-muted">
                {money(g.total, currency)}
              </span>
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${share(g.total, max)}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TransactionRow({
  tx,
  onOpen,
}: {
  tx: FinanceTransaction;
  onOpen: (tx: FinanceTransaction) => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const day = useDay();
  const label = tx.counterparty || tx.description || tx.category || "—";
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(tx)}
        className="grid w-full grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-active focus-visible:bg-active focus-visible:outline-none md:grid-cols-[4rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:px-5"
      >
        <span className="font-mono text-[12px] text-faint">{day(tx.date)}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 truncate text-[14px]">
            {tx.type === "income" ? (
              <ArrowDownRight
                className="size-3.5 shrink-0 text-success"
                aria-label={t.finance.types.income}
              />
            ) : (
              <ArrowUpRight
                className="size-3.5 shrink-0 text-muted"
                aria-label={t.finance.types.expense}
              />
            )}
            <span className="truncate">{label}</span>
          </span>
          <span className="block truncate text-[12px] text-faint md:hidden">
            {[
              tx.category,
              tx.account ?? tx.paymentMethod,
              tx.provenance.source !== "ELISE Finance" ? tx.provenance.source : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {tx.status !== "completed" && (
            <span className="text-[12px] text-approval-text">{t.finance.statuses[tx.status]}</span>
          )}
        </span>
        <span className="hidden truncate text-[13px] text-muted md:block">
          {tx.category ?? "—"}
        </span>
        <span className="hidden truncate text-[13px] text-muted md:block">
          {tx.account ?? tx.paymentMethod ?? (tx.readOnly ? tx.provenance.source : "—")}
        </span>
        <span className={cn("font-mono text-[13.5px]", tx.type === "income" && "text-success")}>
          {tx.type === "income" ? "+" : "−"}
          {money(tx.amount, tx.currency)}
        </span>
      </button>
    </li>
  );
}

function ReadOnlyDialog({ tx, onClose }: { tx: FinanceTransaction | null; onClose: () => void }) {
  const { t } = useI18n();
  const money = useMoney();
  return (
    <Dialog
      open={tx !== null}
      onClose={onClose}
      title={tx?.counterparty || tx?.description || t.finance.transactions}
      description={t.finance.readOnly}
    >
      {tx && (
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[14px]">
          <dt className="text-muted">{t.finance.amount}</dt>
          <dd className="font-mono">{money(tx.amount, tx.currency)}</dd>
          <dt className="text-muted">{t.finance.date}</dt>
          <dd>{tx.date}</dd>
          <dt className="text-muted">{t.finance.category}</dt>
          <dd>{tx.category ?? "—"}</dd>
          <dt className="text-muted">{t.finance.sources}</dt>
          <dd>
            {tx.provenance.source}
            {tx.provenance.row ? ` · ${t.finance.wizard.row(tx.provenance.row)}` : ""}
          </dd>
        </dl>
      )}
    </Dialog>
  );
}

function AccountDialog({
  open,
  onClose,
  account,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing. */
  account: FinanceAccount | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("credit_card");
  const [currency, setCurrency] = useState("");
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const marker = open ? (account?.id ?? "new") : null;
  if (marker !== openedFor) {
    setOpenedFor(marker);
    if (marker) {
      setName(account?.name ?? "");
      setType(account?.type ?? "credit_card");
      setCurrency(account?.currency ?? "");
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
  const period = usePeriodLabel();
  const insight = useInsightText();
  const { params, set } = useFilters();
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

  const s = overview.summary;
  const currencies = s.current.totals.map((c) => c.currency);
  const [chartCurrency, setChartCurrency] = useState<string | null>(null);
  const shown = chartCurrency && currencies.includes(chartCurrency) ? chartCurrency : currencies[0];
  const filtered = Boolean(
    overview.filters.q ||
    overview.filters.type ||
    overview.filters.category ||
    overview.filters.account ||
    overview.filters.currency ||
    overview.filters.source,
  );
  const empty = !filtered && s.current.count === 0 && overview.transactions.length === 0;

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
        defaultCurrency={overview.settings.defaultCurrency ?? currencies[0] ?? null}
        today={today}
      />
      <ReadOnlyDialog tx={viewing} onClose={() => setViewing(null)} />
      <AccountDialog
        open={accountOpen || accountEditing !== null}
        account={accountEditing}
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
      <Select
        aria-label={t.finance.period}
        value={overview.filters.period}
        onChange={(e) => set({ period: e.target.value === "this_month" ? null : e.target.value })}
        className="h-10 w-auto"
      >
        {PERIODS.map((p) => (
          <option key={p} value={p}>
            {t.finance.periods[p]}
          </option>
        ))}
      </Select>
      <Link href="/my-elise/finance/sources" className={buttonVariants({ variant: "secondary" })}>
        <FileSpreadsheet />
        {t.finance.sources}
      </Link>
      <Button onClick={() => setAdding(true)}>
        <Plus />
        {t.finance.add}
      </Button>
    </div>
  );

  if (empty && overview.filters.period === "this_month") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex justify-end">{actions}</div>
        <EmptyState
          icon={Wallet}
          title={t.finance.emptyTitle}
          body={t.finance.emptyBody}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setAdding(true)}>
                <Plus />
                {t.finance.add}
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
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-muted">{period(s.period)}</p>
        {actions}
      </div>

      {s.current.totals.length > 0 ? (
        <CurrencyCards overview={overview} />
      ) : (
        <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
          {t.finance.nothingMatches}
        </p>
      )}
      {(s.current.excluded.pending > 0 || s.truncated) && (
        <p className="-mt-5 text-[12.5px] text-faint">
          {s.current.excluded.pending > 0 && t.finance.excluded(s.current.excluded.pending)}
          {s.truncated && ` ${t.finance.partial}`}
        </p>
      )}

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

      {shown && (
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
                  className={cn(
                    "h-8 rounded-full px-3 text-[13px] transition-colors",
                    c === shown ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <MonthlyChart groups={overview.trend.groups} currency={shown} />
            <CategoryChart groups={s.current.byCategory} currency={shown} />
          </div>
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
                });
              }}
            >
              {t.finance.clearFilters}
            </Button>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
          <div className="relative sm:col-span-2 lg:col-span-1">
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
          </Select>
          <Select
            aria-label={t.finance.category}
            value={params.get("category") ?? ""}
            onChange={(e) => set({ category: e.target.value || null })}
          >
            <option value="">{t.finance.allCategories}</option>
            {overview.categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
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
        </div>
        {overview.transactions.length === 0 ? (
          <p className="px-1 py-4 text-[14px] text-muted">{t.finance.nothingMatches}</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
            {overview.transactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                onOpen={(x) => (x.readOnly ? setViewing(x) : setEditing(x))}
              />
            ))}
          </ul>
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
            {overview.accounts.map((a) => (
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
                  </span>
                </button>
              </li>
            ))}
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
      {dialogs}
    </div>
  );
}
