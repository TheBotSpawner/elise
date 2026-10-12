# ADR-050: Tasks Workspace — subtasks, labels, ELISE enrichment of provider tasks

**Status:** Accepted (2026-10-12). Extends ADR-009 (unified tasks) and ADR-046 (live tasks).
Migration `20261018000037_tasks_workspace.sql`.

## Context

My Elise → Tasks was a single narrow column, which made it hard to manage hundreds of tasks.
The product wants a real task workspace: views, lists by account, search, filters, detail,
subtasks, priority and labels. Two rules from ADR-009 hold:

- Google Tasks stays the source of truth for Google-owned tasks.
- One read path feeds every screen.

## Decision

### 1. Model and capabilities

`Task` gains three optional fields:

- `parentId`;
- `labels` (names);
- `position` (the provider's own order).

Priority keeps the existing `low | medium | high` model, shown as P3, P2 and P1. No second
priority model is introduced.

`TASK_CAPABILITIES` declares per provider what it can hold:

| | ELISE Native | Google Tasks |
| --- | --- | --- |
| title, description, due date, completion | ✅ | ✅ (description = Notes) |
| due time | ❌ | ❌ (the API keeps the date only) |
| subtasks | ✅ `parent_task_id` | ✅ Google's `parent` (`?parent=` on insert) |
| move between lists | ✅ | ✅ Google's `move?destinationTasklist=` (same account only) |
| priority | ✅ native column | ELISE enrichment |
| labels | ✅ ELISE labels | ELISE enrichment |

The UI and the tools read this matrix. No React component checks provider names to decide
which actions exist.

### 2. Google Notes are the description

`normalizeTask` maps Notes to `description` and sets `notes` to null. Writes to the description
go to Notes, and nothing is duplicated.

### 3. The enrichment layer, not a copy

`EnrichedTaskProvider` wraps every task provider in `elise.ts`. `TaskEnrichmentStore` keeps
what a provider can't:

- `task_enrichments`: workspace, provider, connection, the provider's list id and task id,
  and `priority`. It never holds a title, status, due date, notes, parent or list.
- `labels` and `label_assignments`: one generic, workspace-scoped label system. An assignment
  targets either a native `task_id` or an `enrichment_id`, never both. Other domains, such as
  Lists, add their own target column.

How it behaves:

- **Reads** take three workspace-scoped queries per request, shared by every provider, so there
  is no N+1. Filters that depend on ELISE data (search over labels, priority, label) run after
  merging, so they mean the same for every provider.
- **Writes are split.** Provider fields go to the provider. ELISE-only fields go to the store,
  and Google never receives a priority or a label.
- **Cleanup:**
  - Deleting a task through ELISE removes its enrichment, and its labels cascade.
  - A full open-task read sweeps up to 5 orphaned enrichments per account per read, in the
    background. One the provider reports as deleted is removed; a completed one keeps its
    metadata.
- **Before migration 037 is applied:**
  - Native reads use `select *`, so a missing `parent_task_id` reads as no parent.
  - Label and enrichment reads return empty.
  - Writes answer `CAPABILITY_UNAVAILABLE` ("needs the latest ELISE database update"). Nothing
    breaks.

### 4. Tools

| Tool | Change |
| --- | --- |
| `tasks.create` | Gains `parentTaskId` and `labels`. |
| `tasks.update` | Gains `addLabels` and `removeLabels`. `list` now also works for Google. |
| `tasks.list` | Gains `priority` and `label` filters. `search` now covers description, labels, list and account. |
| `tasks.labels` (new) | Lists, creates, renames and deletes labels. |

The model guidance adds:

- P1 maps to high.
- Labels and priority on Google are ELISE-only. ELISE says so only when the user asks.
- A time of day is never claimed as saved on a task; ELISE offers a calendar event instead.

### 5. One read path

`tasks-service.tasksOverview` (open tasks, lists, labels, and completed only when asked) still
goes through `tasks.list`. Home, Chat, Canvas, the Morning Brief and Schedules are unchanged.
The Task Surface item gains optional `labels` and `subtask`, and existing Surfaces still
validate.

### 6. UI (`features/tasks/task-workspace.tsx`, `task-detail.tsx`, `views.ts`)

**Layout:** a sidebar of 220–240 px, a dense list, and an optional 400 px detail column on xl.
The page is up to 1560 px wide.

- **Sidebar:**
  - search;
  - "+ Nueva tarea";
  - views: Inbox, Hoy (the default), Próximo, Vencidas, Completadas, Todas;
  - lists grouped by account, collapsible and remembered per device;
  - labels;
  - a hint line with the keyboard shortcuts.
- **Inbox:** ELISE's Inbox plus each provider's default list, with list identities never merged.
- **Grouping:**
  - Hoy: overdue, then today.
  - Próximo: tomorrow, this week, next week, later.
  - Completadas: today, this week, earlier. Lazy-loaded, the most recent 50.
- **Filters:** account, priority, label, this week. They combine.
- **Sort:** my order (Google's `position`, else creation order), due date, priority, newest. The
  sort is presentation only and never written to a provider.
- **Rows:** checkbox, title, due chip, P flag, subtask count, #labels, and the list and account
  when they help. Subtasks nest under a parent that is shown.
- **Quick add:** title, destination, and a date that defaults from the view. "More" adds
  priority and description.
- **Detail:**
  - title, description, completion, date (with a "day only" note), priority, list (same
    account), labels, subtasks (add, open, complete), provenance, created and updated, open in
    Google, delete;
  - previous and next navigation;
  - focus moves in on open and returns on close.
- **Responsive:**
  - Below xl, the detail is a sheet over the list.
  - On mobile it is full screen, and the sidebar becomes a drawer.
- **Keyboard:** N new, / search, ↑↓ or J/K move, Enter open, X complete, Esc close.
- **Writes are optimistic.** A failed write toasts and restores. Success refreshes from the
  provider, so provider truth wins.
- **Freshness** is unchanged (ADR-046): a live read on open and on a stale focus, Realtime for
  native data, and the "Actualizado …" line.

## Not done / pending

- **Migration 037 must be applied** (`npx supabase db push`) before native subtasks, labels and
  ELISE priority on Google can be written. Production was also missing 036 on 2026-10-12.
- **Real-browser validation against your Google accounts** is still to do (the ADR's checklist
  steps 1–10).
- **Drag and drop:** reorder and move-by-drag are not built. Moving between lists is done from
  the detail panel. Manual native order has no `position` column yet: "my order" is creation
  order.
- **Subtask progress** shows the count of open subtasks. Completed children appear only when
  completed tasks are loaded, because Google omits them from open reads.
- **The legacy chat Surface** shows labels and P1 in its meta line. Full detail interactions
  stay in the workspace.

## Consequences

- No Google task is ever copied into ELISE, and Google never stores a fake priority, label or
  time.
- Adding a provider means adding its capability row and an adapter. The UI follows the matrix.
