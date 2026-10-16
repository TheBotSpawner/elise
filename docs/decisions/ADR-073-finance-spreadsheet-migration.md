# ADR-073: Finance spreadsheet migration — flexible interpretation, deterministic integrity

**Status:** Accepted (2026-10-16). Builds on docs/architecture/10 §37-43 (Finance import),
ADR-052/054 (Books, transfers). No migration.

## Context

A real export from a phone money-manager app (518 movements) ended in "Hay datos que no son
válidos". The causes were stacked:

1. **The reader couldn't open the file.** The zip was streamed (data descriptors, zip64 headers),
   and `read-excel-file` failed with "invalid signature".
2. **Emoji were corrupted.** They were stored as `&#x1f35c;` and the reader truncated them to
   16 bits ("🍜 Food" became U+F35C).
3. **Columns were ambiguous:**
   - two columns named `Account`, the second a numeric copy of the amount;
   - the amount written twice (`ARS` and `Amount`);
   - the useful text in `Note`, while `Description` was empty on 512 of 518 rows.
4. **Types weren't recognized.** `Transfer-Out` was unknown, and transfers carry their
   destination in the category column.
5. **Accounts and categories matched only by exact name.** "Cash" would have created a second
   account next to the user's "Efectivo".
6. **One broken amount cell sank the mapping.** It pushed the column below a 0.9 "numeric"
   threshold, so the amount column was dropped and nothing imported.

## Decision

The pipeline is: upload → inspect → infer → resolve names → preview (correctable) → background
import in chunks → result, with history and undo.

- **File reading** (`infrastructure/finance/spreadsheet.normalizeXlsx`):
  - every `.xlsx` is re-read from the central directory with `fflate` and re-zipped as a
    standard zip;
  - supplementary-plane character references are spelled out, so the reader sees real emoji;
  - an OLE container (a password-protected workbook or a legacy `.xls`) is refused with a clear
    reason;
  - only stored values are read: no macros, no formula evaluation.
- **Schema inference** (`core/finance/inference`), deterministic:
  - **Profiling:** columns are profiled from their values (filled, numeric, date, type, distinct
    and text shares) on a sample of 400 rows.
  - **Sheet:** the one that clearly holds transactions; dashboards and summaries rank last.
  - **Header row:** the top row naming the most finance fields; titles and notes above it are
    skipped.
  - **Mapping:** header synonyms propose and the values decide.
    - An account or category column must be text.
    - The description is the most informative text column, and a second text column becomes
      the note.
    - A column with the same amount on every row is read once ("duplicate").
    - A currency-named amount column also gives the currency.
    - A named amount or date column tolerates broken cells (0.6); those rows are reported one by
      one.
  - **The model** (`suggestMappingWithAI`) is called only when date, amount, description and
    account or category aren't all settled. It sees only headers and five clipped sample rows.
- **Values:**
  - dates may carry a time of day; the day/month order comes from the whole column, never
    guessed for a single value;
  - types include directed transfers (`Transfer-Out` / `-In`, traspaso), deposit, purchase and
    withdrawal;
  - amounts stay exact decimals, as before.
- **Transfers:** without a destination column, the other account is the category value
  (`Transfer-In` swaps the sides), and the category is dropped. A transfer is imported only when
  both sides are the user's accounts: one they have, or one the file itself uses as an account.
  Otherwise it is held for the user. Live connected sheets keep showing one-sided transfers as
  before.
- **Names** (`core/finance/resolve`): every distinct account and category name (categories per
  type) is resolved once, and every row reuses the decision.
  - **Matching** ignores emoji, symbols, accents and case.
  - **Order:** exact → the person's aliases → a bilingual synonym table (Cash ↔ Efectivo,
    Food ↔ Comida, BNA ↔ Banco Nación…) → conservative look-alikes (spacing, a name contained in
    one other) → one model call for whatever is left (`matchEntitiesWithAI`, which may only
    name an existing record, checked by code) → a new record.
  - **Ambiguity** ("Banco" with two banks) goes to the user, never guessed. Rows that depend on
    an undecided name are held, not dropped.
- **Decisions** are stored in the mapping (`entities`). The user corrects them in the preview,
  once per name, and the run reuses them with no model call. New accounts and categories are
  created once per import ("Cash", "cash", "CASH" create one).
- **Aliases:** when a name meant something else ("Cash" → "Efectivo"), it is remembered in
  `user_preferences` (`finance.import.aliases`). It is per person and workspace, never shared,
  and limited to the latest 300 names per kind.
- **Background import:** files over 500 rows run in the existing Trigger.dev `finance-import`
  task, which stays thin (`runFinanceImport`).
  - **Chunks:** rows are written in chunks of 100. Each chunk records its `import_rows`, and
    that count is the live progress (`financeImportStatus`). The screen polls it and the user
    can leave.
  - **Idempotency:** a run first removes what an earlier attempt left. A retry or a second click
    never writes twice, and confirming twice is refused ("already ran").
  - **Duplicates:** rows already in Finance (same fingerprint) are skipped as duplicates, and
    the same transfer seen from both accounts counts once.
  - **Partial failure:** invalid rows are recorded with their reason, so 1 bad row never sinks
    517.
- **Provenance:** each movement keeps `import_id` and `import_row_number`. "Deshacer importación"
  archives only that import's movements (as before, audited).
- **UI:**
  - the preview runs as soon as the file is read: "Encontré N movimientos…" or "Necesito que
    elijas…";
  - the columns read and those left out, accounts and categories with a selector each, and the
    held rows;
  - the column editor stays available, folded;
  - then progress (N / M, "Podés cerrar esta pantalla") and the result (imported, duplicates,
    to review, incomplete).
- **Google Sheets "Importar"** goes through the same pipeline. A connected live sheet stays a
  source of truth, with no copies.
- **Privacy:** logs carry counts, ids and error classes, never cell values or descriptions.
  Model calls get headers, five clipped sample rows and distinct names, never the file.

## Consequences

- **The regression file:**
  - Money Manager sheet; Date, Account (text), Category, Note as description, Amount, Income/
    Expense, Currency ARS;
  - ARS and the second Account ignored as copies;
  - 517 of 518 valid (one row with amount 0) and 20 transfers;
  - Cash → Efectivo, Mercado Pago exact, NaranjaX and BNA created.
- **Not built:**
  - re-importing held rows after the import finished (they stay listed in the import's
    issues);
  - cancelling an import that is already running;
  - starting an import from a chat attachment.
- **Review count:** "to review" counts rows held by a name. "Incomplete" counts rows with
  missing or invalid data.
