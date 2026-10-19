"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import type { FinanceCategory, FinanceTransaction } from "@/core/capabilities/finance";
import type { CombinePlan } from "@/core/finance/combine";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { financeToolAction } from "./actions";
import { financeErrorText } from "./category-manager";
import { useMoney } from "./format";

/**
 * "Combinar N movimientos" (ADR-083): the result is shown before anything happens — account,
 * signed total, date — computed exactly from the selection; description and category can be
 * changed. The originals are kept and the detail of the result can undo it.
 */
export function CombineDialog({
  rows,
  plan,
  categories,
  onClose,
  onDone,
}: {
  rows: FinanceTransaction[];
  plan: Extract<CombinePlan, { ok: true }> | null;
  categories: FinanceCategory[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const k = t.finance.combine;
  const money = useMoney();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [description, setDescription] = useState(plan?.description ?? k.defaultDescription);
  const [category, setCategory] = useState(plan?.categoryId ?? "");
  if (!plan) return null;
  const options = categories.filter((c) => c.type === plan.type || c.type === "both");
  const date = new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${plan.date}T00:00:00Z`));
  const facts: [string, string, string?][] = [
    [k.account, plan.account ?? "—"],
    [
      k.result,
      `${plan.type === "income" ? "+" : "−"} ${money(plan.amount, plan.currency)}`,
      plan.type === "income" ? "text-success" : undefined,
    ],
    [k.date, date],
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      busy={pending}
      title={k.title(rows.length)}
      className="border-border-strong bg-[var(--overlay-bg)] sm:max-w-md"
    >
      <p className="text-[14px] text-muted">{k.body(rows.length)}</p>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-2xl border border-border p-4 text-[14px]">
        {facts.map(([label, value, cls]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className={cn("font-medium", label === k.result && "font-mono", cls)}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="combine-desc">{k.description}</Label>
        <Input
          id="combine-desc"
          value={description}
          maxLength={300}
          onChange={(e) => setDescription(e.target.value)}
          className="h-10"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="combine-cat">{k.category}</Label>
        <Select
          id="combine-cat"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-10"
        >
          <option value="">{k.none}</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          {t.common.cancel}
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await financeToolAction("finance.combineTransactions", {
                transactions: rows.map((x) => x.id),
                description: description.trim() || k.defaultDescription,
                category: category || null,
              });
              if (!r.ok) return void toast.error(financeErrorText(t, r.error, k.failed));
              toast.success(k.done(rows.length));
              onDone();
              router.refresh();
            })
          }
        >
          {k.confirm}
        </Button>
      </div>
    </Dialog>
  );
}
