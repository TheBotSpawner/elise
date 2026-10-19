import { describe, expect, it } from "vitest";

import {
  bookIdsOf,
  budgetUsage,
  inBudget,
  matchesFilter,
  UNCLASSIFIED,
  type Budget,
  type FinanceTransaction,
} from "@/core/capabilities/finance";
import { isSingleEmoji } from "@/core/emoji";
import { cleanCategoryName, duplicateCategory, planCombine } from "@/core/finance/combine";

/**
 * Finance v3 rules (ADR-083): duplicate categories by normalized name and type, combinable
 * selections (same account and currency, signed exact sums), and budgets over several categories.
 */
const tx = (over: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: crypto.randomUUID(),
  type: "expense",
  amount: "100",
  currency: "ARS",
  date: "2026-10-10",
  description: null,
  counterparty: null,
  category: null,
  categoryId: null,
  categoryPath: [],
  subcategory: null,
  account: "Mercado Pago",
  accountId: "acc-mp",
  paymentMethod: null,
  project: null,
  status: "completed",
  notes: null,
  importId: null,
  bookId: null,
  readOnly: false,
  fingerprint: "fp",
  provenance: {
    providerKey: "elise_native",
    connectionId: "c",
    source: "ELISE Finance",
    sourceId: null,
    row: null,
  },
  updatedAt: "2026-10-10T00:00:00Z",
  ...over,
});

describe("category names", () => {
  const cats = [
    { id: "a", name: "Regalos", type: "expense" as const },
    { id: "b", name: "Sueldo", type: "income" as const },
  ];
  it("same normalized name and type is a duplicate; casing and spaces don't matter", () => {
    for (const name of ["Regalos", "  regalos ", "REGALOS", "Regalos "])
      expect(duplicateCategory(cats, name, "expense")?.id).toBe("a");
  });
  it("same name in another type is fine; renaming to itself is fine", () => {
    expect(duplicateCategory(cats, "Regalos", "income")).toBeNull();
    expect(duplicateCategory(cats, "regalos", "expense", "a")).toBeNull();
  });
  it("cleaning keeps the person's casing and collapses spaces only", () => {
    expect(cleanCategoryName("  Salidas   con  amigos ")).toBe("Salidas con amigos");
    expect(cleanCategoryName("Café")).toBe("Café"); // NFC
  });
  it("arbitrary emoji stay valid icons (ZWJ, flags, skin tones, variation selectors)", () => {
    for (const e of ["🍊", "👩‍💻", "🇦🇷", "👍🏽", "❤️", "🧑🏻‍🍳"]) expect(isSingleEmoji(e)).toBe(true);
    for (const bad of ["ab", "🍊🍊", "", "<svg>"]) expect(isSingleEmoji(bad)).toBe(false);
  });
});

describe("combining movements", () => {
  it("income +10.000, expenses −2.000 and −1.500 → + 6.500, latest date", () => {
    const plan = planCombine([
      tx({ type: "income", amount: "10000", date: "2026-10-01" }),
      tx({ amount: "2000", date: "2026-10-18" }),
      tx({ amount: "1500", date: "2026-10-05" }),
    ]);
    expect(plan).toMatchObject({
      ok: true,
      type: "income",
      amount: "6500",
      date: "2026-10-18",
      currency: "ARS",
    });
  });
  it("exact decimals, and an expense when the sum is negative", () => {
    expect(planCombine([tx({ amount: "0.10" }), tx({ amount: "0.20" })])).toMatchObject({
      ok: true,
      type: "expense",
      amount: "0.3",
    });
  });
  it("same category on all is kept; mixed → none; same description kept, else none", () => {
    const same = planCombine([
      tx({ categoryId: "c1", description: "Uber" }),
      tx({ categoryId: "c1", description: "Uber" }),
    ]);
    expect(same).toMatchObject({ categoryId: "c1", description: "Uber" });
    const mixed = planCombine([
      tx({ categoryId: "c1", description: "A" }),
      tx({ categoryId: "c2", description: "B" }),
    ]);
    expect(mixed).toMatchObject({ categoryId: null, description: null });
  });
  it("refuses with a reason: one movement, other account, other currency, transfers, zero, sheet rows", () => {
    const reason = (rows: FinanceTransaction[]) => {
      const p = planCombine(rows);
      return p.ok ? "ok" : p.reason;
    };
    expect(reason([tx({})])).toBe("too_few");
    expect(reason([tx({}), tx({ accountId: "acc-bna" })])).toBe("accounts");
    expect(reason([tx({}), tx({ currency: "USD" })])).toBe("currencies");
    expect(reason([tx({}), tx({ type: "transfer", toAccountId: "x" })])).toBe("not_combinable");
    expect(reason([tx({}), tx({ readOnly: true })])).toBe("not_combinable");
    expect(reason([tx({ type: "income" }), tx({})])).toBe("zero");
    // None has an account (recorded by chat without one): they combine; a mix doesn't.
    expect(reason([tx({ accountId: null }), tx({ accountId: null })])).toBe("ok");
    expect(reason([tx({ accountId: null }), tx({})])).toBe("accounts");
    expect(reason([tx({}), tx({ bookId: "firbot" })])).toBe("scopes");
  });
});

describe("budgets over several categories", () => {
  const budget: Budget = {
    id: "salidas",
    name: "Salidas",
    icon: "🍽️",
    bookId: null,
    book: null,
    categoryIds: ["rest", "bares", "ocio"],
    categories: ["Restaurantes", "Bares", "Entretenimiento"],
    category: "Salidas",
    subcategory: null,
    currency: "ARS",
    amount: "200000",
  };
  it("adds every chosen category (and their subcategories), nothing else; no currency mixing", () => {
    const rows = [
      tx({ amount: "50000", categoryId: "rest", categoryPath: ["Restaurantes"] }),
      tx({ amount: "30000", categoryId: "bares", categoryPath: ["Bares"] }),
      tx({ amount: "48000", categoryId: "cine", categoryPath: ["Entretenimiento", "Cine"] }),
      tx({ amount: "99999", categoryId: "super", categoryPath: ["Supermercado"] }),
      tx({ amount: "10", currency: "USD", categoryId: "rest", categoryPath: ["Restaurantes"] }),
    ];
    const u = budgetUsage(budget, rows);
    expect(u.spent).toBe("128000");
    expect(u.percentTenths).toBe(640);
    expect(u.otherCurrencies).toBe(1);
  });
});

describe("several Ámbitos per movement (ADR-087)", () => {
  const both = tx({
    bookId: "personal",
    bookIds: ["personal", "firbot"],
    books: ["Personal", "Firbot"],
  });
  it("a movement shows up under each of its Ámbitos, and not as unclassified", () => {
    expect(matchesFilter(both, { book: "firbot" })).toBe(true);
    expect(matchesFilter(both, { book: "personal" })).toBe(true);
    expect(matchesFilter(both, { book: "Firbot" })).toBe(true); // by name
    expect(matchesFilter(both, { book: "otro" })).toBe(false);
    expect(matchesFilter(both, { book: UNCLASSIFIED })).toBe(false);
    expect(matchesFilter(tx({}), { book: UNCLASSIFIED })).toBe(true);
  });
  it("a budget of one Ámbito counts movements that also belong to another", () => {
    const b = {
      bookId: "firbot",
      categoryIds: ["c"],
      categories: ["Software"],
      subcategory: null,
    } as Budget;
    expect(inBudget({ ...both, categoryId: "c", categoryPath: ["Software"] }, b)).toBe(true);
  });
  it("rows from before several were possible still count by their single Ámbito", () => {
    expect(bookIdsOf(tx({ bookId: "personal" }))).toEqual(["personal"]);
  });
  it("combining needs the same set of Ámbitos (order doesn't matter)", () => {
    const a = tx({ bookIds: ["personal", "firbot"] });
    const b2 = tx({ bookIds: ["firbot", "personal"] });
    expect(planCombine([a, b2]).ok).toBe(true);
    expect(planCombine([a, tx({ bookIds: ["personal"] })])).toMatchObject({
      ok: false,
      reason: "scopes",
    });
  });
});
