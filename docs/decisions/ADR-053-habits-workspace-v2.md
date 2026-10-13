# ADR-053: Habits workspace v2 — ranges, analytics, icons, lifecycle

**Status:** Accepted (2026-10-12). Extends the Habits capability (docs/architecture/10
§13-15). Migration `20261021000040_habits_v2.sql` (delete policy only).

## Context

My Elise → Habits was a weekly tracker in one narrow column: day cells per habit, done /
target and a streak. It couldn't answer "how am I doing this month?", "which habit am I
dropping?" or "what days do I miss?". Pause and Archive sat on every row. A Grit-like app
was the UX reference only; the UI stays ELISE.

**Non-negotiable:**

- the day-by-day grid stays;
- every past day stays editable;
- numbers are deterministic, and the model explains them but never computes them.

## Decision

### Model (no new columns)

- **`habits.metadata` holds two new fields:**
  - `icon`: one emoji, validated on write and on read. No text, no markup, never SVG.
  - `pausedUntil`: a pause end date.
- **Delete:** migration 040 grants members `delete` on `habits`; check-ins cascade. Before
  the migration, delete answers "needs the latest database update". Goals, lists and notes
  still only archive.
- **Nothing derived is stored:** no completion, streak or weekly totals are persisted.

### One analytics layer: `core/habits/analytics.ts`

The same code serves the screen (client-side, from the loaded check-ins), `habits.getStats`
(chat + Canvas) and, through `habitProgress`, the Morning Brief.

- **Ranges:**
  - week (Mon–Sun), calendar month, calendar year, or custom (≤ 2 years);
  - ‹ › shifts by the same span; "Hoy" returns to the current one.
- **Expected day:** scheduled (daily, or one of the chosen weekdays), on or after the habit's
  start. A day the user recorded anyway also counts (backfilled history). Unscheduled days
  are rest, never failures.
- **Done and goal per habit type:**
  - **daily / specific_days:** `done` = met days; `goal` = expected days in the range. A day
    is met when its value reaches the daily target, so quantities can be partial.
  - **weekly:** each ISO week contributes `target × (its expected days in range) / 7`;
    `done` sums sessions (or the quantity) per week, capped at that share, so one heavy
    week can't hide a missed one. Session goals display rounded (13, not 13.3).
- **Progress vs completion:**
  - **progress** = done / goal for the whole period: "2 / 3 this week".
  - **completion (rate)** = achieved / expected *so far* (days ≤ today): what was actually
    done.
  - For past periods both are equal.
- **Summary:**
  - active habits only;
  - overall completion = Σ achieved / Σ expected;
  - comparison with the previous equal period, in percentage points.
- **Trend granularity:** ≤ 14 days by day, ≤ 120 days by week, longer by month.
- **Other derived views:**
  - per-weekday misses (daily / specific-day habits);
  - daily consistency heatmap (share of active habits with a check-in);
  - monthly rates for the year.

### Streaks (unchanged semantics, now documented and exported)

- **Daily / specific days:** consecutive *scheduled* days met, counted back from today.
  - Today counts once met.
  - An open today doesn't break the streak.
  - Unscheduled days are skipped.
- **Weekly:** consecutive ISO weeks whose target was reached, counted back from last week;
  the current week is added once reached.
- **Longest streak:** the same rule over the whole history. The detail view loads that one
  habit's full history; the screen never does.

### Risk (deterministic)

- **Weekly sessions:** at risk once the target needs every day left (Friday 0/3 is at risk;
  Monday 0/3 isn't). "Unreachable" when it can't be met any more (Saturday 0/3).
- **Weekly quantities:** at risk on the last day left, since a quantity can be caught up in
  one day.
- **Daily / specific days:** they need every scheduled day by definition, so they're at risk
  once a scheduled day of the week was missed.

### Screen

- **Wide workspace:** a `PageContainer wide` variant (1440px). Other pages keep 960px.
- **Toolbar:**
  - left: Semana | Mes | Año | Personalizado, ‹ label ›, and Hoy;
  - right: Activos / Pausados / Archivados with counts, search (from 7 habits), ⋯ menu
    (Importar CSV, Exportar datos), and **Nuevo hábito**.
- **Summary strip:** completion with its pp change, active, at risk, best streak.
- **Rows:**
  - icon, name, target, progress bar with done/goal and %, risk line, ⋯ menu (statistics,
    edit, pause / resume, archive / restore, delete);
  - week: seven day cells; month / short custom: a calendar; year / long custom: monthly
    bars that drill into the month.
- **Day editing:**
  - a binary day toggles;
  - a quantity opens a small editor (−/+, value, complete target, clear) — a popover on
    desktop, a bottom sheet on mobile;
  - future days are disabled; archived habits are read-only.
- **Optimistic writes:** the grid changes at once and only that check-in is written, with no
  page revalidation. Realtime refreshes the view for changes from Chat or other devices
  (own writes are ignored for 4 s).
- **Side column:**
  - completion trend, completion by habit, consistency heatmap, days most missed;
  - or, when a habit is selected, its detail: range progress, completion vs previous
    period, current and longest streak, quantity totals, average and target attainment,
    trend, last 12 weeks.
  - Below `xl` the detail is a full-screen sheet.
- **Empty state:** with optional starters that prefill the form; nothing is created
  automatically.

### Tools, Chat and Canvas

- **`habits.getStats`:** week / month / year, any calendar period or from/to. It returns the
  report and draws:
  - KPI (completion vs previous, sparkline);
  - the week grid, or one habit's month as week rows;
  - completion by habit (hbar);
  - completion trend (line).
- **Surface identity:** `habit:<id|all>:<view>:<from>`. Lifecycle re-runs `habits.*` reads
  after any habit write, so a check-in by chat or UI refreshes the visible Surface in place.
- **Tool changes:**
  - `habits.pause` takes `days` / `until`, and the habit resumes on that local day;
  - `habits.restore` (unarchive);
  - `habits.delete` is destructive and always asks when ELISE proposes it; a UI action is
    the confirmation;
  - create / update take `icon`; when the model gives none, a deterministic suggestion from
    the name is used.

## Consequences

- **Easier:**
  - month / year questions are answered with numbers and charts that match the screen
    exactly;
  - icons and progress make the list scannable.
- **Harder:**
  - completion vs progress are two numbers; the UI labels them, and the ADR defines them.
- **Not done:**
  - categories / groups;
  - streak-milestone celebrations;
  - a curated non-emoji icon set;
  - swipe navigation on mobile (buttons instead);
  - pause history (a pause applies to the present; past paused days still count as
    expected).
