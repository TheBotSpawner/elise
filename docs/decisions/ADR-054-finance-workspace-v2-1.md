# ADR-054: Finance Workspace v2.1 — information architecture and manual entry

**Status:** Accepted (2026-10-13). Refines ADR-052 (domain unchanged). Migration
`20261022000041_finance_category_icons.sql` (category icon column).

## Context

The v2 domain worked, but the screen didn't:

- **The empty state hid the app.** With no rows in the current month (and no filters), the
  page swapped the whole workspace for "Empezá con un gasto". Imported history from earlier
  months never showed unless the user changed the period.
- **The column was narrow.** `PageContainer` capped every page at 960px, about a third of a
  wide monitor.
- **Manual entry was weak.** The category sat in "Más detalles", had no icons, and couldn't be
  created from the transaction flow.

## Decision

- **The shell is always rendered:**
  - Ámbito chips, with `+` to create a Book;
  - Movimientos / Estadísticas / Presupuestos / Reportes (Reportes keeps its own page with the
    same nav);
  - Día / Semana / Mes / Año / Personalizado with ‹ › and Hoy (default: current month);
  - Ingresos / Gastos / Neto per currency.
- **Empty states:**
  - onboarding only when the workspace has *no* finance data at all (one-row probe on
    transactions and sheet rows);
  - otherwise a compact "No hay movimientos en octubre" inside the feed, with Registrar and
    Importar;
  - a loading skeleton route prevents empty → data flashes.
- **Period state** lives in the URL: `gran` plus `date` (anchor), or `from` / `to`. Chat
  `period` presets keep working. Spans are deterministic (`spanOf`), and ‹ › uses
  `shiftPeriod`.
- **Layout:**
  - `PageContainer wide` (1440px), only for Finance and Habits;
  - Movimientos: filter bar plus the feed grouped by day, with same-currency day totals
    (exact decimal sums) and a side summary (top categories, budgets at risk, by Ámbito);
  - Estadísticas: a 2-column dashboard — income vs expenses, category donut, ranking,
    expense evolution, income by category, by Ámbito (all Books only), clients / providers /
    projects (business Books only). Series stop at today.
- **Drill-down:** ranking bars and side lists filter the feed; active filters show as
  removable chips.
- **Manual entry:**
  - primary fields: type, amount + currency, description, category (searchable, icons),
    Ámbito, account, date, status;
  - "+ Crear categoría" (icon, name, optional parent) and "+ Crear cuenta" inline, then
    selected;
  - opaque elevated modal surface;
  - detail opens as a right drawer (bottom sheet on mobile) with Edit, Duplicate,
    Mark done / pending, and Archive (with Undo) under ⋯.
- **Categories:**
  - optional `icon` (one emoji, validated by the shared `isSingleEmoji`);
  - without one, a deterministic suggestion from the name is shown;
  - `finance.updateCategory` renames, changes icon / parent or archives; it never deletes,
    and transactions keep their category;
  - a category manager and an account manager (with default currency) live under ⋯.
- **Imports** start from the header (Importar). The Sources page shares the same upload hook.

## Consequences

- Finance looks like a finance app whether or not the period has rows.
- **Before migration 041,** icons can't be saved: suggestions are shown, and changing an
  icon reports the pending update.
- **Not done:**
  - category merge;
  - clicking a chart point to select a period (the ‹ › and granularity controls do this);
  - a separate quarter granularity (Personalizado covers it).
