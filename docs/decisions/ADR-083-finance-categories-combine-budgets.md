# ADR-083: Finance v3 — atomic category deletion, normalized names, combined movements, multi-category budgets

**Status:** Accepted (2026-10-19). Builds on ADR-052, ADR-054 and ADR-075.

## Context

Testing surfaced one bug and several improvements:

- **The bug:** deleting a category showed "Eso todavía no está conectado". The delete action
  was wired correctly; it needed migration 048 (a `DELETE` grant and policy on
  `finance_categories`), which production didn't have. The provider read the permission error
  as "needs a database update" (`CAPABILITY_UNAVAILABLE`), and the UI showed that code's generic
  copy.
- **Improvements:** autosaved category edits, deterministic duplicate protection, faster
  selection (long press, right-click), combining movements, and budgets over several categories.

## Decision

- **Category deletion** is one database function, `finance_delete_category` (migration 052):
  - its movements become uncategorized, never deleted;
  - subcategories move up;
  - budgets lose the link, and a budget left with no category is archived (never deleted).

  It's `SECURITY DEFINER`, checks workspace membership itself, and answers "not found" to
  outsiders, so it no longer depends on a user `DELETE` grant. Finance UIs show their own copy:
  "No pudimos eliminar la categoría", or "necesita una actualización de ELISE" when the database
  is behind. The generic "no está conectado" is never used for them.
- **Names:** before checking for duplicates, ELISE cleans the name (NFC, trimmed, inner spaces
  collapsed) and compares it case-insensitively within its type. Regalos · Gasto and Regalos ·
  Ingreso can coexist.
  - The existing `(workspace, type, lower(name))` index stays.
  - Migration 052 adds a whitespace-insensitive unique index only when no legacy rows collide
    (otherwise it reports them and skips the index; nothing is merged silently).
  - The UI refuses duplicates inline before asking the server.
- **Autosave:** a row saves after 700 ms of pause, on blur or on Enter; Escape reverts. Saves run
  one after another with the latest draft, so a slow earlier request can't overwrite a newer
  name. A failure restores the saved name inline. The rest of Finance refreshes once, when the
  dialog closes.
- **Selection:** one model (`selected`) with three entry points: the "Seleccionar" button, a
  long press on touch (500 ms, cancelled by moving more than 10 px), and ELISE's own right-click
  menu on desktop (Seleccionar / Quitar de la selección, Editar, Eliminar).
- **Combinar:**
  - **Allowed only for** ≥ 2 active income/expense movements with the same account, currency,
    scope (Book) and status. Never transfers or connected-sheet rows, and never a zero result.
  - **Result:** the signed sum (income +, expense −) in exact decimals, on the latest date. The
    category is kept only if all sources share it; the description only if they're all equal
    (otherwise "Movimiento combinado"). Both are editable before confirming.
  - **Atomicity:** `finance_combine_transactions` (security invoker: RLS applies) locks the rows,
    validates, inserts the result (`merged_source_count`), and archives and links the sources
    (`merged_into_transaction_id`, `merged_at`). Their import ids, fingerprints and provenance
    are untouched.
  - **Undo:** `finance_uncombine_transaction` restores the sources and archives the result.
  - **Safeguards:** a merged source can't be restored on its own. Chat sees the tool, but it
    always needs approval (`combineTransactions: always_ask`).
- **Budgets:**
  - `finance_budget_categories` links a budget to one or more categories (RLS, same-workspace
    trigger). Every legacy budget was backfilled from its `category_id`, which stays for the
    single-category case and is null for several.
  - Budgets gain an optional `name` and `icon` (one emoji, validated).
  - Spending budgets list expense categories only. A subcategory is allowed only with a single
    category.
  - Spend is the exact sum over every chosen category (and their subcategories) in the budget's
    currency; other currencies are counted apart, never converted.
  - `finance.setBudget` takes `categories: [...]`, so one request creates one budget.
  - On screen: one modal for create and edit (icon, name, searchable multi-select, amount,
    currency, scope), cards, and a compact empty state. Deleting a budget archives it.

## Consequences

- All of this needs migration `20261103000052_finance_categories_merge_budgets.sql`.
  - Without it, Finance keeps working the v2 way: deletion through 048,
    single-category budgets.
  - Combining reports "necesita una actualización".
- Combining is reversible and auditable; there is no hard delete.
