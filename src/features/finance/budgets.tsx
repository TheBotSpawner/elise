"use client";

import { Check, Plus, Search, Target, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import type { FinanceOverview } from "@/application/finance-service";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input, Label, Select } from "@/components/ui/input";
import { norm, type BudgetUsage, type FinanceCategory } from "@/core/capabilities/finance";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction } from "./actions";
import { financeErrorText } from "./category-manager";
import { COMMON_CURRENCIES, useMoney } from "./format";
import { categoryIcon } from "./transaction-dialog";

const CARD = "rounded-2xl border border-border bg-surface";

/** A budget's label and icon: its own, or derived from its categories. */
export function budgetLook(u: Pick<BudgetUsage, "name" | "icon" | "categories" | "category">) {
  const label = u.name || u.categories.join(" · ") || u.category;
  const icon =
    u.icon ||
    (u.categories.length === 1 ? categoryIcon({ name: u.categories[0]!, icon: null }) : "🎯");
  return { label, icon };
}

/** Searchable multi-select of expense categories, with chips for what's chosen (ADR-083). */
function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: FinanceCategory[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const b = t.finance.v21.budget;
  const [q, setQ] = useState("");
  const shown = categories.filter((c) => !q.trim() || norm(c.name).includes(norm(q)));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="bud-cat-search">{b.categories}</Label>
        <span className="text-[12px] text-faint" aria-live="polite">
          {b.selectedCount(value.length)}
        </span>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  aria-label={b.removeCategory(c.name)}
                  className="flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft py-1 pr-2 pl-2.5 text-[13px] hover:border-accent"
                >
                  <span aria-hidden>{categoryIcon(c)}</span>
                  {c.name}
                  <X className="size-3.5 text-muted" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <Input
          id="bud-cat-search"
          value={q}
          placeholder={b.searchCategories}
          onChange={(e) => setQ(e.target.value)}
          className="h-10 pl-9"
        />
      </div>
      <ul
        className="flex max-h-52 flex-col overflow-y-auto rounded-xl border border-border"
        aria-label={b.categories}
      >
        {shown.length === 0 && (
          <li className="px-3 py-2.5 text-[13px] text-faint">{b.noMatches}</li>
        )}
        {shown.map((c) => {
          const on = value.includes(c.id);
          return (
            <li key={c.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(c.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-active focus-visible:bg-active focus-visible:outline-none",
                  on && "bg-accent-soft/60",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-md border",
                    on ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                  )}
                >
                  {on && <Check className="size-3.5" />}
                </span>
                <span aria-hidden>{categoryIcon(c)}</span>
                <span className="truncate">{c.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Nuevo presupuesto" / editing one: the same ELISE modal (a sheet on phones). */
function BudgetDialog({
  overview,
  budget,
  onClose,
}: {
  overview: FinanceOverview;
  budget: BudgetUsage | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const b = t.finance.v21.budget;
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  // Spending budgets: expense categories only.
  const expense = overview.categories.filter((c) => c.type === "expense" || c.type === "both");
  const current = overview.books.find((x) => x.id === overview.filters.book);
  const [icon, setIcon] = useState(budget?.icon ?? "");
  const [name, setName] = useState(budget?.name ?? "");
  const [ids, setIds] = useState<string[]>(budget?.categoryIds ?? []);
  const [subcategory, setSubcategory] = useState(budget?.subcategory ?? "");
  const [book, setBook] = useState(
    budget?.book ?? current?.name ?? overview.books.find((x) => x.isDefault)?.name ?? "",
  );
  const [amount, setAmount] = useState(
    budget ? (locale === "es" ? budget.amount.replace(".", ",") : budget.amount) : "",
  );
  const [currency, setCurrency] = useState(
    budget?.currency ??
      overview.settings.defaultCurrency ??
      overview.summary.current.totals[0]?.currency ??
      "ARS",
  );
  const [error, setError] = useState<string | null>(null);
  const names = ids.map((id) => expense.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  const parsed = amount
    .replace(locale === "es" ? /\./g : /,/g, "")
    .replace(",", ".")
    .trim();
  const valid = names.length > 0 && Number(parsed) > 0;

  const save = (archived = false) =>
    start(async () => {
      const r = await financeToolAction("finance.setBudget", {
        ...(budget ? { id: budget.id } : {}),
        categories: names.length ? names : (budget?.categories ?? []),
        amount: archived && budget ? budget.amount : parsed,
        currency,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(icon ? { icon } : {}),
        ...(book ? { book } : {}),
        ...(names.length === 1 && subcategory.trim() ? { subcategory: subcategory.trim() } : {}),
        ...(archived ? { archived: true } : {}),
      });
      if (!r.ok) return setError(financeErrorText(t, r.error, t.errors.codes.INTERNAL_ERROR));
      toast.success(archived ? b.deleted : b.saved);
      router.refresh();
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      busy={pending}
      title={budget ? b.editTitle : b.newTitle}
      className="border-border-strong bg-[var(--overlay-bg)] sm:max-w-lg"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return setError(names.length ? b.invalidAmount : b.selectedCount(0));
          save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bud-name">{b.name}</Label>
          <div className="flex items-center gap-2">
            <EmojiPicker value={icon} onChange={setIcon} label={b.icon} placeholder="🎯" />
            <Input
              id="bud-name"
              value={name}
              maxLength={60}
              placeholder={b.namePlaceholder}
              onChange={(e) => setName(e.target.value)}
              className="h-10 flex-1"
            />
          </div>
        </div>
        <CategoryPicker
          categories={expense}
          value={ids}
          onChange={(next) => {
            setIds(next);
            setError(null);
          }}
        />
        {names.length === 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bud-sub">{b.subcategory}</Label>
            <Input
              id="bud-sub"
              value={subcategory}
              maxLength={80}
              onChange={(e) => setSubcategory(e.target.value)}
              className="h-10"
            />
            <p className="text-[12px] text-faint">{b.subcategoryHint}</p>
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bud-amount">{b.amountLabel}</Label>
            <Input
              id="bud-amount"
              inputMode="decimal"
              value={amount}
              placeholder="200.000"
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
              }}
              className="h-10 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bud-cur">{b.currency}</Label>
            <Select
              id="bud-cur"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-10"
            >
              {[...new Set([currency, ...COMMON_CURRENCIES])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bud-period">{b.period}</Label>
            <Select id="bud-period" disabled value="monthly" className="h-10">
              <option value="monthly">{b.monthly}</option>
            </Select>
          </div>
          {overview.books.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bud-book">{b.scope}</Label>
              <Select
                id="bud-book"
                value={book}
                onChange={(e) => setBook(e.target.value)}
                className="h-10"
              >
                {overview.books.map((x) => (
                  <option key={x.id} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-danger-text">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {budget && (
            <Button
              type="button"
              variant="ghost"
              className="text-danger-text"
              disabled={pending}
              onClick={async () => {
                const { label } = budgetLook(budget);
                if (
                  await confirm({
                    title: b.deleteTitle(label),
                    body: b.deleteBody,
                    confirmLabel: b.delete,
                    destructive: true,
                  })
                )
                  save(true);
              }}
            >
              {b.delete}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {t.finance.cancel}
            </Button>
            <Button type="submit" disabled={pending || !valid}>
              {budget ? b.saveChanges : b.create}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

/** One budget as an object: icon, name, spent / limit, %, its categories, progress. */
function BudgetCard({ u, onOpen }: { u: BudgetUsage; onOpen: () => void }) {
  const { t } = useI18n();
  const money = useMoney();
  const b = t.finance.v21.budget;
  const pct = Math.round(u.percentTenths / 10);
  const { label, icon } = budgetLook(u);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={b.edit(label)}
      className={cn(
        CARD,
        "flex w-full flex-col gap-2.5 px-4 py-3.5 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
      )}
    >
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-[18px]"
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium">{label}</span>
          {u.name && u.categories.length > 0 && (
            <span className="block truncate text-[12px] text-faint">
              {u.categories.join(" · ")}
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[13px]",
            u.state === "over"
              ? "text-danger-text"
              : u.state === "warning"
                ? "text-approval-text"
                : "text-muted",
          )}
        >
          {pct}%
        </span>
      </span>
      <span
        className="block h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
        aria-label={label}
      >
        <span
          className={cn(
            "block h-full rounded-full",
            u.state === "over" ? "bg-danger" : u.state === "warning" ? "bg-approval" : "bg-accent",
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12.5px]">
        <span className="font-mono text-muted">
          {money(u.spent, u.currency)} / {money(u.amount, u.currency)}
        </span>
        <span className="text-faint">
          {[
            u.book,
            u.pending ? t.finance.ws.budgetPending(u.pending) : "",
            u.otherCurrencies ? t.finance.ws.budgetOther(u.otherCurrencies) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </button>
  );
}

/** Presupuestos (ADR-052/083): cards, one modal to create and edit, a compact empty state. */
export function Budgets({ overview }: { overview: FinanceOverview }) {
  const { t, locale } = useI18n();
  const b = overview.budgets;
  const copy = t.finance.v21.budget;
  const [editing, setEditing] = useState<BudgetUsage | "new" | null>(null);
  const month = useMemo(
    () =>
      b
        ? new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          }).format(new Date(`${b.month}-01T00:00:00Z`))
        : "",
    [b, locale],
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="type-label text-faint first-letter:uppercase">
          {b ? t.finance.ws.budgetMonth(month) : t.finance.v21.tabs.budgets}
        </h2>
        {Boolean(b?.usages.length) && (
          <Button onClick={() => setEditing("new")}>
            <Plus />
            {copy.new}
          </Button>
        )}
      </div>
      {!b?.usages.length ? (
        <div
          className={cn(
            CARD,
            "flex flex-col items-start gap-3 px-5 py-6 sm:flex-row sm:items-center",
          )}
        >
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-text"
          >
            <Target className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium">{copy.emptyTitle}</p>
            <p className="text-[13.5px] text-muted">{copy.emptyBody}</p>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus />
            {copy.emptyCta}
          </Button>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {b.usages.map((u) => (
            <li key={u.id}>
              <BudgetCard u={u} onOpen={() => setEditing(u)} />
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <BudgetDialog
          overview={overview}
          budget={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
