"use client";

import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceTransaction,
  TransactionType,
} from "@/core/capabilities/finance";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction } from "./actions";
import { COMMON_CURRENCIES, intlLocale, parseTypedAmount } from "./format";

const textareaClass =
  "min-h-16 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none";

/** Amount as the user would type it back ("48.000" / "25,5" in Spanish). */
function typedAmount(amount: string, locale: "es" | "en") {
  const [int, frac] = amount.split(".");
  const grouped = new Intl.NumberFormat(intlLocale(locale), { useGrouping: true }).format(
    BigInt(int!),
  );
  return frac ? `${grouped}${locale === "es" ? "," : "."}${frac}` : grouped;
}

/**
 * Quick add (and edit): type, amount, currency, description and date first; category, account,
 * who, project and notes behind "More details". Saves through the Finance tools, like Chat.
 */
export function TransactionDialog({
  open,
  onClose,
  transaction,
  accounts,
  categories,
  defaultCurrency,
  today,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing. */
  transaction?: FinanceTransaction | null;
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  defaultCurrency: string | null;
  today: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const editing = Boolean(transaction);
  const initial = () => ({
    type: (transaction?.type ?? "expense") as TransactionType,
    amount: transaction ? typedAmount(transaction.amount, locale) : "",
    currency: transaction?.currency ?? defaultCurrency ?? "ARS",
    description: transaction?.description ?? "",
    date: transaction?.date ?? today,
    category: transaction?.category ?? "",
    account: transaction?.account ?? "",
    counterparty: transaction?.counterparty ?? "",
    project: transaction?.project ?? "",
    notes: transaction?.notes ?? "",
    status: transaction?.status ?? "completed",
  });
  const [v, setV] = useState(initial);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const marker = open ? (transaction?.id ?? "new") : null;
  if (marker !== openedFor) {
    // Each opening starts from the record (or empty) with a fresh idempotency key.
    setOpenedFor(marker);
    if (marker) {
      setV(initial());
      setMore(
        Boolean(
          transaction?.category ||
          transaction?.account ||
          transaction?.counterparty ||
          transaction?.project ||
          transaction?.notes,
        ),
      );
      setError(null);
      setKey(crypto.randomUUID());
    }
  }
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: value }));
  const compatible = categories.filter((c) => c.type === v.type || c.type === "both");
  const currencies = [
    ...new Set(
      [
        v.currency,
        defaultCurrency,
        ...accounts.map((a) => a.currency),
        ...COMMON_CURRENCIES,
      ].filter(Boolean),
    ),
  ] as string[];

  function submit() {
    const amount = parseTypedAmount(v.amount, locale);
    if (!amount) {
      setError(t.finance.invalidAmount);
      return;
    }
    setError(null);
    const fields = {
      type: v.type,
      amount,
      currency: v.currency,
      date: v.date,
      description: v.description.trim() || undefined,
      category: v.category || undefined,
      account: v.account || undefined,
      counterparty: v.counterparty.trim() || undefined,
      project: v.project.trim() || undefined,
      notes: v.notes.trim() || undefined,
    };
    startTransition(async () => {
      const r = editing
        ? await financeToolAction("finance.updateTransaction", {
            transaction: transaction!.id,
            ...fields,
            description: fields.description ?? null,
            category: fields.category ?? null,
            account: fields.account ?? null,
            counterparty: fields.counterparty ?? null,
            project: fields.project ?? null,
            notes: fields.notes ?? null,
            status: v.status,
          })
        : await financeToolAction("finance.createTransaction", fields, key);
      if (!r.ok) {
        setError(errorText(t, r.error));
        return;
      }
      toast.success(editing ? t.finance.saved : t.finance.recorded);
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={pending}
      title={editing ? t.finance.edit : t.finance.add}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div
          role="radiogroup"
          aria-label={t.finance.types.expense}
          className="grid grid-cols-2 gap-1 rounded-full bg-surface-2 p-1"
        >
          {(["expense", "income"] as const).map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={v.type === type}
              onClick={() => set("type", type)}
              className={cn(
                "h-9 rounded-full text-sm transition-colors",
                v.type === type
                  ? "bg-bg font-medium text-fg shadow-sm"
                  : "text-muted hover:text-fg",
              )}
            >
              {t.finance.types[type]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-amount">{t.finance.amount}</Label>
            <Input
              id="tx-amount"
              data-autofocus=""
              required
              inputMode="decimal"
              autoComplete="off"
              value={v.amount}
              placeholder={locale === "es" ? "48.000" : "25.50"}
              onChange={(e) => set("amount", e.target.value)}
              className="h-11 font-mono text-[16px]"
              aria-invalid={Boolean(error)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-currency">{t.finance.currency}</Label>
            <Select
              id="tx-currency"
              value={v.currency}
              onChange={(e) => set("currency", e.target.value)}
              className="h-11"
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-description">{t.finance.description}</Label>
            <Input
              id="tx-description"
              value={v.description}
              maxLength={300}
              placeholder={t.finance.descriptionPlaceholder}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tx-date">{t.finance.date}</Label>
            <Input
              id="tx-date"
              type="date"
              required
              value={v.date}
              onChange={(e) => set("date", e.target.value)}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setMore(!more)}
          aria-expanded={more}
          className="flex items-center gap-1.5 self-start text-[13.5px] text-muted hover:text-fg"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", more && "rotate-180")}
            aria-hidden
          />
          {more ? t.finance.fewerDetails : t.finance.moreDetails}
        </button>
        {more && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-category">{t.finance.category}</Label>
                <Select
                  id="tx-category"
                  value={v.category}
                  onChange={(e) => set("category", e.target.value)}
                >
                  <option value="">{t.finance.noCategory}</option>
                  {compatible.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.parent ? `${c.parent} › ${c.name}` : c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-account">{t.finance.account}</Label>
                <Select
                  id="tx-account"
                  value={v.account}
                  onChange={(e) => set("account", e.target.value)}
                >
                  <option value="">{t.finance.noAccount}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.currency ? `${a.name} · ${a.currency}` : a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-who">{t.finance.counterparty}</Label>
                <Input
                  id="tx-who"
                  value={v.counterparty}
                  maxLength={200}
                  placeholder={t.finance.counterpartyPlaceholder}
                  onChange={(e) => set("counterparty", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-project">{t.finance.project}</Label>
                <Input
                  id="tx-project"
                  value={v.project}
                  maxLength={120}
                  placeholder={t.finance.projectPlaceholder}
                  onChange={(e) => set("project", e.target.value)}
                />
              </div>
            </div>
            {editing && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tx-status">{t.finance.status}</Label>
                <Select
                  id="tx-status"
                  value={v.status}
                  onChange={(e) => set("status", e.target.value as typeof v.status)}
                >
                  {(["completed", "pending", "cancelled"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t.finance.statuses[s]}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tx-notes">{t.finance.notes}</Label>
              <textarea
                id="tx-notes"
                rows={2}
                maxLength={2000}
                value={v.notes}
                onChange={(e) => set("notes", e.target.value)}
                className={textareaClass}
              />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-[13.5px] text-danger-text">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {editing && (
            <Button
              variant="ghost"
              className="mr-auto hover:text-danger-text"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(t.finance.archiveConfirm)) return;
                startTransition(async () => {
                  const r = await financeToolAction("finance.archiveTransaction", {
                    transaction: transaction!.id,
                  });
                  if (!r.ok) {
                    setError(errorText(t, r.error));
                    return;
                  }
                  toast.success(t.finance.archived);
                  router.refresh();
                  onClose();
                });
              }}
            >
              {t.finance.archive}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t.finance.cancel}
          </Button>
          <Button type="submit" disabled={pending || !v.amount.trim()}>
            {t.finance.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
