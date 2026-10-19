"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Input, Label, Select } from "@/components/ui/input";
import { suggestCategoryIcon, type FinanceCategory } from "@/core/capabilities/finance";
import type { PublicError } from "@/core/errors";
import { cleanCategoryName, duplicateCategory } from "@/core/finance/combine";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { categoryUsageAction, financeToolAction } from "./actions";

type C = ReturnType<typeof useI18n>["t"]["finance"]["v21"]["categories"];

/** Finance errors in plain words: a database that's behind is never "not connected". */
export function financeErrorText(
  t: ReturnType<typeof useI18n>["t"],
  e: PublicError,
  fallback: string,
): string {
  if (e.code === "CAPABILITY_UNAVAILABLE") return t.finance.v21.categories.needsUpdate;
  if (e.code === "INTERNAL_ERROR" || e.code === "NOT_FOUND") return fallback;
  return errorText(t, e);
}

/**
 * One category, saved as you go (ADR-083): a short pause after typing, leaving the field or Enter
 * commits; Escape reverts. Saves run one after another with the latest text, so a slow earlier
 * request can never overwrite a newer name. A duplicate is refused inline and the name reverts.
 */
function CategoryRow({
  cat,
  categories,
  onChanged,
  onRemove,
  busy,
}: {
  cat: FinanceCategory;
  categories: FinanceCategory[];
  onChanged: () => void;
  onRemove: (cat: FinanceCategory) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const c = t.finance.v21.categories;
  const type = cat.type === "income" ? "income" : "expense";
  const [name, setName] = useState(cat.name);
  const [icon, setIcon] = useState(cat.icon ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef({ name: cat.name, icon: cat.icon ?? "" });
  const draft = useRef({ name: cat.name, icon: cat.icon ?? "" });
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const typeLabel = type === "expense" ? c.expense : c.income;
  const problem = (n: string) => {
    const clean = cleanCategoryName(n);
    if (!clean) return null;
    const dup = duplicateCategory(categories, clean, type, cat.id);
    return dup ? c.duplicateIn(dup.name, typeLabel) : null;
  };

  /** Save whatever the latest draft is, after any save already on its way. */
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    queue.current = queue.current.then(async () => {
      const next = { name: cleanCategoryName(draft.current.name), icon: draft.current.icon };
      const before = saved.current;
      if (!next.name || problem(next.name)) return;
      if (next.name === before.name && next.icon === before.icon) return;
      setSaving(true);
      const r = await financeToolAction("finance.updateCategory", {
        category: cat.id,
        ...(next.name !== before.name ? { name: next.name } : {}),
        ...(next.icon !== before.icon ? { icon: next.icon || null } : {}),
      });
      setSaving(false);
      if (!r.ok) {
        // Back to what the server has; say why, right here.
        draft.current = { ...before };
        setName(before.name);
        setIcon(before.icon);
        setError(
          r.error.code === "CONFLICT" ? c.duplicate : financeErrorText(t, r.error, c.saveFailed),
        );
        return;
      }
      saved.current = next;
      if (draft.current.name === next.name) setName(next.name); // tidy spacing once saved
      setError(null);
      onChanged();
    });
  };

  const typed = (value: string) => {
    setName(value);
    draft.current = { ...draft.current, name: value };
    setError(problem(value));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };

  const leave = () => {
    // A name that can't be saved (empty, duplicate) goes back to the saved one.
    if (!cleanCategoryName(name) || problem(name)) {
      const bad = problem(name);
      draft.current = { ...draft.current, name: saved.current.name };
      setName(saved.current.name);
      setError(bad);
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    flush();
  };

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <EmojiPicker
          value={icon}
          onChange={(next) => {
            setIcon(next);
            draft.current = { ...draft.current, icon: next };
            flush(); // an icon is one deliberate choice: saved at once
          }}
          label={`${c.icon}: ${cat.name}`}
          placeholder={suggestCategoryIcon(name) ?? "•"}
        />
        <Input
          aria-label={`${c.rename}: ${cat.name}`}
          value={name}
          maxLength={80}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `cat-err-${cat.id}` : undefined}
          onChange={(e) => typed(e.target.value)}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape" && name !== saved.current.name) {
              // Undo this edit (the dialog stays open).
              e.preventDefault();
              e.stopPropagation();
              if (timer.current) clearTimeout(timer.current);
              draft.current = { ...saved.current };
              setName(saved.current.name);
              setError(null);
            }
          }}
          className="h-10 min-w-0 flex-1"
        />
        {cat.parent && (
          <span className="hidden text-[12px] text-faint sm:inline">{cat.parent}</span>
        )}
        <span className="grid size-5 shrink-0 place-items-center" aria-live="polite">
          {saving && (
            <>
              <Loader2 className="size-4 text-faint motion-safe:animate-spin" aria-hidden />
              <span className="sr-only">{c.saving}</span>
            </>
          )}
        </span>
        <button
          type="button"
          aria-label={`${c.delete}: ${cat.name}`}
          title={c.delete}
          disabled={busy}
          onClick={() => onRemove(cat)}
          className="grid size-10 shrink-0 place-items-center rounded-xl text-faint hover:bg-danger/10 hover:text-danger-text disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      {error && (
        <p id={`cat-err-${cat.id}`} role="alert" className="pl-12 text-[12.5px] text-danger-text">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Categories (ADR-054/083): create (duplicates refused before asking the server), rename and
 * change icons with autosave, and delete — movements are always kept, uncategorized.
 */
export function CategoryManager({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: FinanceCategory[];
}) {
  const { t } = useI18n();
  const c: C = t.finance.v21.categories;
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [changed, setChanged] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("");
  const [newType, setNewType] = useState<"expense" | "income">("expense");
  const [newError, setNewError] = useState<string | null>(null);
  const visible = categories.filter((x) => !removed.has(x.id));
  const dup = newName.trim() ? duplicateCategory(visible, newName, newType) : null;
  const dupText = dup
    ? c.duplicateIn(dup.name, newType === "expense" ? c.expense : c.income)
    : null;

  const close = () => {
    // Other screens (movements, budgets) pick up names and icons once, when done.
    if (changed) router.refresh();
    setChanged(false);
    onClose();
  };

  const remove = async (cat: FinanceCategory) => {
    const usage = await categoryUsageAction(cat.id);
    if (!usage.ok) return void toast.error(financeErrorText(t, usage.error, c.deleteFailed));
    const { transactions, budgets, children } = usage.value;
    const ok = await confirm({
      title: c.deleteTitle(cat.name),
      body: (
        <div className="flex flex-col gap-1.5">
          <p>{transactions ? c.deleteUsed(transactions) : c.deleteUnused}</p>
          {budgets > 0 && <p>{c.deleteBudgets(budgets)}</p>}
          {children > 0 && <p>{c.deleteChildren(children)}</p>}
        </div>
      ),
      confirmLabel: c.delete,
      destructive: true,
    });
    if (!ok) return;
    startTransition(async () => {
      const r = await financeToolAction("finance.deleteCategory", { category: cat.id });
      if (!r.ok) return void toast.error(financeErrorText(t, r.error, c.deleteFailed));
      setRemoved((s) => new Set([...s, cat.id]));
      toast.success(
        c.deleted,
        transactions ? { description: c.deletedDetached(transactions) } : undefined,
      );
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      busy={pending}
      title={c.title}
      className="border-border-strong bg-[var(--overlay-bg)] sm:max-w-2xl"
    >
      <form
        className="flex flex-col gap-2 rounded-2xl border border-border bg-bg p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim() || dup) return;
          startTransition(async () => {
            const r = await financeToolAction("finance.createCategory", {
              name: cleanCategoryName(newName),
              type: newType,
              ...(newIcon ? { icon: newIcon } : {}),
            });
            if (!r.ok)
              return setNewError(
                r.error.code === "CONFLICT"
                  ? c.duplicate
                  : financeErrorText(t, r.error, c.saveFailed),
              );
            setNewName("");
            setNewIcon("");
            router.refresh();
          });
        }}
      >
        <Label htmlFor="newcat">{t.finance.addCategory}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <EmojiPicker
            value={newIcon}
            onChange={setNewIcon}
            label={c.icon}
            placeholder={suggestCategoryIcon(newName) ?? "•"}
          />
          <Input
            id="newcat"
            value={newName}
            maxLength={80}
            placeholder={t.finance.categoryPlaceholder}
            aria-invalid={Boolean(newError || dupText)}
            aria-describedby={newError || dupText ? "newcat-err" : undefined}
            onChange={(e) => {
              setNewName(e.target.value);
              setNewError(null);
            }}
            className="h-10 min-w-40 flex-1"
          />
          <Select
            aria-label={t.finance.accountType}
            value={newType}
            onChange={(e) => setNewType(e.target.value as "expense" | "income")}
            className="h-10 w-auto"
          >
            <option value="expense">{c.expense}</option>
            <option value="income">{c.income}</option>
          </Select>
          <Button type="submit" disabled={pending || !newName.trim() || Boolean(dup)}>
            <Plus />
            {t.finance.v21.tx.create}
          </Button>
        </div>
        {(newError || dupText) && (
          <p id="newcat-err" role="alert" className="text-[12.5px] text-danger-text">
            {newError ?? dupText}
          </p>
        )}
      </form>
      {(["expense", "income"] as const).map((type) => {
        const list = visible.filter((x) => x.type === type || x.type === "both");
        if (!list.length) return null;
        return (
          <section key={type} className="flex flex-col gap-1.5">
            <h3 className="type-label text-faint">{type === "expense" ? c.expense : c.income}</h3>
            <ul className="flex flex-col divide-y divide-border">
              {list.map((cat) => (
                <CategoryRow
                  key={cat.id}
                  cat={cat}
                  categories={visible}
                  busy={pending}
                  onChanged={() => setChanged(true)}
                  onRemove={(x) => void remove(x)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </Dialog>
  );
}
