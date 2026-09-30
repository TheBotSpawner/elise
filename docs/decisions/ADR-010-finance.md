# ADR-010 — Finance: ELISE Finance, imports and Google Sheets

**Status:** Accepted (2026-09-30)

## Context

Finance should be a real structured capability (docs/architecture/10 §20-26, 16 §49-59).
It must be usable from the UI and from Chat, work across currencies without inventing exchange
rates, import existing spreadsheets, and read Google Sheets that people already maintain. It is
not banking: there are no bank connections, payments, investments or taxes.

## Decisions

1. **Capability and providers.** Model-facing tools are canonical `finance.*`:
   - reads: `getSummary`, `query`, `listTransactions`, `getTransaction`, `listAccounts`,
     `listCategories`;
   - writes: `createTransaction`, `updateTransaction`, `archiveTransaction`, `createAccount`,
     `updateAccount`, `createCategory`, `undoImport`.

   ELISE Native is the default provider. Each Google connection with Sheets allowed gets a
   Finance binding with `read` permission. Reads resolve to every relevant binding and are
   merged. Writes always go to ELISE Finance, and policy rejects writes to a sheet.
2. **Money.** Amounts are stored as `numeric(20,4)`, always positive, with the direction given
   by the type. They are read as text (`amount::text`) and summed as scaled BigInts in
   `core/finance/money.ts`. No floats are used. Currencies are ISO-shaped codes.
3. **Currencies are never mixed.** Every total is per currency. `finance_settings.reporting_currency`
   is prepared, but nothing converts: no FX source is configured, and the model is told not to
   convert. `default_currency` (Finance → Main currency) resolves "20 de supermercado". Otherwise
   the tool uses the account's currency, or the only currency ever used, or asks.
4. **Deterministic analysis.** Summaries, breakdowns, comparisons (previous period or the same
   dates last year) and insights are computed in Core as mergeable partial aggregates, so native
   data plus several sheets combine exactly. The two insight types are a category moving at
   least 30% (and at least 10% of spending), and an expense at least 3× its category's average
   over 3+ records. The model only explains. Pending and cancelled records are excluded from
   totals by default and reported as excluded.
5. **Generic imports.** `imports` / `import_rows` handle CSV and XLSX (`read-excel-file`, numbers
   kept as their exact text) and Google Sheets. The steps are: inspect, then mapping (header
   rules in English and Spanish, with AI filling only the gaps and only with known fields), then
   the user confirms, then Core validates every row. Ambiguous dates (03/04) and amounts
   (1.234) are never guessed. Duplicates are matched by fingerprint (date, type, amount,
   currency, counterparty) against ELISE Finance and skipped unless included. Re-importing an
   identical file is flagged. Imports of 500 rows or fewer run inline. Larger ones run on
   Trigger.dev (`finance-import`), and a retry safely restarts. Undo archives what one import
   created, and always asks when proposed by ELISE.
6. **Connected Google Sheets.** A `finance_sources` row stores the spreadsheet id, tab id and the
   mapping. The sync (`finance-sync`, hourly dispatch plus Sync now) reads unformatted values
   and normalizes them with the same code as imports. It mirrors rows read-only into
   `finance_source_rows`, keyed by content fingerprint plus occurrence. Rows are never
   vectorized and never put in AI context. The sheet stays the source of truth, and ELISE never
   writes to it.
7. **No double counting.** Importing a sheet that is also connected turns that source's
   "Count in totals" off. Connecting a tab that was imported starts with it off. Lists flag
   records that look identical across sources instead of silently merging them. Every result
   names its sources.
8. **Privacy.** The Morning Brief Finance block is off by default. The browser notification is
   always "Morning Brief ready". Audit events carry counts and ids, never amounts or rows.
   Disconnecting a Google account or a sheet deletes its mirrored rows.

## Consequences

- Connected-sheet answers are as fresh as the last sync (shown as "Synced …").
- Entities don't exist yet: `project` is a free label and `entity_id` is reserved.
- No budgets, forecasts, transfers or FX conversion in this milestone.
