# ADR-055: Goals v2 — Visions, periods, habit linking, progress history

**Status:** Accepted (2026-10-14). Extends Goals (docs/architecture/10 §27-29).
Migration `20261023000042_goals_v2.sql`.

## Context

My Elise → Goals was a narrow list:

- goals were binary, numeric or percentage, with manual / linked / hybrid progress;
- `goal_links` already pointed at habits, tasks, goals and notes.

Gaps:

- no long-term Visions;
- no time horizon;
- no progress history;
- no risk;
- the Canvas only had a generic progress chart.

"Linked" progress averaged the share of linked tasks done with *this week's* habit adherence.
That number means nothing for "workout 36 times in 12 weeks". Notion screenshots were an
information-architecture reference only.

**Non-negotiable:**

- only two concepts, Vision and Goal: no annual or quarterly goal entities;
- progress, risk and dates are computed in code;
- goals and habits link from both sides;
- existing data and the Habits screen keep working;
- Canvas Surfaces update in place and never duplicate.

## Decision

### Model

- **Visions:** a new table `visions`.
  - Fields: title (the statement), description, icon (emoji), optional area, status
    active / achieved / archived.
  - No metric, no date, never a percentage.
  - Workspace RLS; members may delete one. Its goals stay.
- **Goals** stay the one goal table. New columns:
  - `icon`, `area`;
  - `period_start` / `period_end`: the time horizon;
  - `currency`: money goals.
  - Measures map onto existing columns, so no redundant types:

    | Measure | Columns |
    | --- | --- |
    | binary | `progress_type = binary` |
    | number / count | `numeric` |
    | percentage | `percentage` |
    | currency | `numeric` + `currency` |
    | lower is better | `numeric` + `direction = decrease` |

- **Period vs deadline:**
  - the period is stored as dates, never as a label;
  - `target_date` is the deadline. It defaults to the period's end and moves with it unless the
    user set another one.
- **Links reuse `goal_links`:**
  - new resource type `vision` (many-to-many);
  - unique per goal and record, so links never duplicate;
  - goal ↔ goal is stored once: a trigger refuses the reverse row;
  - "Contribuye a" is `parent_goal_id`. A trigger refuses circular chains, and the tools check
    first with a clear message.
  - Deleting a habit, goal or Vision removes the links pointing at it. Rows left dangling by
    habit deletes under 040 are cleaned.
- **Habit "use for progress"** reuses `relationship_type`:
  - for habit and task links, `supports` / `milestone` drive progress and `related` is
    context only;
  - existing links keep their meaning;
  - habits are context by default, unless asked.
- **History:** `goal_progress_events` (append-only: no update or delete grants).
  - Manual changes are recorded with an optional note.
  - Existing goals get one `system` event with today's value.
  - Linked history is derived from habit check-ins and task completions, never duplicated
    as events.
- **Delete:** members may delete goals. History and links cascade; archive stays the
  default.
- **Older databases:** before 042, writes drop the v2 columns, Visions and history read as
  empty, and Vision writes answer "needs the latest database update".

### Deterministic logic (`core/goals`)

- **Periods** (`periods.ts`):
  - presets: this/next quarter, Q1–Q4, this/next year, 3/6/12 months, custom, none;
  - Q1–Q4 without a year means the next one that hasn't ended;
  - labels are derived from dates: "T4 2026", "Q4 2026", "2027", "T1–T2 2027".
- **Progress** (`capabilities/goals.ts`):
  - numeric goals that go up add their driving links: each met habit day counts 1 (its
    quantity when the habit's unit is the goal's metric), each completed task counts 1,
    inside the goal's window (its period, or since it was created);
  - linked = start + linked amount; hybrid = manual value + linked amount;
  - binary and percentage goals use the share of driving tasks done;
  - lower-is-better goals are manual: (start − current) / (start − target);
  - habits never drive binary, percentage or decreasing goals.
- **Health** (`analytics.ts`):
  - not started: the period begins later, or 0% in the first quarter of the window;
  - at risk: past the deadline without the target, or — after a quarter of the window —
    more than 15 points behind the time elapsed ("Queda el 25% del período y llevás el 20%");
  - on track otherwise;
  - in progress when nothing can be measured (binary goals, or no deadline);
  - reaching the target never completes a goal: it is shown and suggested;
  - recent velocity isn't used: a straight line is easier to explain.
- **Analytics:** filters (status, period overlap, Vision, area, related habit, search), sorts
  (attention, progress, deadline, created, title), a summary, and per-Vision counts.

### Tools, Chat, voice and the Canvas

- **New tools:** `goals.updateProgress` (value / add + note), `goals.getVision`,
  `createVision`, `updateVision`, `deleteVision` (approval), `goals.restore`,
  `goals.delete` (approval).
- **`goals.create`** takes everything in one call: period, deadline, icon (suggested when
  absent), area, Visions, habits (with `useForProgress`), parent.
  - A Vision is linked only when the name matches exactly one; otherwise the result says so
    and creation isn't blocked.
- **`goals.update`** replaces the full sets of Visions, habits and related goals (the form
  sends them). `goals.list` takes status (including `at_risk`), period, Vision and area.
- **Progress source follows the links:** a goal something drives becomes linked (hybrid if
  it already has a manual value); with nothing driving it, it is manual again.
- **Habit side:** `habits.create` / `update` accept `goals` (replacing the set). They write
  the same `goal_links` rows, so both directions always agree.
- **Surfaces:** `goal` (`goal:<id>`), `vision` (`vision:<id>`) and `goals_overview`
  (`goals:<status>:<from>:<to>:<vision>`).
  - Goal and Vision Surfaces always re-read their own tool, like the List Surface.
  - Habit check-ins and task changes now refresh goal Surfaces (lifecycle).
  - A goal changed by voice updates its open Surface in place.
- **Routing:** "visión", "logros" and "¿cómo vengo…?" load the goal tools. The guidance
  covers inference, periods, linking, splitting a goal (only when asked) and never
  self-completing.
- **Morning Brief:** reuses the same snapshots and mentions only goals that are at risk, due
  within 14 days, reached, or completed in the last two days. Schedules use the same brief
  blocks.

### Screen

- **Layout:** wide container.
  - Toolbar: Activos / En riesgo / Logros / Todos with counts, search, ⋯ (import CSV,
    archived, new Vision), **+ Nuevo objetivo** (key `n`).
  - Second row: period, compact Filtros (Vision, area, habit) with removable chips, sort,
    and a Lista / Timeline toggle.
- **Content:** a summary strip, Vision cards (counts, never a %), and goal cards
  (icon, title, Vision or area, period, bar with value and %, status with icon and text,
  deadline, habit count, risk reason).
  - Clicking the value opens the quick progress editor (value ±, note; a bottom sheet on
    mobile).
- **Side column:** analytics (progress by goal, by status, by Vision), or the selected goal
  or Vision.
  - Goal detail: ring, source, history line chart and entries, Visions, parent, contributing
    and related goals, related habits this week; ⋯ holds pause, archive and delete.
  - Below `xl` the detail is a full-screen sheet.
- **One dialog** for create and edit:
  - primary fields: icon, name, measure, target and unit or currency, period;
  - optional fields one tap away: Vision, habits (with the progress switch), description,
    deadline, area, contributes to, related goals;
  - safe suggestions from the name for untouched fields.
- **Vision dialog:** statement, icon, description, area.
- **Habits form:** "Objetivos relacionados" with "Usar para el progreso". Rows show the
  related goal.

## Consequences

- **Easier:**
  - "¿cómo vengo con mis objetivos de este trimestre?" and "¿qué está atrasado?" are answered
    with numbers and Surfaces that match the screen;
  - habit check-ins move numeric goals honestly.
- **Changed on purpose:** linked progress of existing goals.
  - Weekly habit adherence no longer counts as goal %.
  - Numeric goals with linked tasks now count completed tasks toward the number.
  - Lower-is-better goals in linked mode show "not measurable" until a manual value exists.
- **Not done:**
  - weighted parent progress: parents are contextual, and weights would have to be
    configured;
  - an area-management screen: areas are free text with suggestions;
  - Notion-style tables;
  - finance-derived goal progress;
  - the risk rule ignores recent velocity;
  - relation suggestions beyond resolving named Visions and habits in one call.
