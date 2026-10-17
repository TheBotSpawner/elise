# ADR-075: Finance native UX, category deletion and one import pipeline

**Status:** Accepted (2026-10-17). Extends ADR-031 (chat attachments), ADR-054 (categories) and
ADR-073 (spreadsheet migration). Migration `20261030000048_finance_category_delete.sql` adds the
delete policy on `finance_categories`.

## Decisions

- **No browser dialogs in product flows.** `window.prompt`, `confirm` and `alert` are not used.
  - Confirmations use `useConfirm()` (`components/ui/confirm.tsx`): one shared native `<dialog>`,
    a bottom sheet on phones.
  - Creation flows ("Nuevo ámbito") use their own `Dialog` with inline validation.
- **Back navigation** is `BackLink` ("‹ Volver a Importar"). The whole row is the link. It is only
  used for returning to a parent page, never on a plain heading.
- **Category icons** are one Unicode emoji, picked with `EmojiPicker` (the same picker for create
  and edit). That covers ZWJ sequences, skin tones, flags and keycaps, up to 16 code points. "No
  icon" is `null`.
- **Categories are addressed by id.** `finance.updateCategory` and `finance.deleteCategory` accept
  an id (the UI always sends one) or a name. The same name can exist as an expense and as an
  income ("Préstamos"), so a name that matches both asks which one. A duplicate name is a
  `CONFLICT`, shown as "Ya existe una categoría con ese nombre.".
- **Deleting a category never deletes history.**
  - It is a single `DELETE`, so it's atomic through the existing foreign keys:
    - movements keep their rows and become uncategorized (`category_id → null`);
    - subcategories become top-level;
    - the category's budgets are removed.
  - The confirmation shows how many movements (and budgets, subcategories) are affected.
  - From chat, deletion always needs approval.
- **One import pipeline.**
  - A CSV or .xlsx attached in chat goes through `analyzeAttachmentImport`, which copies the
    attachment's original stored bytes into a normal Finance import.
  - It then runs the same `inspectImport` and `previewFinanceImport` as the Finance screen.
  - The chat card (`finance_import` surface) offers the file's currency, "Revisar" (the same
    wizard) and "Importar" (the same confirm).
  - Imports run in Trigger.dev whenever it's configured, whatever their size or origin. They
    appear in the import history.
- **Spreadsheets are structured attachments.**
  - CSV and .xlsx have kind `spreadsheet`.
  - The model receives a bounded summary (sheets, headers, row and column counts, first rows),
    never raw text marked "truncated". Tools read the stored original.
  - Only byte-level checks (a missing object, a size mismatch, a parser failure) report a
    broken upload.
- **Import inference.**
  - The CSV delimiter is sniffed (`,` `;` tab).
  - A type column is only taken from its values, never from a header that says "type".
  - Amounts with both signs and no type column default to the "sign" strategy (positive is
    income, negative is expense), shown as a file-level control next to the warnings.
  - A file without a currency column uses the workspace's Finance currency, or asks once for
    the whole file.
  - Uncategorized rows import as "Sin categoría".
- **Provider formats layer over the generic inference** (`core/finance/formats.ts`). The Mercado
  Pago settlement report is recognized by its headers and maps:
  - `TRANSACTION_DATE` → date;
  - `TRANSACTION_AMOUNT` → amount (fee and tax stay as provenance in `import_rows.raw_data`);
  - `TRANSACTION_TYPE` → description;
  - `PAYMENT_METHOD_TYPE` → payment method (never the type);
  - `SOURCE_ID` → reference.

  The direction comes from the amount's sign, and every row belongs to the "Mercado Pago"
  account. A file that matches no format is inferred as before. Dedupe stays on the compound
  fingerprint, since `SOURCE_ID` can repeat across events.
