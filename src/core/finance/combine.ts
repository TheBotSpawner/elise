import {
  bookIdsOf,
  type FinanceCategory,
  type FinanceTransaction,
} from "@/core/capabilities/finance";

import { fromUnits, toUnits } from "./money";

/**
 * Finance v3 rules (ADR-083), deterministic and shared by the UI, the tools and the tests. The
 * database enforces the same rules again; these let the screen explain before anyone tries.
 */

/** How a category name is written: NFC, trimmed, inner spaces collapsed. Casing is kept. */
export const cleanCategoryName = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/g, " ");

/** What makes two names "the same category" within one type (case-insensitive). */
export const categoryKey = (name: string) => cleanCategoryName(name).toLocaleLowerCase("und");

/**
 * The existing category the name would duplicate within that type, if any. "both" categories
 * count for each type. Same name in another type (Regalos · Gasto / Regalos · Ingreso) is fine.
 */
export function duplicateCategory(
  categories: readonly Pick<FinanceCategory, "id" | "name" | "type">[],
  name: string,
  type: "expense" | "income",
  exceptId?: string,
) {
  const key = categoryKey(name);
  return (
    categories.find(
      (c) =>
        c.id !== exceptId && (c.type === type || c.type === "both") && categoryKey(c.name) === key,
    ) ?? null
  );
}

export type CombineBlock =
  | "too_few"
  | "not_combinable"
  | "no_account"
  | "accounts"
  | "currencies"
  | "scopes"
  | "statuses"
  | "zero";

export type CombinePlan =
  | { ok: false; reason: CombineBlock }
  | {
      ok: true;
      type: "income" | "expense";
      /** Positive amount of the result (exact decimal string). */
      amount: string;
      currency: string;
      accountId: string | null;
      account: string | null;
      date: string;
      /** Same category on all → kept; otherwise none (never a guess). */
      categoryId: string | null;
      /** Same description on all → kept; otherwise the caller's default. */
      description: string | null;
    };

const distinct = <T>(xs: T[]) => new Set(xs).size;

/** Whether the selection can be combined, and into what (signed, exact arithmetic). */
export function planCombine(rows: readonly FinanceTransaction[]): CombinePlan {
  if (rows.length < 2) return { ok: false, reason: "too_few" };
  if (
    rows.some((r) => r.readOnly || (r.type !== "income" && r.type !== "expense") || r.toAccountId)
  )
    return { ok: false, reason: "not_combinable" };
  // One account, or none on every movement.
  if (distinct(rows.map((r) => r.accountId ?? null)) > 1) return { ok: false, reason: "accounts" };
  if (distinct(rows.map((r) => r.currency)) > 1) return { ok: false, reason: "currencies" };
  if (distinct(rows.map((r) => [...bookIdsOf(r)].sort().join(","))) > 1)
    return { ok: false, reason: "scopes" };
  if (distinct(rows.map((r) => r.status)) > 1) return { ok: false, reason: "statuses" };
  const sum = rows.reduce(
    (acc, r) => acc + (r.type === "income" ? toUnits(r.amount) : -toUnits(r.amount)),
    0n,
  );
  if (sum === 0n) return { ok: false, reason: "zero" };
  const categories = distinct(rows.map((r) => r.categoryId ?? null));
  const descriptions = distinct(rows.map((r) => (r.description ?? "").trim()));
  return {
    ok: true,
    type: sum > 0n ? "income" : "expense",
    amount: fromUnits(sum > 0n ? sum : -sum),
    currency: rows[0]!.currency,
    accountId: rows[0]!.accountId ?? null,
    account: rows[0]!.account,
    date: rows
      .map((r) => r.date)
      .sort()
      .at(-1)!,
    categoryId: categories === 1 ? (rows[0]!.categoryId ?? null) : null,
    description:
      descriptions === 1 && rows[0]!.description?.trim() ? rows[0]!.description.trim() : null,
  };
}
