# ADR-052: Finance Workspace v2 — Books, budgets, rates, reports

**Status:** Accepted (2026-10-12). Extends the Finance capability (ADR on Finance in
`docs/architecture`), the canonical `finance.*` tools and the import pipeline. Migration
`20261020000039_finance_v2.sql` (requires 038).

## Context

My Elise → Finance was one long page: totals, two charts, a flat list and the catalogs. A
real user (the Firbot workbook, "Seguimiento Finanzas 2026") keeps personal and business money
in one ledger, in ARS, NZD and USD, with categories like "Gastos - Herramientas", budgets per
category, and needs a PDF to share. Money Manager was the information-architecture reference;
the UI stays ELISE.

Constraints that don't move:

- Never sum different currencies. Originals (amount + currency) are never rewritten.
- Transfers between own accounts are neither income nor expense.
- Every number is computed deterministically by ELISE (BigInt decimal math). The model quotes;
  it never adds, converts or averages.
- No stored month / year / week columns: they are derived from the date.
- Standard charts only (bars, hbar, donut ≤ 6 slices, line, progress, tables).

## Decision

### Books (Ámbitos)

- **`finance_books`:** name, type (personal / business / other), icon, description, optional
  reporting currency, one default per workspace (partial unique index), archive.
- A Book says **who the money belongs to** (Personal, Firbot). It is not a category and never
  appears in category pickers.
- `finance_transactions.book_id` is nullable: null is **"Sin clasificar"** (filterable via the
  `__unclassified` sentinel). Nothing is guessed.
- **Resolution when recording** (chat, UI, import):
  1. the Book the user named;
  2. else the account's `default_book_id`;
  3. else the default Book.
  An unknown Book name → the tool asks; it never creates silently (except an import column
  naming a Book, which creates it, like categories).
- `listBooks` lazily creates "Personal" as the default the first time.
- `finance_categories.book_ids` (empty = every Book) and `finance_sources.book_id` exist for
  scoping; the UI doesn't filter categories by Book yet.

### Transfers and receipts

- **Transfers:** type `transfer` with `account_id` → `to_account_id`, both required. Excluded
  from income / expense / net everywhere; counted and reported separately ("N transferencias
  no cuentan…").
- **`receipt`** (comprobante): free text, a link or an id. Links open from the detail panel.
- **Pending / completed** status is unchanged. Totals count completed only and say how many
  pending were left out. The Movements list shows both.

### Conversion

- **`finance_fx_rates`:** user-entered, dated (`1 from = rate to` from `effective_date`), one
  per pair per day.
- A conversion happens **only** when a reporting currency is asked for:
  - each transaction is converted at the latest rate on/before its own date;
  - an inverse pair is used when needed;
  - rows without a rate are counted as unconverted, not summed.
- The result lists every rate used. Per-currency totals stay authoritative.

### Budgets

- **`finance_budgets`:** monthly, per Book (optional) + category (+ optional subcategory), one
  currency, unique per scope.
- **Usage counts:**
  - completed expenses of that category (and its children) in the month, same currency;
  - other currencies and pending rows are reported, not added.
- **States use exact integer comparisons:**
  - warning at ≥ 80%;
  - "over" (limit reached) at ≥ 100%.
- Reports scale a monthly limit by the months the range touches.

### Workspace UI

- **Header:**
  - Book selector (Todos · each Book · Sin clasificar; hidden until Books exist);
  - Sources;
  - **Registrar movimiento**.
- **Tabs:** Movimientos · Análisis · Presupuestos, plus Reportes, which opens its own page.
- **Period:**
  - current month by default;
  - ‹ › steps by the same span (whole months stay months);
  - presets, or a custom from / to.
  - Everything lives in the URL.
- **KPIs:** Ingresos / Gastos / Neto per currency, with change vs the previous period.
- **Movimientos:**
  - filters: search, type incl. transfer, category, account, currency, pending only;
  - list grouped by day, with Book and status chips;
  - detail panel: all fields, origin, receipt; Edit, Mark as done, Archive with a 10 s Undo
    (`finance.restoreTransaction`);
  - accounts (default Book), default currency and categories below.
- **Análisis:**
  - per currency: trend (income vs expense bars, a line past 24 points), expense donut,
    ranked bars by category (income and expense), top clients / providers, projects and
    Books;
  - bars drill down into Movimientos filters;
  - spending without a category shows as "Sin categoría", never dropped.
- **Presupuestos:** progress bars with spent / limit / remaining and the 80 / 100 states.

### Reports

- `finance.createReport` builds one `FinanceReport` (`core/finance/report.ts`) from the
  filtered ledger. The same dataset feeds three outputs:
  - **ELISE's answer**;
  - the **preview page** `/my-elise/finance/reports?…`, with a configurator: Book, period
    (default last 30 days), sections, reporting currency; Download / Refresh;
  - the **PDF** `/api/finance/report?…`:
    - built with `pdf-lib`, a pure-JS dependency added for this;
    - standard fonts, so text is normalized to WinAnsi;
    - header, per-currency summary, conversion with rates, trend bars, category / budget /
      counterparty bars, transaction table, page numbers.
- **Sections:** summary, kpis, trend, categories, budgets, counterparties, transactions,
  notes, receipts. Notes and receipts are off by default.
- Rankings are per currency: never merged, never dropped.

### Import (the workbook's Movimientos sheet)

- **Header synonyms** map the sheet:
  - Fecha, Tipo, Monto (positivo) (not "Monto neto"), Moneda;
  - Medio → account, Categoría, Subcategoría;
  - Cliente/Proveedor → counterparty, Producto/Proyecto → project;
  - Estado, Comprobante → reference + receipt, Notas.
- **A new `book` field** (Ámbito / Book / Libro). The mapping may also carry `defaultBookId`.
- **Category names drop a type prefix** ("Gastos - Herramientas" → "Herramientas").
- **Learned classification:** a row without category / Book takes the latest classification
  of the same counterparty (or description) in the user's history.
- **Book precedence:** file column → mapping default → learned → account default → default
  Book.
- Mes / Año / Semana columns are ignored (derived data).
- **Dedupe** by fingerprint, as before:
  - new;
  - repeated in file (possible duplicate);
  - already in ELISE (duplicate, skipped unless included);
  - needs review (invalid rows).
- Transfers never add to the preview totals.
- **Google Sheets stays a live, read-only source.** Importing is the alternative, not a
  replacement.

### Pre-migration behaviour

Production may lag the migration. Then:

- reads degrade: no Books, budgets or rates; the Book selector, budgets and conversion are
  hidden or empty;
- v2 writes (Books, budgets, rates, transfers, default Book) answer "needs the latest ELISE
  database update";
- everything else works as before.

## Consequences

- **Easier:**
  - one ledger for personal and business money, filtered by Book everywhere (chat, UI,
    reports);
  - a shareable PDF whose numbers match the screen exactly.
- **Harder:**
  - Books are another dimension to keep consistent; null stays a first-class "Sin
    clasificar" instead of a backfill guess;
  - rates are user-maintained: ELISE never fetches FX rates, so conversion is only as good as
    what the user enters.
- **Not done (later):**
  - per-Book category filtering in pickers;
  - recurring budgets other than monthly;
  - Realtime on books / budgets tables (added once production has 039);
  - attaching receipt files (the field stores a link or id today);
  - charts in the PDF beyond bars.
