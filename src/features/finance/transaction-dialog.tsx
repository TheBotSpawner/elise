"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input, Label, Select } from "@/components/ui/input";
import {
  suggestCategoryIcon,
  type FinanceAccount,
  type FinanceBook,
  type FinanceCategory,
  type FinanceTransaction,
  type TransactionType,
} from "@/core/capabilities/finance";
import { divideByRate, impliedRate, multiplyByRate } from "@/core/finance/money";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction } from "./actions";
import { COMMON_CURRENCIES, intlLocale, parseTypedAmount } from "./format";

const textareaClass =
  "min-h-16 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none";
const FIELD = "h-11";

/** A category's icon: the one the user picked, else one suggested from its name. */
export const categoryIcon = (c: Pick<FinanceCategory, "name" | "icon"> | null | undefined) =>
  c ? (c.icon ?? suggestCategoryIcon(c.name) ?? "•") : "•";

/** Amount as the user would type it back ("48.000" / "25,5" in Spanish). */
function typedAmount(amount: string, locale: "es" | "en") {
  const [int, frac] = amount.split(".");
  const grouped = new Intl.NumberFormat(intlLocale(locale), { useGrouping: true }).format(
    BigInt(int!),
  );
  return frac ? `${grouped}${locale === "es" ? "," : "."}${frac}` : grouped;
}

function Field({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </Label>
      {children}
    </div>
  );
}

const ACCOUNT_TYPES = [
  "other",
  "cash",
  "bank",
  "credit_card",
  "debit_card",
  "digital_wallet",
  "business",
] as const;

/**
 * Tiny inline form: create an account (name, type, optional currency) without leaving the
 * movement. The same `finance.createAccount` tool as the account manager; errors stay inline.
 */
function NewAccount({
  initialName,
  currencies,
  onCreated,
  onCancel,
}: {
  initialName: string;
  currencies: string[];
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const x = t.finance.v21.tx;
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<(typeof ACCOUNT_TYPES)[number]>("other");
  const [currency, setCurrency] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const save = () =>
    startTransition(async () => {
      setError(null);
      const r = await financeToolAction("finance.createAccount", {
        name: name.trim(),
        type,
        ...(currency ? { currency } : {}),
      });
      if (!r.ok) return void setError(errorText(t, r.error));
      onCreated(name.trim());
    });
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent-line bg-surface-2/60 p-3">
      <p className="text-[13px] font-medium">{x.newAccount}</p>
      <Input
        aria-label={x.name}
        autoFocus
        value={name}
        maxLength={80}
        placeholder={t.finance.account}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter saves the account, never the whole movement.
            e.preventDefault();
            if (name.trim()) save();
          }
        }}
        className={FIELD}
      />
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={t.finance.accountType}
          value={type}
          onChange={(e) => setType(e.target.value as (typeof ACCOUNT_TYPES)[number])}
          className={FIELD}
        >
          {ACCOUNT_TYPES.map((a) => (
            <option key={a} value={a}>
              {t.finance.accountTypes[a]}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t.finance.currency}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className={FIELD}
        >
          <option value="">{t.finance.anyCurrency}</option>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t.finance.cancel}
        </Button>
        <Button size="sm" onClick={save} disabled={pending || !name.trim()}>
          {x.create}
        </Button>
      </div>
    </div>
  );
}

/** Tiny inline form: create a category (icon, name, optional parent) without leaving. */
function NewCategory({
  initialName,
  type,
  categories,
  onCreated,
  onCancel,
}: {
  initialName: string;
  type: "income" | "expense";
  categories: FinanceCategory[];
  onCreated: (c: FinanceCategory) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const x = t.finance.v21.tx;
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState(suggestCategoryIcon(initialName) ?? "");
  const [parent, setParent] = useState("");
  const [pending, startTransition] = useTransition();
  const save = () =>
    startTransition(async () => {
      const r = await financeToolAction("finance.createCategory", {
        name: name.trim(),
        type,
        ...(icon ? { icon } : {}),
        ...(parent ? { parent } : {}),
      });
      if (!r.ok) return void toast.error(errorText(t, r.error));
      const created = r.value?.kind === "finance_categories" ? r.value.categories[0] : undefined;
      if (created) onCreated(created);
    });
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-accent-line bg-surface-2/60 p-3">
      <p className="text-[13px] font-medium">{x.newCategory}</p>
      <div className="flex items-center gap-2">
        <EmojiPicker value={icon} onChange={setIcon} label={x.icon} className="size-11" />
        <Input
          aria-label={x.name}
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => !icon && setIcon(suggestCategoryIcon(name) ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (name.trim()) save();
            }
          }}
          className={cn(FIELD, "min-w-0 flex-1")}
        />
      </div>
      <Select
        aria-label={x.parent}
        value={parent}
        onChange={(e) => setParent(e.target.value)}
        className={FIELD}
      >
        <option value="">{x.parent}</option>
        {categories
          .filter((c) => !c.parentId && (c.type === type || c.type === "both"))
          .map((c) => (
            <option key={c.id} value={c.name}>
              {categoryIcon(c)} {c.name}
            </option>
          ))}
      </Select>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t.finance.cancel}
        </Button>
        <Button size="sm" onClick={save} disabled={pending || !name.trim()}>
          {x.create}
        </Button>
      </div>
    </div>
  );
}

/**
 * Register / edit a transaction (ADR-054). Primary: type, amount + currency, description,
 * category (searchable, with icons, created inline), Ámbito, account (created inline), date and
 * status. Secondary behind "Más detalles". Saves through the Finance tools, like Chat.
 */
export function TransactionDialog({
  open,
  onClose,
  transaction,
  duplicateOf,
  accounts,
  categories,
  books = [],
  defaultBook = null,
  defaultCurrency,
  today,
}: {
  open: boolean;
  onClose: () => void;
  /** Present when editing. */
  transaction?: FinanceTransaction | null;
  /** Prefills a new transaction from an existing one ("Duplicar"). */
  duplicateOf?: FinanceTransaction | null;
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  books?: FinanceBook[];
  /** The Book name preselected for new records (the one being viewed), else the default. */
  defaultBook?: string | null;
  defaultCurrency: string | null;
  today: string;
}) {
  const { t, locale } = useI18n();
  const x = t.finance.v21.tx;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const editing = Boolean(transaction);
  const source = transaction ?? duplicateOf ?? null;
  const initial = () => ({
    type: (source?.type ?? "expense") as TransactionType,
    amount: source ? typedAmount(source.amount, locale) : "",
    currency: source?.currency ?? defaultCurrency ?? "ARS",
    description: source?.description ?? "",
    date: transaction?.date ?? today,
    categoryId: source?.categoryId ?? "",
    // ADR-087: a new movement starts on the default account.
    account: source ? (source.account ?? "") : (accounts.find((a) => a.isDefault)?.name ?? ""),
    counterparty: source?.counterparty ?? "",
    project: source?.project ?? "",
    notes: source?.notes ?? "",
    status: transaction?.status ?? "completed",
    // ADR-087: every Ámbito it belongs to (none = "Sin clasificar").
    books: source
      ? (source.books ?? (source.book ? [source.book] : []))
      : [defaultBook ?? books.find((b) => b.isDefault)?.name].filter((b): b is string => !!b),
    toAccount: source?.toAccount ?? "",
    // ADR-089: what arrived, when the destination is in another currency.
    toAmount: source?.toAmount ? typedAmount(source.toAmount, locale) : "",
    toCurrency: source?.toCurrency ?? "",
    subcategory: source?.subcategory ?? "",
    receipt: transaction?.receipt ?? "",
  });
  const [v, setV] = useState(initial);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [extraCategories, setExtraCategories] = useState<FinanceCategory[]>([]);
  const [extraAccounts, setExtraAccounts] = useState<string[]>([]);
  const [creatingCategory, setCreatingCategory] = useState<string | null>(null);
  /** The inline account form: which field it fills and the name typed so far. */
  const [creatingAccount, setCreatingAccount] = useState<{
    field: "account" | "toAccount";
    name: string;
  } | null>(null);
  const marker = open ? (transaction?.id ?? `new:${duplicateOf?.id ?? ""}`) : null;
  if (marker !== openedFor) {
    // Each opening starts from the record (or empty) with a fresh idempotency key.
    setOpenedFor(marker);
    if (marker) {
      setV(initial());
      setMore(
        Boolean(source?.counterparty || source?.project || source?.notes || transaction?.receipt),
      );
      setError(null);
      setKey(crypto.randomUUID());
      setCreatingCategory(null);
      setCreatingAccount(null);
    }
  }
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: value }));
  const transfer = v.type === "transfer";
  // ADR-089: a transfer into another currency records what arrived, and the rate they imply.
  const fx = transfer && Boolean(v.toCurrency) && v.toCurrency !== v.currency;
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const sentNow = fx ? parseTypedAmount(v.amount, locale) : null;
  const receivedNow = fx ? parseTypedAmount(v.toAmount, locale) : null;
  const pair =
    sentNow && receivedNow
      ? impliedRate(
          { amount: sentNow, currency: v.currency },
          { amount: receivedNow, currency: v.toCurrency },
        )
      : null;
  const allCategories = [...categories, ...extraCategories];
  const compatible = allCategories.filter(
    (c) => transfer || c.type === v.type || c.type === "both",
  );
  const category = allCategories.find((c) => c.id === v.categoryId) ?? null;
  const accountNames = [...new Set([...accounts.map((a) => a.name), ...extraAccounts])];
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
      setError(v.amount.trim() ? t.finance.invalidAmount : x.required);
      return;
    }
    if (transfer && (!v.account || !v.toAccount || v.account === v.toAccount)) {
      setError(t.finance.ws.toAccount);
      return;
    }
    const received = fx ? parseTypedAmount(v.toAmount, locale) : null;
    if (fx && !received) {
      setError(x.receivedRequired);
      return;
    }
    setError(null);
    const fields = {
      type: v.type,
      amount,
      currency: v.currency,
      date: v.date,
      description: v.description.trim() || undefined,
      category: (!transfer && category?.name) || undefined,
      account: v.account || undefined,
      counterparty: v.counterparty.trim() || undefined,
      project: v.project.trim() || undefined,
      notes: v.notes.trim() || undefined,
      subcategory: v.subcategory.trim() || undefined,
      receipt: v.receipt.trim() || undefined,
      toAccount: (transfer && v.toAccount) || undefined,
      ...(received ? { toAmount: received, toCurrency: v.toCurrency } : {}),
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
            subcategory: fields.subcategory ?? null,
            receipt: fields.receipt ?? null,
            toAccount: fields.toAccount ?? null,
            // A transfer that no longer crosses currencies drops its received side.
            ...(!received && transaction?.toAmount ? { toAmount: null, toCurrency: null } : {}),
            ...(books.length ? { books: v.books } : {}),
            status: v.status,
          })
        : await financeToolAction(
            "finance.createTransaction",
            {
              ...fields,
              ...(v.books.length ? { books: v.books } : {}),
              status: v.status === "pending" ? "pending" : "completed",
            },
            key,
          );
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
      title={editing ? x.editTitle : x.newTitle}
      size="form"
      className="border-border-strong bg-[var(--overlay-bg)] shadow-[0_32px_96px_-24px_rgba(0,0,0,0.55)] sm:max-w-xl"
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
          aria-label={t.finance.accountType}
          className="grid grid-cols-3 gap-1 rounded-full border border-border bg-bg p-1"
        >
          {(["expense", "income", "transfer"] as const).map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={v.type === type}
              onClick={() => set("type", type)}
              className={cn(
                "h-9 rounded-full text-sm transition-colors",
                v.type === type
                  ? "bg-fg font-medium text-bg shadow-sm"
                  : "text-muted hover:text-fg",
              )}
            >
              {t.finance.types[type]}
            </button>
          ))}
        </div>

        <Field id="tx-amount" label={t.finance.amount}>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <Input
              id="tx-amount"
              data-autofocus=""
              inputMode="decimal"
              autoComplete="off"
              value={v.amount}
              placeholder={locale === "es" ? "48.000" : "25.50"}
              onChange={(e) => set("amount", e.target.value)}
              className="h-12 font-mono text-[18px]"
              aria-invalid={Boolean(error)}
            />
            <Select
              aria-label={t.finance.currency}
              value={v.currency}
              onChange={(e) => set("currency", e.target.value)}
              className="h-12"
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <Field id="tx-description" label={t.finance.description}>
          <Input
            id="tx-description"
            value={v.description}
            maxLength={300}
            placeholder={t.finance.descriptionPlaceholder}
            onChange={(e) => set("description", e.target.value)}
            className={FIELD}
          />
        </Field>

        {!transfer && (
          <Field id="tx-category" label={t.finance.category}>
            <Combobox
              id="tx-category"
              value={v.categoryId}
              inputClassName={FIELD}
              placeholder={x.searchCategories}
              emptyText={t.finance.noCategory}
              options={compatible.map((c) => ({
                value: c.id,
                label: `${categoryIcon(c)}  ${c.name}`,
                ...(c.parent ? { detail: c.parent } : {}),
                keywords: c.parent ?? "",
              }))}
              onChange={(id) => set("categoryId", id)}
              action={{ label: x.createCategory, onSelect: (q) => setCreatingCategory(q) }}
            />
          </Field>
        )}
        {creatingCategory !== null && !transfer && (
          <NewCategory
            initialName={creatingCategory}
            type={v.type === "income" ? "income" : "expense"}
            categories={allCategories}
            onCancel={() => setCreatingCategory(null)}
            onCreated={(c) => {
              setExtraCategories((cs) => [...cs.filter((y) => y.id !== c.id), c]);
              set("categoryId", c.id);
              setCreatingCategory(null);
              toast.success(x.created);
            }}
          />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {books.length > 0 && (
            <Field id="tx-book" label={t.finance.ws.book}>
              {/* Several Ámbitos at once (ADR-087); none selected = "Sin clasificar". */}
              <div
                id="tx-book"
                role="group"
                className="flex min-h-10 flex-wrap items-center gap-1.5"
              >
                {books.map((b) => {
                  const on = v.books.includes(b.name);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set(
                          "books",
                          on ? v.books.filter((n) => n !== b.name) : [...v.books, b.name],
                        )
                      }
                      className={cn(
                        "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] transition-colors",
                        on
                          ? "border-accent bg-accent-soft text-fg"
                          : "border-border text-muted hover:border-border-strong hover:text-fg",
                      )}
                    >
                      {on && <Check className="size-3.5" aria-hidden />}
                      {b.icon ? `${b.icon} ` : ""}
                      {b.name}
                    </button>
                  );
                })}
                {v.books.length === 0 && (
                  <span className="text-[12.5px] text-faint">{t.finance.ws.unclassified}</span>
                )}
              </div>
            </Field>
          )}
          {(transfer
            ? ([
                ["account", t.finance.ws.fromAccount],
                ["toAccount", t.finance.ws.toAccount],
              ] as const)
            : ([["account", t.finance.account]] as const)
          ).map(([k, label]) => (
            <Field key={k} id={`tx-${k}`} label={label}>
              <Combobox
                id={`tx-${k}`}
                value={v[k]}
                inputClassName={FIELD}
                placeholder={x.searchAccounts}
                emptyText={x.noAccount}
                options={[
                  ...(transfer ? [] : [{ value: "", label: x.noAccount }]),
                  ...accountNames.map((a) => ({ value: a, label: a })),
                ]}
                onChange={(a) => {
                  set(k, a);
                  // The destination's own currency, when it has one other than what left.
                  const cur = accounts.find((x) => x.name === a)?.currency;
                  if (k === "toAccount" && cur) set("toCurrency", cur === v.currency ? "" : cur);
                }}
                // Opens the inline form (even with nothing typed): it used to create an account
                // only from typed text, so a plain click did nothing.
                action={{
                  label: x.createAccount,
                  onSelect: (q) => setCreatingAccount({ field: k, name: q }),
                }}
              />
            </Field>
          ))}
          {creatingAccount && (
            <div className="sm:col-span-2">
              <NewAccount
                initialName={creatingAccount.name}
                currencies={currencies}
                onCancel={() => setCreatingAccount(null)}
                onCreated={(name) => {
                  // Only the account changes: amount, category, Ámbito, date and type stay.
                  setExtraAccounts((a) => [...a, name]);
                  set(creatingAccount.field, name);
                  setCreatingAccount(null);
                  toast.success(x.created);
                }}
              />
            </div>
          )}
          {transfer && (
            <div className="flex flex-col gap-2 sm:col-span-2">
              {fx ? (
                <>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                    <Field id="tx-received" label={x.received}>
                      <Input
                        id="tx-received"
                        inputMode="decimal"
                        placeholder="0"
                        value={v.toAmount}
                        onChange={(e) => set("toAmount", e.target.value)}
                        className={cn(FIELD, "font-mono")}
                      />
                    </Field>
                    <Field id="tx-received-currency" label={t.finance.currency}>
                      <Select
                        id="tx-received-currency"
                        value={v.toCurrency}
                        onChange={(e) => set("toCurrency", e.target.value)}
                        className={FIELD}
                      >
                        {currencies
                          .filter((c) => c !== v.currency)
                          .map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </div>
                  {/* The rate follows from the two amounts; editing it recomputes what arrived. */}
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <label htmlFor="tx-rate">{x.rate}</label>
                    <span>1 {pair?.base ?? v.currency} =</span>
                    <Input
                      id="tx-rate"
                      inputMode="decimal"
                      value={rateDraft ?? (pair ? typedAmount(pair.rate, locale) : "")}
                      onFocus={() => setRateDraft(pair ? typedAmount(pair.rate, locale) : "")}
                      onBlur={() => setRateDraft(null)}
                      onChange={(e) => {
                        setRateDraft(e.target.value);
                        const rate = parseTypedAmount(e.target.value, locale);
                        const sent = parseTypedAmount(v.amount, locale);
                        if (!rate || !sent) return;
                        const base = pair?.base ?? v.currency;
                        const got =
                          base === v.currency
                            ? multiplyByRate(sent, rate)
                            : divideByRate(sent, rate);
                        set("toAmount", typedAmount(got, locale));
                      }}
                      className="h-9 w-36 font-mono"
                    />
                    <span>{pair?.quote ?? v.toCurrency}</span>
                    <button
                      type="button"
                      onClick={() => setV((s) => ({ ...s, toAmount: "", toCurrency: "" }))}
                      className="ml-auto text-[12.5px] text-faint hover:text-fg"
                    >
                      {x.sameCurrency}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    set("toCurrency", currencies.find((c) => c !== v.currency) ?? "USD")
                  }
                  className="self-start text-[12.5px] text-accent-text hover:underline"
                >
                  {x.otherCurrency}
                </button>
              )}
            </div>
          )}
          <Field id="tx-date" label={t.finance.date}>
            <Input
              id="tx-date"
              type="date"
              required
              value={v.date}
              onChange={(e) => set("date", e.target.value)}
              className={FIELD}
            />
          </Field>
          <Field id="tx-status" label={t.finance.status}>
            <Select
              id="tx-status"
              value={v.status}
              onChange={(e) => set("status", e.target.value as typeof v.status)}
              className={FIELD}
            >
              {(editing
                ? (["completed", "pending", "cancelled"] as const)
                : (["completed", "pending"] as const)
              ).map((st) => (
                <option key={st} value={st}>
                  {t.finance.statuses[st]}
                </option>
              ))}
            </Select>
          </Field>
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
          <div className="grid gap-3 sm:grid-cols-2">
            {!transfer && (
              <Field id="tx-subcategory" label={t.finance.ws.subcategory}>
                <Input
                  id="tx-subcategory"
                  value={v.subcategory}
                  maxLength={80}
                  placeholder="ChatGPT, Meta Ads…"
                  onChange={(e) => set("subcategory", e.target.value)}
                  className={FIELD}
                />
              </Field>
            )}
            <Field id="tx-who" label={t.finance.counterparty}>
              <Input
                id="tx-who"
                value={v.counterparty}
                maxLength={200}
                placeholder={t.finance.counterpartyPlaceholder}
                onChange={(e) => set("counterparty", e.target.value)}
                className={FIELD}
              />
            </Field>
            <Field id="tx-project" label={t.finance.project}>
              <Input
                id="tx-project"
                value={v.project}
                maxLength={120}
                placeholder={t.finance.projectPlaceholder}
                onChange={(e) => set("project", e.target.value)}
                className={FIELD}
              />
            </Field>
            <Field id="tx-receipt" label={t.finance.ws.receipt}>
              <Input
                id="tx-receipt"
                value={v.receipt}
                maxLength={500}
                placeholder={t.finance.ws.receiptPlaceholder}
                onChange={(e) => set("receipt", e.target.value)}
                className={FIELD}
              />
            </Field>
            <Field id="tx-notes" label={t.finance.notes} className="sm:col-span-2">
              <textarea
                id="tx-notes"
                rows={2}
                maxLength={2000}
                value={v.notes}
                onChange={(e) => set("notes", e.target.value)}
                className={textareaClass}
              />
            </Field>
          </div>
        )}
        {error && (
          <p role="alert" className="text-[13.5px] text-danger-text">
            {error}
          </p>
        )}
        <div
          data-sheet-actions
          className="flex items-center justify-end gap-2 border-t border-border pt-4"
        >
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
