"use client";

import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Combine,
  FileText,
  ListChecks,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import type { FinanceGranularity, FinanceOverview } from "@/application/finance-service";
import { Button, buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { FilterButton, FilterSheet, OverflowMenu } from "@/components/ui/sheet-menu";
import {
  UNCLASSIFIED,
  type AccountType,
  type BudgetUsage,
  type FinanceAccount,
  type FinanceBook,
  type FinanceCategory,
  type FinanceTransaction,
  type GroupTotal,
} from "@/core/capabilities/finance";
import { planCombine } from "@/core/finance/combine";
import { addAmounts, compareAmounts, impliedRate } from "@/core/finance/money";
import { shiftPeriod, type Period } from "@/core/periods";
import { financeTrendVisual, type VisualizationSpec } from "@/core/workspace/visualization";
import { Menu } from "@/features/native/native-ui";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction, matchingIdsAction, setDefaultCurrencyAction } from "./actions";
import { budgetLook, Budgets } from "./budgets";
import { CategoryManager } from "./category-manager";
import { CombineDialog } from "./combine-dialog";
import { COMMON_CURRENCIES, share, useMoney, usePeriodLabel } from "./format";
import { MovementMenu, useLongPress, type MovementMenuState } from "./movement-menu";
import { categoryIcon, TransactionDialog } from "./transaction-dialog";

/**
 * Finance workspace (ADR-052, ADR-054). The shell — Ámbito filter, Movimientos / Estadísticas /
 * Presupuestos / Reportes, Día–Año navigation, KPIs per currency — is always on screen, with or
 * without results. Every number comes from the Finance tools; the screen never mixes currencies
 * or does its own arithmetic on totals (day totals add same-currency amounts exactly).
 */

type T = ReturnType<typeof useI18n>["t"];

function useFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const set = (patch: Record<string, string | null>) => {
    // The live URL: a delayed call (search debounce) never undoes a change made in between.
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };
  return { set };
}

const chip = (active: boolean) =>
  cn(
    "h-10 shrink-0 rounded-full px-3.5 text-[14px] transition-colors md:h-8 md:px-3 md:text-[13px]",
    active ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg",
  );

const CARD = "rounded-2xl border border-border bg-surface";

function useLabels() {
  const { locale } = useI18n();
  const loc = locale === "es" ? "es-AR" : "en-US";
  const f = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(loc, { ...o, timeZone: "UTC" });
  const at = (d: string) => new Date(`${d}T00:00:00Z`);
  const dayLong = f({ weekday: "long", day: "numeric", month: "long" });
  const dayMonth = f({ day: "numeric", month: "short" });
  const monthYear = f({ month: "long", year: "numeric" });
  const month = f({ month: "long" });
  const period = usePeriodLabel();
  return {
    span(gran: FinanceGranularity | "custom", p: Period) {
      if (gran === "day") return dayLong.format(at(p.from));
      if (gran === "month") return monthYear.format(at(p.from));
      if (gran === "year") return p.from.slice(0, 4);
      if (gran === "week")
        return p.from.slice(0, 7) === p.to.slice(0, 7)
          ? `${Number(p.from.slice(8))}–${dayMonth.format(at(p.to))}`
          : `${dayMonth.format(at(p.from))} – ${dayMonth.format(at(p.to))}`;
      return period(p);
    },
    /** "octubre" for "No hay movimientos en octubre". */
    short(gran: FinanceGranularity | "custom", p: Period) {
      return gran === "month" ? month.format(at(p.from)) : this.span(gran, p);
    },
    dayMonth: (d: string) => dayMonth.format(at(d)),
  };
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type FinanceSection = "movements" | "analysis" | "budgets" | "reports";

/** Movimientos · Estadísticas · Presupuestos · Reportes — the same row on every Finance page. */
export function FinanceNav({
  active,
  onSelect,
  reportsHref,
}: {
  active: FinanceSection;
  /** In the workspace, tabs switch in place; elsewhere they link to it. */
  onSelect?: (s: Exclude<FinanceSection, "reports">) => void;
  reportsHref: string;
}) {
  const { t } = useI18n();
  const n = t.finance.v21.tabs;
  const item = (key: FinanceSection) =>
    cn(
      "flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-1 text-[14px] transition-colors",
      active === key
        ? "border-accent font-medium text-fg"
        : "border-transparent text-muted hover:text-fg",
    );
  const tabs: [Exclude<FinanceSection, "reports">, string][] = [
    ["movements", n.movements],
    ["analysis", n.stats],
    ["budgets", n.budgets],
  ];
  return (
    // The baseline is an inset shadow, not a border the tabs overlap with -mb-px: that 1px of
    // vertical overflow made overflow-x-auto show a vertical scrollbar (its arrows on Windows).
    <nav
      aria-label={t.finance.title}
      className="no-scrollbar flex gap-5 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--line)] md:gap-6"
    >
      {tabs.map(([key, label]) =>
        onSelect ? (
          <button
            key={key}
            type="button"
            aria-current={active === key ? "page" : undefined}
            onClick={() => onSelect(key)}
            className={item(key)}
          >
            {label}
          </button>
        ) : (
          <Link
            key={key}
            href={key === "movements" ? "/my-elise/finance" : `/my-elise/finance?tab=${key}`}
            className={item(key)}
          >
            {label}
          </Link>
        ),
      )}
      <Link
        href={reportsHref}
        aria-current={active === "reports" ? "page" : undefined}
        className={item("reports")}
      >
        <FileText className="size-4" aria-hidden />
        {n.reports}
      </Link>
    </nav>
  );
}

/** "1 USD = 1250 ARS" for a cross-currency transfer (ADR-089). */
function rateText(tx: FinanceTransaction): string | null {
  if (!tx.toAmount || !tx.toCurrency) return null;
  const r = impliedRate(
    { amount: tx.amount, currency: tx.currency },
    { amount: tx.toAmount, currency: tx.toCurrency },
  );
  return r
    ? `1 ${r.base} = ${Number(r.rate).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${r.quote}`
    : null;
}

/** Every Ámbito of a movement (ADR-087): "Personal + Empresa". */
const bookLabel = (tx: FinanceTransaction) =>
  tx.books?.length ? tx.books.join(" + ") : (tx.book ?? null);

function ScopeChips({ books, value }: { books: FinanceBook[]; value: string | undefined }) {
  const { t } = useI18n();
  const { set } = useFilters();
  const [creating, setCreating] = useState(false);
  const visible = books.slice(0, 4);
  const rest = books.slice(4);
  const options: [string | null, string][] = [
    [null, t.finance.ws.allBooks],
    ...visible.map((b) => [b.id, `${b.icon ? `${b.icon} ` : ""}${b.name}`] as [string, string]),
  ];
  return (
    // Phones (ADR-066): one swipeable rail, edge to edge; wraps from md.
    <div
      role="radiogroup"
      aria-label={t.finance.ws.book}
      className="-mx-4 no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
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
      {rest.length > 0 && (
        <Select
          aria-label={t.finance.v21.more}
          value={rest.some((b) => b.id === value) ? value : ""}
          onChange={(e) => set({ book: e.target.value || null })}
          className="h-8 w-auto rounded-full text-[13px]"
        >
          <option value="">{t.finance.v21.more}…</option>
          {rest.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      )}
      <button
        type="button"
        role="radio"
        aria-checked={value === UNCLASSIFIED}
        onClick={() => set({ book: UNCLASSIFIED })}
        className={chip(value === UNCLASSIFIED)}
      >
        {t.finance.ws.unclassified}
      </button>
      <button
        type="button"
        aria-label={t.finance.v21.newBook}
        title={t.finance.v21.newBook}
        onClick={() => setCreating(true)}
        className="grid size-10 shrink-0 place-items-center rounded-full border border-dashed border-border-strong text-muted hover:text-fg md:size-8"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
      <NewBookDialog open={creating} onClose={() => setCreating(false)} books={books} />
    </div>
  );
}

/** "Nuevo ámbito" (ADR-075): ELISE's own dialog — never the browser's prompt. */
function NewBookDialog({
  open,
  onClose,
  books,
}: {
  open: boolean;
  onClose: () => void;
  books: FinanceBook[];
}) {
  const { t } = useI18n();
  const v = t.finance.v21;
  const { set } = useFilters();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setError(null);
    onClose();
  };
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  return (
    <Dialog open={open} onClose={close} busy={pending} title={v.newBook} className="sm:max-w-md">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          if (books.some((b) => fold(b.name) === fold(trimmed))) return setError(v.bookDuplicate);
          startTransition(async () => {
            const r = await financeToolAction("finance.saveBook", {
              name: trimmed,
              type: "business",
            });
            if (!r.ok)
              return setError(
                r.error.code === "CONFLICT" ? v.bookDuplicate : errorText(t, r.error),
              );
            const created = r.value?.kind === "finance_books" ? r.value.books[0] : undefined;
            close();
            if (created) set({ book: created.id });
            router.refresh();
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-book-name">{v.bookName}</Label>
          <Input
            id="new-book-name"
            data-autofocus
            value={name}
            maxLength={80}
            placeholder={v.bookNamePlaceholder}
            aria-invalid={Boolean(error)}
            aria-describedby="new-book-hint"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            className="h-11"
          />
          <p
            id="new-book-hint"
            className={cn("text-[12.5px]", error ? "text-danger-text" : "text-muted")}
          >
            {error ?? v.newBookHint}
          </p>
        </div>
        <div
          data-sheet-actions
          className="flex justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>button]:w-full"
        >
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {v.createBook}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PeriodBar({ overview }: { overview: FinanceOverview }) {
  const { t } = useI18n();
  const g = t.finance.v21.gran;
  const labels = useLabels();
  const { set } = useFilters();
  const f = overview.filters;
  const custom = f.period === "custom";
  const preset = f.period !== "custom" && f.period !== "span";
  const gran: FinanceGranularity | "custom" = custom || preset ? "custom" : f.gran;
  const [open, setOpen] = useState(custom);
  const [from, setFrom] = useState(overview.period.from);
  const [to, setTo] = useState(overview.period.to);
  const containsToday =
    overview.period.from <= overview.today && overview.today <= overview.period.to;
  const go = (dir: -1 | 1) => {
    const p = shiftPeriod(overview.period, dir);
    if (gran === "custom") set({ period: null, from: p.from, to: p.to });
    else
      set({
        period: null,
        from: null,
        to: null,
        date: p.from <= overview.today && overview.today <= p.to ? null : p.from,
      });
  };
  const [sheet, setSheet] = useState(false);
  const granularity = (
    <div
      role="radiogroup"
      aria-label={t.finance.period}
      className="flex rounded-full bg-surface-2 p-0.5 max-md:w-full max-md:[&>button]:h-10 max-md:[&>button]:flex-1"
    >
      {(["day", "week", "month", "year"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={gran === k}
          onClick={() => {
            setOpen(false);
            setSheet(false);
            set({
              gran: k === "month" ? null : k,
              period: null,
              from: null,
              to: null,
              date: containsToday ? null : overview.period.from,
            });
          }}
          className={cn(
            "h-8 rounded-full px-3 text-[13px] transition-colors",
            gran === k ? "bg-bg font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {g[k]}
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={gran === "custom"}
        onClick={() => setOpen(true)}
        className={cn(
          "h-8 rounded-full px-3 text-[13px] transition-colors",
          gran === "custom" ? "bg-bg font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
        )}
      >
        {g.custom}
      </button>
    </div>
  );
  const range = open && (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (from && to && from <= to) {
          setSheet(false);
          set({ period: null, date: null, from, to });
        }
      }}
    >
      <Input
        type="date"
        aria-label={t.finance.ws.from}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        className="h-11 w-auto max-md:flex-1 md:h-9"
      />
      <Input
        type="date"
        aria-label={t.finance.ws.to}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="h-11 w-auto max-md:flex-1 md:h-9"
      />
      <Button size="sm" type="submit" variant="secondary" className="max-md:h-11 max-md:w-full">
        {t.finance.ws.apply}
      </Button>
    </form>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-1 max-md:w-full max-md:justify-between">
        <Button size="sm" variant="ghost" aria-label={t.finance.ws.prev} onClick={() => go(-1)}>
          <ChevronLeft />
        </Button>
        {/* Phones (ADR-066): the period is one row; tapping it opens day/week/month/year. */}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setSheet(true)}
          className="h-11 min-w-0 flex-1 truncate rounded-full text-center text-[17px] font-medium first-letter:uppercase md:hidden"
        >
          {labels.span(gran, overview.period)}
        </button>
        <span className="hidden min-w-40 text-center text-[17px] font-medium first-letter:uppercase md:inline">
          {labels.span(gran, overview.period)}
        </span>
        <Button size="sm" variant="ghost" aria-label={t.finance.ws.next} onClick={() => go(1)}>
          <ChevronRight />
        </Button>
        {!containsToday && (
          <Button
            size="sm"
            variant="secondary"
            className="max-md:hidden"
            onClick={() => set({ period: null, from: null, to: null, date: null })}
          >
            {t.finance.v21.today}
          </Button>
        )}
      </div>
      <div className="contents max-md:hidden">
        {granularity}
        {range}
      </div>
      <Dialog open={sheet} onClose={() => setSheet(false)} title={t.finance.period}>
        {granularity}
        {range}
        {!containsToday && (
          <Button
            variant="secondary"
            onClick={() => {
              setSheet(false);
              set({ period: null, from: null, to: null, date: null });
            }}
          >
            {t.finance.v21.today}
          </Button>
        )}
      </Dialog>
    </div>
  );
}

/** Ingresos · Gastos · Neto, each with one line per currency (never a merged total). */
function KpiStrip({ overview }: { overview: FinanceOverview }) {
  const { t } = useI18n();
  const money = useMoney();
  const totals = overview.summary.current.totals;
  const cols = [
    ["income", "income"],
    ["expenses", "expense"],
    ["net", "net"],
  ] as const;
  return (
    // Phones (ADR-066): one compact row of three, never three tall cards.
    <dl className={cn(CARD, "grid grid-cols-3 divide-x divide-border")}>
      {cols.map(([label, key]) => (
        <div
          key={key}
          className="flex min-w-0 flex-col gap-1 px-3 py-2.5 md:gap-1.5 md:px-5 md:py-3.5"
        >
          <dt className="type-label text-faint">{t.finance[label]}</dt>
          {totals.length === 0 ? (
            <dd className="font-mono text-[20px] text-faint">—</dd>
          ) : (
            totals.map((c) => {
              const value = c[key];
              const change = overview.summary.changes.find((x) => x.currency === c.currency);
              const pct =
                key === "income" ? change?.income : key === "expense" ? change?.expense : null;
              return (
                <dd
                  key={c.currency}
                  className="flex flex-wrap items-baseline justify-between gap-x-3"
                >
                  <span
                    className={cn(
                      "truncate font-mono text-[15px] whitespace-nowrap md:text-[19px]",
                      key === "income" && "text-success",
                      key === "net" && value.startsWith("-") && "text-danger-text",
                    )}
                  >
                    {money(value, c.currency)}
                  </span>
                  {pct != null && (
                    <span
                      className="text-[11.5px] text-faint max-md:hidden"
                      title={t.finance.vsPrevious}
                    >
                      {t.finance.change(pct)} {t.finance.vsPrevious}
                    </span>
                  )}
                </dd>
              );
            })
          )}
        </div>
      ))}
    </dl>
  );
}

// ── Movements ────────────────────────────────────────────────────────────────

function TypeIcon({ type }: { type: FinanceTransaction["type"] }) {
  const { t } = useI18n();
  const cls = "size-3.5 shrink-0";
  if (type === "income")
    return (
      <ArrowDownRight className={cn(cls, "text-success")} aria-label={t.finance.types.income} />
    );
  if (type === "transfer")
    return (
      <ArrowLeftRight className={cn(cls, "text-muted")} aria-label={t.finance.types.transfer} />
    );
  return <ArrowUpRight className={cn(cls, "text-muted")} aria-label={t.finance.types.expense} />;
}

const signed = (tx: FinanceTransaction, money: (a: string, c: string) => string) =>
  `${tx.type === "income" ? "+" : tx.type === "expense" ? "−" : ""}${money(tx.amount, tx.currency)}`;

function TransactionRow({
  tx,
  icon,
  onOpen,
  selection,
  onLongPress,
  onMenu,
}: {
  tx: FinanceTransaction;
  icon: string;
  onOpen: (tx: FinanceTransaction) => void;
  /** While selecting: a tap toggles the row instead of opening it. */
  selection?: {
    selected: boolean;
    onToggle: (tx: FinanceTransaction, range?: boolean) => void;
  } | null;
  /** Touch: hold to start selecting with this movement (ADR-083). */
  onLongPress?: (tx: FinanceTransaction) => void;
  /** Mouse: right-click opens ELISE's menu for this movement. */
  onMenu?: (tx: FinanceTransaction, x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const press = useLongPress(() => !tx.readOnly && onLongPress?.(tx));
  const label = tx.description || tx.counterparty || tx.category || "—";
  const meta = [
    tx.type === "transfer"
      ? `${tx.account ?? "—"} → ${tx.toAccount ?? "—"}${
          tx.toAmount && tx.toCurrency ? ` (${money(tx.toAmount, tx.toCurrency)})` : ""
        }`
      : [tx.category ?? t.finance.v21.noCategory, tx.subcategory].filter(Boolean).join(" › "),
    bookLabel(tx) ?? (tx.readOnly ? null : t.finance.ws.unclassified),
    tx.type !== "transfer" ? (tx.account ?? tx.paymentMethod) : null,
    tx.provenance.source !== "ELISE Finance" ? tx.provenance.source : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const selectable = Boolean(selection) && !tx.readOnly;
  return (
    <li>
      <button
        type="button"
        data-tx=""
        role={selection ? "checkbox" : undefined}
        aria-checked={selection ? selection.selected : undefined}
        disabled={Boolean(selection) && !selectable}
        onPointerDown={press.onPointerDown}
        onPointerMove={press.onPointerMove}
        onPointerUp={press.onPointerUp}
        onPointerCancel={press.onPointerCancel}
        onPointerLeave={press.onPointerLeave}
        onContextMenu={(e) => {
          // Touch long-press is handled above; a mouse right-click gets ELISE's own menu.
          if (press.isTouch()) return void e.preventDefault();
          if (!onMenu) return;
          e.preventDefault();
          onMenu(tx, e.clientX, e.clientY);
        }}
        onClick={(e) => {
          if (press.consumeClick()) return;
          // Shift+click selects the range from the last one marked.
          if (selection) selection.onToggle(tx, e.shiftKey);
          else onOpen(tx);
        }}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors select-none [-webkit-touch-callout:none] hover:bg-active focus-visible:bg-active focus-visible:outline-none disabled:opacity-50",
          selection?.selected && "bg-accent-soft hover:bg-accent-soft",
        )}
      >
        {selection && (
          <span
            aria-hidden
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-md border",
              selection.selected
                ? "border-accent bg-accent text-accent-fg"
                : "border-border-strong",
            )}
          >
            {selection.selected && <Check className="size-3.5" />}
          </span>
        )}
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-[17px]"
        >
          {tx.type === "transfer" ? <ArrowLeftRight className="size-4 text-muted" /> : icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[14px]">
            <span className="truncate">{label}</span>
            {tx.mergedCount ? (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-faint">
                ×{tx.mergedCount}
              </span>
            ) : null}
            {tx.status !== "completed" && (
              <span className="bg-approval-soft shrink-0 rounded-full px-2 py-0.5 text-[11px] text-approval-text">
                {t.finance.statuses[tx.status]}
              </span>
            )}
          </span>
          {meta && <span className="block truncate text-[12px] text-faint">{meta}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <TypeIcon type={tx.type} />
          <span
            className={cn(
              "font-mono text-[14px]",
              tx.type === "income" && "text-success",
              tx.type === "transfer" && "text-muted",
            )}
          >
            {signed(tx, money)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Movements grouped by day, newest first, with that day's totals per currency. */
function TransactionList({
  rows,
  today,
  iconOf,
  complete,
  onOpen,
  selected = null,
  onToggle,
  onLongPress,
  onMenu,
}: {
  rows: FinanceTransaction[];
  today: string;
  iconOf: (tx: FinanceTransaction) => string;
  /** False when the list is cut: the oldest day may be partial, so it gets no total. */
  complete: boolean;
  onOpen: (tx: FinanceTransaction) => void;
  /** Selection mode (bulk delete): the chosen ids, or null when not selecting. */
  selected?: ReadonlySet<string> | null;
  onToggle?: (tx: FinanceTransaction, range?: boolean) => void;
  onLongPress?: (tx: FinanceTransaction) => void;
  onMenu?: (tx: FinanceTransaction, x: number, y: number) => void;
}) {
  const { t, locale } = useI18n();
  const money = useMoney();
  const loc = locale === "es" ? "es-AR" : "en-US";
  const fmt = new Intl.DateTimeFormat(loc, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const short = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", timeZone: "UTC" });
  const days = new Map<string, FinanceTransaction[]>();
  for (const tx of rows) days.set(tx.date, [...(days.get(tx.date) ?? []), tx]);
  const entries = [...days.entries()];
  const heading = (d: string) => {
    const at = new Date(`${d}T00:00:00Z`);
    const prefix =
      d === today ? t.finance.v21.today : d === yesterday(today) ? t.finance.v21.yesterday : null;
    return prefix ? `${prefix} · ${short.format(at)}` : fmt.format(at);
  };
  return (
    <div className="flex flex-col gap-4">
      {entries.map(([date, txs], i) => {
        const totals = new Map<string, { inc: string[]; exp: string[] }>();
        for (const tx of txs) {
          if (tx.status !== "completed" || tx.type === "transfer") continue;
          const c = totals.get(tx.currency) ?? { inc: [], exp: [] };
          (tx.type === "income" ? c.inc : c.exp).push(tx.amount);
          totals.set(tx.currency, c);
        }
        const showTotals = complete || i < entries.length - 1;
        return (
          <section key={date} className="flex flex-col gap-1.5">
            <header className="flex flex-wrap items-baseline justify-between gap-x-3 px-1">
              <h3 className="type-label text-faint">{heading(date)}</h3>
              {showTotals && (
                <span className="flex flex-wrap gap-x-3 font-mono text-[11.5px]">
                  {[...totals.entries()].map(([cur, v]) => (
                    <span key={cur} className="flex gap-2">
                      {v.inc.length > 0 && (
                        <span className="text-success">+{money(addAmounts(...v.inc), cur)}</span>
                      )}
                      {v.exp.length > 0 && (
                        <span className="text-muted">−{money(addAmounts(...v.exp), cur)}</span>
                      )}
                    </span>
                  ))}
                </span>
              )}
            </header>
            <ul className={cn(CARD, "divide-y divide-border overflow-hidden")}>
              {txs.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  icon={iconOf(tx)}
                  onOpen={onOpen}
                  selection={
                    selected && onToggle ? { selected: selected.has(tx.id), onToggle } : null
                  }
                  onLongPress={onLongPress}
                  onMenu={onMenu}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Select several movements and delete them at once: one archive (out of every total), with an
 * ELISE confirmation and an undo. Read-only rows (connected sheets) can't be selected.
 */
function BulkBar({
  matching,
  rows,
  selected,
  onChange,
  categories,
}: {
  /** Movements the filters match in the period (more than the rows on screen, maybe). */
  matching: number;
  rows: FinanceTransaction[];
  selected: Set<string> | null;
  onChange: (s: Set<string> | null) => void;
  categories: FinanceCategory[];
}) {
  const { t } = useI18n();
  const b = t.finance.bulk;
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [combining, setCombining] = useState(false);
  const selectable = rows.filter((r) => !r.readOnly);
  if (!selectable.length) return null;
  const run = (ids: string[], restore: boolean) =>
    financeToolAction("finance.archiveTransactions", { transactions: ids, restore });
  if (!selected)
    return (
      <div className="-mb-2 flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => onChange(new Set())}>
          <ListChecks />
          {b.select}
        </Button>
      </div>
    );
  const complete = matching <= rows.length;
  const all = selected.size >= (complete ? selectable.length : matching);
  // Everything in the period (the month…), not only what's on screen.
  const selectAll = () =>
    complete
      ? onChange(new Set(selectable.map((r) => r.id)))
      : startTransition(async () => {
          const r = await matchingIdsAction(window.location.search);
          if (!r.ok) return void toast.error(errorText(t, r.error));
          onChange(new Set(r.value));
        });
  const chosen = rows.filter((r) => selected.has(r.id));
  const plan = planCombine(chosen);
  const why = plan.ok || chosen.length < 2 ? null : b.combineReasons[plan.reason];
  return (
    <div className="sticky top-2 z-10 -mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] px-3 py-2 backdrop-blur-xl">
      <span className="text-[13.5px]" aria-live="polite">
        {b.selected(selected.size)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => (all ? onChange(new Set()) : selectAll())}
      >
        {all ? b.selectNone : b.selectAll}
      </Button>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onChange(null)}>
          {t.common.cancel}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !plan.ok}
          aria-describedby={why ? "combine-why" : undefined}
          title={why ?? undefined}
          onClick={() => setCombining(true)}
        >
          <Combine />
          {b.combine}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending || selected.size === 0}
          onClick={async () => {
            const ids = [...selected];
            const ok = await confirm({
              title: b.confirmTitle(ids.length),
              body: b.confirmBody,
              confirmLabel: b.delete(ids.length),
              destructive: true,
            });
            if (!ok) return;
            startTransition(async () => {
              const r = await run(ids, false);
              if (!r.ok) return void toast.error(errorText(t, r.error));
              onChange(null);
              router.refresh();
              toast.success(b.deleted(ids.length), {
                action: {
                  label: b.undo,
                  onClick: () =>
                    void run(ids, true).then((u) =>
                      u.ok ? router.refresh() : toast.error(errorText(t, u.error)),
                    ),
                },
              });
            });
          }}
        >
          <Trash2 />
          {b.delete(selected.size)}
        </Button>
      </div>
      {why && (
        <p id="combine-why" className="w-full text-[12px] text-faint">
          {why}
        </p>
      )}
      {combining && (
        <CombineDialog
          rows={chosen}
          plan={plan.ok ? plan : null}
          categories={categories}
          onClose={() => setCombining(false)}
          onDone={() => {
            setCombining(false);
            onChange(null);
          }}
        />
      )}
    </div>
  );
}

const yesterday = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};

function FilterBar({
  overview,
  q,
  setQ,
}: {
  overview: FinanceOverview;
  q: string;
  setQ: (v: string) => void;
}) {
  const { t } = useI18n();
  const { set } = useFilters();
  const f = overview.filters;
  const [open, setOpen] = useState(false);
  const currencies = overview.summary.current.totals.map((c) => c.currency);
  const filtered = Boolean(f.q || f.type || f.category || f.account || f.currency || f.status);
  const count = [f.type, f.category, f.account, f.currency, f.status].filter(Boolean).length;
  const controls = (
    <>
      <Select
        aria-label={t.finance.accountType}
        value={f.type ?? ""}
        onChange={(e) => set({ type: e.target.value || null })}
      >
        <option value="">{t.finance.all}</option>
        <option value="expense">{t.finance.expenses}</option>
        <option value="income">{t.finance.income}</option>
        <option value="transfer">{t.finance.types.transfer}</option>
      </Select>
      <Select
        aria-label={t.finance.category}
        value={f.category ?? ""}
        onChange={(e) => set({ category: e.target.value || null })}
      >
        <option value="">{t.finance.allCategories}</option>
        {[...new Map(overview.categories.map((c) => [c.name, c])).values()].map((c) => (
          <option key={c.id} value={c.name}>
            {categoryIcon(c)} {c.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t.finance.account}
        value={f.account ?? ""}
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
        value={f.currency ?? ""}
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
        <option value="pending">{t.finance.ws.pendingOnly}</option>
      </Select>
    </>
  );
  const clear = () => {
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
  };
  const active: [string, string, string | null][] = [
    [t.finance.category, "category", f.category ?? null],
    [t.finance.account, "account", f.account ?? null],
    [t.finance.currency, "currency", f.currency ?? null],
    [t.finance.status, "status", f.status ? t.finance.ws.pendingOnly : null],
    [t.finance.accountType, "type", f.type ? t.finance.types[f.type] : null],
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <Input
            aria-label={t.finance.search}
            placeholder={t.finance.search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-10 pl-9"
          />
        </div>
        {/* Phones (ADR-066): one "Filtros · n" button; the controls live in a sheet. */}
        <FilterButton className="md:hidden" count={count} onClick={() => setOpen(true)} />
      </div>
      <FilterSheet open={open} onClose={() => setOpen(false)} onClear={clear}>
        {controls}
      </FilterSheet>
      <div className="grid gap-2 max-md:hidden md:grid-cols-5">{controls}</div>
      {filtered && (
        <div className="flex flex-wrap items-center gap-1.5">
          {active
            .filter(([, , v]) => v)
            .map(([label, key, v]) => (
              <button
                key={key}
                type="button"
                onClick={() => set({ [key]: null })}
                aria-label={`${t.finance.v21.removeFilter}: ${label}`}
                className="flex h-7 items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-2.5 text-[12.5px] text-accent-text"
              >
                {label}: {v}
                <X className="size-3" aria-hidden />
              </button>
            ))}
          <Button size="sm" variant="ghost" onClick={clear}>
            {t.finance.clearFilters}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Ranked, clickable bars (drill-down): one currency, one type. */
function RankedBars({
  title,
  groups,
  currency,
  onPick,
  iconOf,
  limit = 8,
}: {
  title: string;
  groups: GroupTotal[];
  currency: string;
  onPick?: (key: string) => void;
  iconOf?: (key: string) => string | null;
  limit?: number;
}) {
  const money = useMoney();
  const { t } = useI18n();
  const rows = groups
    .filter((g) => g.currency === currency)
    .sort((a, b) => compareAmounts(b.total, a.total))
    .slice(0, limit);
  if (!rows.length) return null;
  const max = rows[0]!.total;
  return (
    <section className={cn(CARD, "flex flex-col gap-3 px-5 py-4")}>
      <h2 className="type-label text-faint">
        {title} · {currency}
      </h2>
      <ul className="flex flex-col gap-1">
        {rows.map((g) => {
          const none = g.key === "—";
          return (
            <li key={g.key}>
              <button
                type="button"
                disabled={!onPick || none}
                onClick={() => onPick?.(g.key)}
                title={onPick && !none ? t.finance.ws.drill : undefined}
                className="flex w-full flex-col gap-1 rounded-lg px-1.5 py-1 text-left text-[13.5px] enabled:hover:bg-active"
              >
                <span className="flex w-full justify-between gap-3">
                  <span className="truncate">
                    {iconOf && !none ? `${iconOf(g.key) ?? ""} ` : ""}
                    {none ? t.finance.v21.noCategory : g.key}
                  </span>
                  <span className="shrink-0 font-mono text-[12.5px] text-muted">
                    {money(g.total, currency)}
                  </span>
                </span>
                <span
                  className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                  aria-hidden
                >
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${share(g.total, max)}%` }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BudgetLine({
  u,
  money,
  t,
}: {
  u: BudgetUsage;
  money: (a: string, c: string) => string;
  t: T;
}) {
  const b = t.finance.v21.budget;
  const pct = Math.round(u.percentTenths / 10);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
        <span className="truncate">
          {budgetLook(u).icon} {[budgetLook(u).label, u.subcategory].filter(Boolean).join(" › ")}
        </span>
        <span className="shrink-0 font-mono text-[12.5px] text-muted">
          {money(u.spent, u.currency)} / {money(u.amount, u.currency)}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        aria-label={u.category}
      >
        <span
          className={cn(
            "block h-full rounded-full",
            u.state === "over" ? "bg-danger" : u.state === "warning" ? "bg-approval" : "bg-accent",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p
        className={cn(
          "text-[12px]",
          u.state === "over"
            ? "text-danger-text"
            : u.state === "warning"
              ? "text-approval-text"
              : "text-faint",
        )}
      >
        {b.used(pct)} ·{" "}
        {u.remaining.startsWith("-")
          ? t.finance.ws.overBy(money(u.remaining.slice(1), u.currency))
          : b.remaining(Math.max(0, 100 - pct))}
      </p>
    </div>
  );
}

function SidePanel({
  overview,
  currency,
  catIcon,
  onTab,
}: {
  overview: FinanceOverview;
  currency: string | undefined;
  catIcon: (name: string) => string | null;
  onTab: (tab: "budgets") => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  const { set } = useFilters();
  const budgets = [...(overview.budgets?.usages ?? [])]
    .sort((a, b) => b.percentTenths - a.percentTenths)
    .slice(0, 3);
  return (
    <aside className="flex flex-col gap-3">
      {currency && (
        <RankedBars
          title={t.finance.v21.topCategories}
          groups={overview.summary.current.byCategory.filter((g) => g.type === "expense")}
          currency={currency}
          limit={5}
          iconOf={catIcon}
          onPick={(category) => set({ category, type: "expense" })}
        />
      )}
      {budgets.length > 0 && (
        <section className={cn(CARD, "flex flex-col gap-3 px-5 py-4")}>
          <button
            type="button"
            onClick={() => onTab("budgets")}
            className="text-left type-label text-faint hover:text-accent-text"
          >
            {t.finance.v21.tabs.budgets}
          </button>
          {budgets.map((u) => (
            <BudgetLine key={u.id} u={u} money={money} t={t} />
          ))}
        </section>
      )}
      {currency && !overview.filters.book && (
        <RankedBars
          title={`${t.finance.v21.byScope} · ${t.finance.expenses}`}
          groups={overview.byBook.filter((g) => g.type === "expense")}
          currency={currency}
          onPick={(name) =>
            set({ book: overview.books.find((b) => b.name === name)?.id ?? UNCLASSIFIED })
          }
        />
      )}
    </aside>
  );
}

/** Whether the Movements side column has any section to show (same rules as SidePanel). */
function hasSidePanel(overview: FinanceOverview, currency: string | undefined) {
  const expense = (g: { type: string; currency: string }) =>
    g.type === "expense" && g.currency === currency;
  return Boolean(
    (overview.budgets?.usages.length ?? 0) > 0 ||
    (currency &&
      (overview.summary.current.byCategory.some(expense) ||
        (!overview.filters.book && overview.byBook.some(expense)))),
  );
}

const IMPORT_HREF = "/my-elise/finance/sources";

// ── Detail drawer ────────────────────────────────────────────────────────────

function DetailDrawer({
  tx,
  icon,
  onClose,
  onEdit,
  onDuplicate,
}: {
  tx: FinanceTransaction | null;
  icon: string;
  onClose: () => void;
  onEdit: (tx: FinanceTransaction) => void;
  onDuplicate: (tx: FinanceTransaction) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const money = useMoney();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ws = t.finance.ws;
  const d = t.finance.v21.detail;
  useEffect(() => {
    if (!tx) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [tx, onClose]);
  if (!tx) return null;
  const run = (tool: string, args: unknown, done: () => void) =>
    startTransition(async () => {
      const r = await financeToolAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        done();
        router.refresh();
      }
    });
  const archive = () =>
    run("finance.archiveTransaction", { transaction: tx.id }, () => {
      onClose();
      toast.success(t.finance.archived, {
        duration: 10_000,
        action: {
          label: ws.undo,
          onClick: () =>
            void financeToolAction("finance.restoreTransaction", { transaction: tx.id }).then(
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
  const receiptLink = tx.receipt && /^https?:\/\//i.test(tx.receipt) ? tx.receipt : null;
  const rows: [string, string | null | undefined][] = [
    [t.finance.accountType, t.finance.types[tx.type]],
    [t.finance.date, tx.date],
    [t.finance.status, t.finance.statuses[tx.status]],
    [
      t.finance.category,
      tx.type === "transfer"
        ? null
        : [tx.category, tx.subcategory].filter(Boolean).join(" › ") || t.finance.v21.noCategory,
    ],
    [ws.book, bookLabel(tx) ?? (tx.readOnly ? null : ws.unclassified)],
    [
      t.finance.account,
      tx.type === "transfer"
        ? `${tx.account ?? "—"} → ${tx.toAccount ?? "—"}`
        : (tx.account ?? tx.paymentMethod),
    ],
    // ADR-089: a transfer into another currency shows what arrived and the rate it implies.
    ...(tx.toAmount && tx.toCurrency
      ? ([
          [t.finance.v21.tx.received, money(tx.toAmount, tx.toCurrency)],
          [t.finance.v21.tx.rate, rateText(tx)],
        ] as [string, string | null][])
      : []),
    [t.finance.counterparty, tx.counterparty],
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
  ];
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={ws.detail}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col gap-4 overflow-y-auto rounded-t-3xl border border-border-strong bg-[var(--overlay-bg)] p-5 shadow-2xl md:inset-y-3 md:right-3 md:left-auto md:max-h-none md:w-[26rem] md:rounded-3xl"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-[20px]"
          >
            {tx.type === "transfer" ? <ArrowLeftRight className="size-5 text-muted" /> : icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("font-mono text-[22px]", tx.type === "income" && "text-success")}>
              {signed(tx, money)}
            </p>
            <p className="truncate text-[14px] text-muted">
              {tx.description || tx.counterparty || tx.category || ""}
            </p>
          </div>
          <button
            type="button"
            aria-label={d.close}
            onClick={onClose}
            className="grid size-9 place-items-center rounded-full text-muted hover:bg-active"
          >
            <X className="size-4" />
          </button>
        </div>
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-t border-border pt-4 text-[14px]">
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
        {tx.mergedCount ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border px-4 py-3 text-[13.5px]">
            <span className="text-muted">{t.finance.combine.detail(tx.mergedCount)}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={async () => {
                const k = t.finance.combine;
                if (!(await confirm({ title: k.undo, body: k.undoConfirm }))) return;
                startTransition(async () => {
                  const r = await financeToolAction("finance.uncombineTransaction", {
                    transaction: tx.id,
                  });
                  if (!r.ok) return void toast.error(errorText(t, r.error));
                  toast.success(k.undone(tx.mergedCount ?? 0));
                  onClose();
                  router.refresh();
                });
              }}
            >
              {t.finance.combine.undo}
            </Button>
          </div>
        ) : null}
        {tx.readOnly ? (
          <p className="text-[13px] text-muted">{t.finance.readOnly}</p>
        ) : (
          <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button disabled={pending} onClick={() => onEdit(tx)}>
              {ws.editAction}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={() => onDuplicate(tx)}>
              {d.duplicate}
            </Button>
            {tx.status !== "cancelled" && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(
                    "finance.updateTransaction",
                    {
                      transaction: tx.id,
                      status: tx.status === "pending" ? "completed" : "pending",
                    },
                    onClose,
                  )
                }
              >
                {tx.status === "pending" ? ws.markPaid : d.markPending}
              </Button>
            )}
            <div className="ml-auto">
              <Menu
                label={d.more}
                items={[
                  {
                    label: t.finance.archive,
                    danger: true,
                    onClick: async () => {
                      if (await confirm({ title: t.finance.archiveConfirm, destructive: true }))
                        archive();
                    },
                  },
                ]}
              />
            </div>
          </div>
        )}
      </section>
    </>
  );
}

// ── Managers ─────────────────────────────────────────────────────────────────

function AccountManager({
  open,
  onClose,
  accounts,
  books,
  defaultCurrency,
}: {
  open: boolean;
  onClose: () => void;
  accounts: FinanceAccount[];
  books: FinanceBook[];
  defaultCurrency: string | null;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<FinanceAccount | "new" | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("bank");
  const [currency, setCurrency] = useState("");
  const [book, setBook] = useState("");
  const edit = (a: FinanceAccount | "new") => {
    setEditing(a);
    setName(a === "new" ? "" : a.name);
    setType(a === "new" ? "bank" : a.type);
    setCurrency(a === "new" ? "" : (a.currency ?? ""));
    setBook(a === "new" ? "" : (books.find((b) => b.id === a.defaultBookId)?.name ?? ""));
  };
  const run = (tool: string, args: unknown) =>
    startTransition(async () => {
      const r = await financeToolAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        setEditing(null);
        router.refresh();
      }
    });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={pending}
      title={t.finance.v21.accounts.title}
      className="border-border-strong bg-[var(--overlay-bg)] sm:max-w-xl"
    >
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing === "new")
              run("finance.createAccount", { name, type, ...(currency ? { currency } : {}) });
            else
              run("finance.updateAccount", {
                account: editing.name,
                name,
                type,
                currency: currency || null,
                ...(books.length ? { book: book || null } : {}),
              });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="acct-name">{t.finance.accountName}</Label>
            <Input
              id="acct-name"
              required
              maxLength={80}
              value={name}
              placeholder={t.finance.accountNamePlaceholder}
              onChange={(e) => setName(e.target.value)}
              className="h-11"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select
              aria-label={t.finance.accountType}
              value={type}
              onChange={(e) => setType(e.target.value as AccountType)}
              className="h-11"
            >
              {(Object.keys(t.finance.accountTypes) as AccountType[]).map((k) => (
                <option key={k} value={k}>
                  {t.finance.accountTypes[k]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t.finance.currency}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-11"
            >
              <option value="">{t.finance.anyCurrency}</option>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
            {editing !== "new" && books.length > 0 && (
              <Select
                aria-label={t.finance.ws.defaultBook}
                value={book}
                onChange={(e) => setBook(e.target.value)}
                className="h-11"
              >
                <option value="">{t.finance.ws.noBook}</option>
                {books.map((b) => (
                  <option key={b.id} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            {editing !== "new" && (
              <Button
                variant="ghost"
                className="mr-auto hover:text-danger-text"
                disabled={pending}
                onClick={async () => {
                  const ok = await confirm({
                    title: t.finance.archiveAccountConfirm(editing.name),
                    confirmLabel: t.finance.archive,
                    destructive: true,
                  });
                  if (ok) run("finance.updateAccount", { account: editing.name, archived: true });
                }}
              >
                {t.finance.archive}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t.finance.cancel}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {t.finance.save}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {accounts.length === 0 ? (
            <p className="text-[13.5px] text-muted">{t.finance.noAccounts}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {accounts.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => edit(a)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-active"
                  >
                    <span className="text-[14px]">{a.name}</span>
                    <span className="text-[12.5px] text-faint">
                      {[
                        a.isDefault ? t.finance.defaultAccountTag : null,
                        t.finance.accountTypes[a.type],
                        a.currency,
                        books.find((b) => b.id === a.defaultBookId)?.name,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="default-currency">{t.finance.defaultCurrency}</Label>
              <Select
                id="default-currency"
                value={defaultCurrency ?? ""}
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
            </div>
            {accounts.length > 0 && (
              <div className="flex items-center gap-2">
                {/* ADR-087: movements recorded without an account go here. */}
                <Label htmlFor="default-account">{t.finance.defaultAccount}</Label>
                <Select
                  id="default-account"
                  value={accounts.find((a) => a.isDefault)?.name ?? ""}
                  className="h-9 w-auto"
                  disabled={pending}
                  onChange={(e) => {
                    const current = accounts.find((a) => a.isDefault);
                    if (e.target.value)
                      run("finance.updateAccount", { account: e.target.value, default: true });
                    else if (current)
                      run("finance.updateAccount", { account: current.name, default: false });
                  }}
                >
                  <option value="">{t.finance.notSet}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Button onClick={() => edit("new")}>
              <Plus />
              {t.finance.addAccount}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ── Statistics ───────────────────────────────────────────────────────────────

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(CARD, "flex min-w-0 flex-col gap-2 px-5 py-4", className)}>
      <h2 className="type-label text-faint">{title}</h2>
      {children}
    </section>
  );
}

function Statistics({
  overview,
  currency,
  catIcon,
}: {
  overview: FinanceOverview;
  currency: string;
  catIcon: (n: string) => string | null;
}) {
  const { t, locale } = useI18n();
  const { set } = useFilters();
  const ws = t.finance.ws;
  const v = t.finance.v21;
  // Buckets after today are empty, not zero: the series stop at today (ADR-054).
  const full = overview.trend.find((s) => s.currency === currency);
  const series =
    full &&
    (() => {
      const today = overview.today;
      const cut = full.keys.filter((k) =>
        full.granularity === "month" ? k <= today.slice(0, 7) : k <= today,
      ).length;
      return cut >= full.keys.length
        ? full
        : {
            ...full,
            keys: full.keys.slice(0, cut),
            income: full.income.slice(0, cut),
            expense: full.expense.slice(0, cut),
            net: full.net.slice(0, cut),
          };
    })();
  const trend = series ? financeTrendVisual(series, locale) : null;
  const evolution: VisualizationSpec | null =
    series && series.keys.length >= 2
      ? {
          type: "line",
          title: v.evolution,
          format: { kind: "currency", currency },
          x: series.keys.slice(-62),
          series: [
            {
              name: t.finance.expenses,
              values: series.expense.slice(-62).map((x) => Math.round(Number(x))),
            },
          ],
        }
      : null;
  const expenses = overview.summary.current.byCategory
    .filter((g) => g.type === "expense" && g.currency === currency)
    .sort((a, b) => compareAmounts(b.total, a.total));
  const top = expenses.slice(0, expenses.length > 6 ? 5 : 6);
  const rest = expenses.slice(top.length);
  const donut: VisualizationSpec | null =
    expenses.length >= 2
      ? {
          type: "donut",
          title: v.expensesByCategory,
          format: { kind: "currency", currency },
          rows: [
            ...top.map((g) => ({
              label:
                `${g.key === "—" ? "" : `${catIcon(g.key) ?? ""} `}${g.key === "—" ? v.noCategory : g.key}`.slice(
                  0,
                  60,
                ),
              value: Math.round(Number(g.total)),
            })),
            ...(rest.length
              ? [
                  {
                    label: ws.other,
                    value: Math.round(Number(addAmounts(...rest.map((g) => g.total)))),
                  },
                ]
              : []),
          ],
        }
      : null;
  const book = overview.books.find((b) => b.id === overview.filters.book);
  const business = book
    ? book.type === "business"
    : overview.books.some((b) => b.type === "business");
  const a = overview.analysis;
  const drill = (patch: Record<string, string | null>) => set({ tab: null, ...patch });
  if (!overview.summary.current.count)
    return <p className={cn(CARD, "px-5 py-4 text-[14px] text-muted")}>{ws.noData}</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {trend && (
        <Card title={v.incomeVsExpenses}>
          <Visualization spec={{ ...trend.spec, title: "" }} size="medium" />
        </Card>
      )}
      {donut && (
        <Card title={`${v.expensesByCategory} · ${currency}`}>
          <Visualization spec={{ ...donut, title: "" }} size="medium" />
        </Card>
      )}
      <RankedBars
        title={v.ranking}
        groups={expenses}
        currency={currency}
        iconOf={catIcon}
        onPick={(category) => drill({ category, type: "expense" })}
      />
      {evolution && (
        <Card title={v.evolution}>
          <Visualization spec={{ ...evolution, title: "" }} size="medium" />
        </Card>
      )}
      <RankedBars
        title={ws.incomeByCategory}
        groups={overview.summary.current.byCategory.filter(
          (g) => g.type === "income" && g.key !== "—",
        )}
        currency={currency}
        iconOf={catIcon}
        onPick={(category) => drill({ category, type: "income" })}
      />
      {!overview.filters.book && (
        <RankedBars
          title={`${v.byScope} · ${t.finance.expenses}`}
          groups={overview.byBook.filter((g) => g.type === "expense")}
          currency={currency}
          onPick={(name) =>
            set({ book: overview.books.find((b) => b.name === name)?.id ?? UNCLASSIFIED })
          }
        />
      )}
      {business && a && (
        <>
          <RankedBars
            title={ws.topClients}
            groups={a.counterparties.filter((g) => g.type === "income" && g.key !== "—")}
            currency={currency}
            onPick={(q) => drill({ q, type: "income" })}
          />
          <RankedBars
            title={ws.topProviders}
            groups={a.counterparties.filter((g) => g.type === "expense" && g.key !== "—")}
            currency={currency}
            onPick={(q) => drill({ q, type: "expense" })}
          />
          <RankedBars
            title={ws.byProject}
            groups={a.projects.filter((g) => g.key !== "—" && g.type === "expense")}
            currency={currency}
          />
        </>
      )}
    </div>
  );
}

// ── Budgets ──────────────────────────────────────────────────────────────────

// ── Workspace ────────────────────────────────────────────────────────────────

export function FinanceView({
  overview,
  workspaceId,
}: {
  overview: FinanceOverview;
  workspaceId: string;
}) {
  const { t } = useI18n();
  const v = t.finance.v21;
  const labels = useLabels();
  const { set } = useFilters();
  const desktop = useIsDesktop();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceTransaction | null>(null);
  const [duplicating, setDuplicating] = useState<FinanceTransaction | null>(null);
  const [viewing, setViewing] = useState<FinanceTransaction | null>(null);
  const [managing, setManaging] = useState<"categories" | "accounts" | null>(null);
  // Selection (bulk delete, combine): null = not selecting. One model for every entry point.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState<(MovementMenuState & { tx: FinanceTransaction }) | null>(null);
  const confirmDelete = useConfirm();
  const router = useRouter();
  const anchor = useRef<string | null>(null);
  const toggle = (tx: FinanceTransaction, range = false) =>
    setSelected((s) => {
      const next = new Set(s ?? []);
      const rows = overview.transactions.filter((r) => !r.readOnly);
      const from = range && anchor.current ? rows.findIndex((r) => r.id === anchor.current) : -1;
      const to = rows.findIndex((r) => r.id === tx.id);
      if (from >= 0 && to >= 0) {
        for (const r of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(r.id);
      } else if (next.has(tx.id)) next.delete(tx.id);
      else next.add(tx.id);
      anchor.current = tx.id;
      return next;
    });
  const deleteOne = async (tx: FinanceTransaction) => {
    if (!(await confirmDelete({ title: t.finance.bulk.deleteOne, destructive: true }))) return;
    const r = await financeToolAction("finance.archiveTransaction", { transaction: tx.id });
    if (!r.ok) return void toast.error(errorText(t, r.error));
    router.refresh();
    toast.success(t.finance.archived, {
      duration: 10_000,
      action: {
        label: t.finance.ws.undo,
        onClick: () =>
          void financeToolAction("finance.restoreTransaction", { transaction: tx.id }).then((u) =>
            u.ok ? router.refresh() : toast.error(errorText(t, u.error)),
          ),
      },
    });
  };
  const [q, setQ] = useState(overview.filters.q ?? "");
  const [chartCurrency, setChartCurrency] = useState<string | null>(null);
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
  const shown = chartCurrency && currencies.includes(chartCurrency) ? chartCurrency : currencies[0];
  const currentBook = overview.books.find((b) => b.id === f.book) ?? null;
  const byName = new Map(overview.categories.map((c) => [c.name, c]));
  const catIcon = (name: string) => categoryIcon(byName.get(name) ?? { name, icon: null });
  const iconOf = (tx: FinanceTransaction) =>
    tx.category
      ? categoryIcon(
          overview.categories.find((c) => c.id === tx.categoryId) ?? {
            name: tx.category,
            icon: null,
          },
        )
      : "•";
  const tab = f.tab;
  const gran = f.period === "custom" || (f.period !== "span" && f.period) ? "custom" : f.gran;

  const reportQuery = new URLSearchParams({ from: overview.period.from, to: overview.period.to });
  if (currentBook) reportQuery.set("book", currentBook.name);
  for (const k of ["type", "category", "account", "currency"] as const)
    if (f[k]) reportQuery.set(k, f[k]!);

  const currencyChips = currencies.length > 1 && (
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
  );

  const startAdd = () => {
    setDuplicating(null);
    setAdding(true);
  };

  return (
    <div className="flex flex-col gap-5 max-md:pb-20">
      {/* Header actions + Ámbito filter */}
      <div className="flex items-center justify-between gap-3 md:flex-wrap">
        <div className="min-w-0 flex-1">
          <ScopeChips books={overview.books} value={f.book} />
        </div>
        <div className="flex items-center gap-2">
          {/* One entry point: files, connected Sheets and past imports live on the Import page. */}
          <Link
            href={IMPORT_HREF}
            className={cn(buttonVariants({ variant: "secondary" }), "max-md:hidden")}
          >
            <Upload />
            {v.importAction}
          </Link>
          <Button onClick={startAdd} className="max-md:hidden">
            <Plus />
            {v.tx.newTitle}
          </Button>
          <OverflowMenu
            label={v.more}
            items={[
              ...(desktop ? [] : [{ label: v.importAction, href: IMPORT_HREF, icon: Upload }]),
              { label: v.categories.title, onClick: () => setManaging("categories") },
              { label: v.accounts.title, onClick: () => setManaging("accounts") },
            ]}
          />
        </div>
      </div>
      {/* Adding a movement is the main action, always within reach (ADR-066): a labeled pill
          for thumbs on phones, a round + on desktop, so nobody scrolls back to the top. The
          empty state has its own. */}
      {overview.hasAny && (
        <button
          type="button"
          onClick={startAdd}
          title={v.tx.newTitle}
          className="fixed right-[calc(1rem+var(--quick-voice-space))] bottom-[calc(var(--activity-bottom)+var(--activity-music))] z-30 flex h-13 items-center gap-2 rounded-full bg-fg px-5 text-[15px] font-medium text-bg shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6)] transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none md:right-[calc(2rem+var(--quick-voice-space))] md:bottom-8 md:size-14 md:justify-center md:px-0"
        >
          <Plus className="size-5 md:size-6" aria-hidden />
          <span className="md:sr-only">{v.tx.add}</span>
        </button>
      )}
      {overview.books.length === 0 && (
        <p
          role="status"
          className="bg-approval-soft rounded-xl border border-approval/40 px-4 py-2.5 text-[13px] text-approval-text"
        >
          {v.setupWarning}
        </p>
      )}

      <FinanceNav
        active={tab}
        onSelect={(k) => set({ tab: k === "movements" ? null : k })}
        reportsHref={`/my-elise/finance/reports?${reportQuery.toString()}`}
      />
      <PeriodBar key={`${overview.period.from}|${overview.period.to}`} overview={overview} />
      <KpiStrip overview={overview} />
      {(s.current.excluded.pending > 0 ||
        s.truncated ||
        (s.current.transfers ?? 0) > 0 ||
        currencies.length > 1) && (
        <p className="-mt-2 text-[12.5px] text-faint">
          {[
            currencies.length > 1 ? t.finance.separateCurrencies : "",
            s.current.excluded.pending > 0 ? t.finance.excluded(s.current.excluded.pending) : "",
            s.current.transfers ? t.finance.ws.transfers(s.current.transfers) : "",
            s.truncated ? t.finance.partial : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}

      {tab === "movements" && (
        // The side column exists only when it has something to show: no empty reserved space.
        <div
          className={cn(
            "grid grid-cols-1 items-start gap-5",
            hasSidePanel(overview, shown) && "xl:grid-cols-[minmax(0,1fr)_22rem]",
          )}
        >
          <section className="flex min-w-0 flex-col gap-3">
            <FilterBar overview={overview} q={q} setQ={setQ} />
            {!overview.hasAny ? (
              <div
                className={cn(
                  CARD,
                  "flex flex-col items-center gap-3 border-dashed px-6 py-10 text-center",
                )}
              >
                <h2 className="font-medium">{t.finance.emptyTitle}</h2>
                <p className="max-w-md text-[13.5px] text-muted">{t.finance.emptyBody}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={startAdd}>
                    <Plus />
                    {v.tx.newTitle}
                  </Button>
                  <Link href={IMPORT_HREF} className={buttonVariants({ variant: "secondary" })}>
                    <Upload />
                    {v.importAction}
                  </Link>
                </div>
              </div>
            ) : overview.transactions.length === 0 ? (
              <div
                className={cn(CARD, "flex flex-wrap items-center justify-between gap-3 px-5 py-4")}
              >
                <p className="text-[14px] text-muted">
                  {f.q || f.type || f.category || f.account || f.currency || f.status
                    ? t.finance.nothingMatches
                    : v.noMovesIn(labels.short(gran, overview.period))}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={startAdd}>
                    <Plus />
                    {v.tx.newTitle}
                  </Button>
                  <Link
                    href={IMPORT_HREF}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    {v.importAction}
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <BulkBar
                  matching={overview.matching}
                  rows={overview.transactions}
                  selected={selected}
                  onChange={setSelected}
                  categories={overview.categories}
                />
                <TransactionList
                  rows={overview.transactions}
                  today={overview.today}
                  iconOf={iconOf}
                  complete={overview.matching <= overview.transactions.length}
                  // Editable movements open straight in Editar movimiento; a connected sheet's
                  // rows (read-only) keep the detail, which says where to edit them.
                  onOpen={(tx) => (tx.readOnly ? setViewing(tx) : setEditing(tx))}
                  selected={selected}
                  onToggle={toggle}
                  onLongPress={(tx) => setSelected((s) => new Set([...(s ?? []), tx.id]))}
                  onMenu={(tx, x, y) =>
                    setMenu({
                      tx,
                      x,
                      y,
                      selected: Boolean(selected?.has(tx.id)),
                      editable: !tx.readOnly,
                    })
                  }
                />
                <MovementMenu
                  state={menu}
                  onClose={() => setMenu(null)}
                  onToggleSelect={() => menu && toggle(menu.tx)}
                  onEdit={() => menu && setEditing(menu.tx)}
                  onDuplicate={() => {
                    if (!menu) return;
                    setDuplicating(menu.tx);
                    setAdding(true);
                  }}
                  onDelete={() => menu && void deleteOne(menu.tx)}
                />
                {overview.matching > overview.transactions.length && (
                  <p className="px-1 text-[12.5px] text-faint">
                    {t.finance.ws.more(overview.matching - overview.transactions.length)}
                  </p>
                )}
              </>
            )}
          </section>
          {hasSidePanel(overview, shown) && (
            <SidePanel
              overview={overview}
              currency={shown}
              catIcon={catIcon}
              onTab={(k) => set({ tab: k })}
            />
          )}
        </div>
      )}

      {tab === "analysis" && (
        <section className="flex flex-col gap-3">
          {currencyChips}
          {shown ? (
            <Statistics overview={overview} currency={shown} catIcon={catIcon} />
          ) : (
            <p className={cn(CARD, "px-5 py-4 text-[14px] text-muted")}>
              {v.noMovesIn(labels.short(gran, overview.period))}
            </p>
          )}
        </section>
      )}

      {tab === "budgets" && <Budgets overview={overview} />}

      <TransactionDialog
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
          setDuplicating(null);
        }}
        transaction={editing}
        duplicateOf={duplicating}
        accounts={overview.accounts}
        categories={overview.categories}
        books={overview.books}
        defaultBook={currentBook?.name ?? null}
        defaultCurrency={overview.settings.defaultCurrency ?? currencies[0] ?? null}
        today={overview.today}
      />
      <DetailDrawer
        tx={viewing}
        icon={viewing ? iconOf(viewing) : "•"}
        onClose={() => setViewing(null)}
        onEdit={(x) => {
          setViewing(null);
          setEditing(x);
        }}
        onDuplicate={(x) => {
          setViewing(null);
          setDuplicating(x);
          setAdding(true);
        }}
      />
      <CategoryManager
        open={managing === "categories"}
        onClose={() => setManaging(null)}
        categories={overview.categories}
      />
      <AccountManager
        open={managing === "accounts"}
        onClose={() => setManaging(null)}
        accounts={overview.accounts}
        books={overview.books}
        defaultCurrency={overview.settings.defaultCurrency}
      />
    </div>
  );
}
