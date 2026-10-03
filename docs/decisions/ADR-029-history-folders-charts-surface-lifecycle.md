# ADR-029: History folders, conventional charts, self-maintaining Canvas

**Status:** Accepted (2026-10-02). Extends ADR-020 (History links), ADR-027/028 (planners) and
ADR-013/021 (Live Workspace). No migration.

## Decision

### 1. History as folders (default)

- **Default view.** History opens grouped by Space as folders: Space › Section › conversations,
  plus "Sin Espacio". `group=section` and `group=none` remain choices; the URL omits the default.
- **One folder per conversation.** Each conversation is filed once, under its **primary link**
  (`primaryLink`, `core/history/links.ts`), chosen in this order:
  1. a manual link;
  2. ELISE's most confident automatic link;
  3. the more specific link (a Section over its Space);
  4. the oldest link;
  5. the id.

  Its other links stay as chips.
- **A Space's own conversations** go in its "General" subfolder, but only when the Space has
  Sections.
- **Order.** Spaces and Sections are sorted by their most recent conversation. Conversations
  follow the chosen sort.
- **Folders.**
  - Open/closed state is remembered on the device (localStorage).
  - Closed folders show a count, the number of Sections and the last date.
- **Search** is global and flat. Each result shows where it is filed ("UTN › AMII"). Direct
  `/chat/{id}` links are unchanged.

### 2. Conventional charts

- **Selection matrix** (`viz-planner.ts`, deterministic):

  | Data | Chart |
  |---|---|
  | One value | KPI |
  | Categories | Vertical bars (horizontal when labels are long, there are more than 6, or sources differ — then each bar keeps its source) |
  | Categories with a sourced reference | Dots |
  | True whole, at most 6 parts | Donut |
  | True whole, more than 6 parts | Horizontal bars |
  | Time | Line (multi-line for series; area on request) |
  | Real OHLC | Candlestick |
  | Two variables | Scatter (r computed here) |
  | Frequency of raw values | Histogram (bins computed here) |
  | Start plus changes | Waterfall (end computed; any gap shown as "Unexplained") |
  | Scenarios | Range |
  | Heterogeneous data, or more than 12 categories | Table |

- **Dates in labels.** Labels that are dates ("2025-10-02", "oct 2025", "Q3 2025") count as
  time even without a `time` field.
- **Refusals** come with a reason: a line for categories, a pie for values that aren't a whole,
  and candles without OHLC.
- **New specs:**
  - `donut`, `scatter`, `histogram`, `waterfall` and `candlestick` (OHLC validated);
  - `bar` takes up to 4 grouped or stacked series;
  - `hbar` rows carry a source and an uncertain flag.
- **Renderers** (`classic-charts.tsx`, `charts.tsx`):
  - keyboard datapoints, tooltips and a Table view for every type;
  - the line legend toggles series;
  - line axes are fitted to the data.
- **Finance spending by category** is now a donut.
- **The old catch-all, three parts:**
  1. `defaultChart` sent every set of close category values to the **dot** template (a thin
     line plus one value per row).
  2. `LineChart` forced a **zero baseline**, so price series drew as flat lines.
  3. `HBars` drew thin grey tracks.

  All three are fixed. Dots are now used only against a sourced reference.

### 3. Surface lifecycle (`core/workspace/lifecycle.ts`)

- **Change detection.** A successful write becomes a `ResourceChange`: capability, the
  `target` type and id (now included in the executor's outcome), and whether it updated or
  deleted.
- **Query identity.** A read's Surfaces remember their `query` (tool plus args, persisted). Their
  id comes from the query, so reading the same thing again updates them in place.
- **Decisions** (`decide`):
  - A direct card whose resource was deleted → **dismiss** (Focus exits).
  - A collection whose capability is affected (habits also affect goals; tasks affect planning)
    → **update**: `WorkspaceSession.reconcile` re-runs the Surface's own read and replaces its
    payload in place. Counts and streaks are recomputed by the domain, not patched.
  - A collection that comes back empty → dismissed unless pinned or focused.
  - A failed refresh keeps what was shown.
  - Approvals are never dismissed.
- **When it runs:**
  - in the turn, right after the tool and before the model speaks, so voice, text and Canvas
    agree;
  - after direct Surface actions;
  - from the client when Realtime reports a change to a table behind a visible collection
    (`refreshWorkspaceAction`).

  Only registered reads are replayed (`readRunner`).
- **No duplicates.** When a write refreshed a visible collection, its own display isn't added.
  This was the Habits bug: `habits.checkIn` used to add a second one-habit Surface and leave the
  weekly one stale.
- **Pins and Focus.** Pinned Surfaces update. Focus stays when its resource updates.
- **Topic change and decay** are unchanged: a new primary intent clears the previous intent's
  Surfaces, and untouched Surfaces decay after 4 turns.
- **Optimistic UI.** "Complete" on a task list shows at once and is rolled back to server state
  on refusal.

## Consequences

- One extra read per affected visible collection after a write. It runs before the model's
  reply.
- Surfaces created before this release have no `query`, so they don't auto-refresh. They decay
  as before.
- Real-time market data has no provider. Stock history comes only from sourced web data, so
  candlesticks appear only with real OHLC.
