# ADR-037: Logical Knowledge sources, explainable attention, and a general Scheduled hub

**Status:** Accepted (2026-10-04). Refines ADR-022 §4 (counts are sources), ADR-036 (source
states) and ADR-006 (Schedules). No migration: every new field has a default, so existing rows
read unchanged.

## Context

- A Space showed "1 fuente · 37 listos · 224 necesitan atención". The source count was
  already logical (ADR-022), but the status numbers next to it counted **child pages**. Space
  cards, Section cards and the "Recientes" header all did this.
- In the real Firbot Marketing data, the 224 were Notion database rows whose only content is a
  title ("CHOP" in Empresas). They produced no chunks, so each one failed as "no readable text".
- The source row's counts came from the 300 most recent items, so large databases were cut
  short.
- The Notion picker listed every page the integration could see, rows included. One pick of
  several roots became one source ("Pipeline de Proyectos +8").
- Inside a Space with sources, "Add source" existed only in the page header.
- "Needs attention" could not be clicked, so nothing explained it.
- Scheduled offered one action, "New Morning Brief".

## Decision: the logical source

**A logical source is what the user connected.** That is a Notion database, a standalone
Notion page, a Drive folder or file, or one uploaded document or note. The pages and files it
discovers are its **items**. Items are kept for ingestion, retries, provenance and citations,
and appear only in the source's details.

**One source per selected root.** Picking Projects, Companies and Opportunities creates three
sources. Each one's `configuration.selection` holds one root, and its name is the root's name.

- A root already connected to the same Space or Section is skipped, never duplicated. The
  picker shows it as "Ya agregada".
- Another Space or Section may connect the same root.

**Existing multi-root sources stay as they are.** "Pipeline de Proyectos +8" remains one source
with kind "mixed". Splitting them would mean moving items and chunks between sources for a
label. Re-adding the databases one by one is the user's choice.

## Decision: status roll-up

The roll-up is `core/knowledge/source-state.ts`, functions `sourceRollup` and
`documentRollup`. Rules apply in this order:

| Roll-up | When |
| --- | --- |
| failed | The source itself failed and nothing from it is ready, or every item failed |
| needs_attention | It is usable but something needs the user: the source failed after a good sync, or some items couldn't be read (344 ready + 2 failed) |
| processing | Work is in flight: preparing, retrying, syncing, or items still queued or reading. Never "needs attention" just because a sync is running |
| ready | Everything is settled; an empty source counts as ready |

- An uploaded document maps its own status. A ready document that keeps an error code (it kept
  its last good version) needs attention.
- `sourceTotals` counts logical sources: `total`, `ready`, `processing`, and `attention`
  (needs attention + failed).
- Space cards, Section cards and the Sources header show "N fuentes · X procesando · Y
  necesita(n) atención". One database with 224 bad pages is **1 source**.
- `SpaceSummary.counts` (item-level) stays for the model-facing admin tool, as diagnostics.
- "Recientes" stays a list of recent documents, without status totals.
- Counts read every item, paging past PostgREST's 1000-row limit, not just the recent 300.

## Decision: Needs attention, explained

Any visible "needs attention" can be clicked:

- **Space card, Section card:** opens `?attention=1`, a list of the affected sources. Each one
  drills into its source.
- **Source row:** opens the source dialog. It shows:
  - what was connected and its item summary ("344 elementos listos · 2 necesitan atención");
  - the source's own problem, if any, with Reconnect or Retry;
  - **only the items with a problem**, newest first, up to 100 with "Se muestran N de M";
  - "Reintentar los N elementos fallidos";
  - Remove source.

**Reasons** come from `core/knowledge/attention.ts`:

- `attentionReason(code, detail)` maps error codes and ELISE's own messages to a plain-language
  reason: reconnect, access lost, no text, scanned without OCR, OCR found nothing, too large,
  unsupported, mismatch, corrupt, stalled, timeout, unreachable, unknown.
- `attentionActions` offers only actions that help. Retrying an unsupported file changes
  nothing, so it isn't offered.
- The code, message and ids are under "Detalles técnicos", closed by default.

**Title-only database rows are documents.** A titled Notion page with no body or properties
indexes its title (`notionDocument`). Untitled empty rows still need attention. Existing items
recover with "Reintentar elementos fallidos"; nothing is re-embedded just for counts.

## Decision: Notion picker

- **Databases** (the default tab) search `POST /search` with
  `filter: {property: "object", value: "data_source"}` (API 2026-03-11 filters only `page` or
  `data_source`). Each data source folds into its `parent.database_id`, so a database with
  several data sources is one choice. Sync already queries every data source of a database.
- **Pages** search `value: "page"` and drop database rows (parent `data_source_id` or
  `database_id`). Rows are never listed.
- Up to three result pages of 100 are read.
- The picker says that Notion only shows ELISE what was shared with it, and links to Reconnect
  Notion, instead of looking empty.

## Decision: Add source where sources are listed

- The Sources header gets an inline "Sumar fuente" next to the existing header button.
- Both open the same dialog, which states its destination ("Se suma a UTN › AMII"). In a
  Section, that is the Section, never its parent Space.

## Decision: Scheduled is general

**One canonical model.** A scheduled task is the existing schedule (`action_type
morning_brief`, its runner, runs, history, results and chat tools). It is "a briefing ELISE
prepares at set times":

- **What should ELISE do?** — `instructions`, now the second field of the form;
- **What ELISE looks at** — `blocks`;
- **When** — `definition`, with a readable preview ("Se ejecuta: Dom · 19:00 · hora de …");
- **How to notify** — `delivery`.

**Three optional configuration fields, all defaulted:**

| Field | Values | Default |
| --- | --- | --- |
| `horizon` | today, tomorrow, week (the calendar's days, and how far back Knowledge changes go) | today |
| `knowledgeSpaceId` | a Space id; required when the new `knowledge` block is chosen | null |
| `preset` | the preset it came from | null |

The `knowledge` block reads `knowledge.listRecentChanges` for that Space through the normal
tool path.

**Presets are prefills, not capabilities** (`core/schedules/presets.ts`):

| Preset | Looks at | Default time |
| --- | --- | --- |
| Morning Brief | today's calendar, email, follow-ups, tasks, habits, goals | weekdays 07:30 |
| Weekly planning | calendar for the next 7 days, tasks, goals | Sun 19:00 |
| End-of-day review | today's calendar, tasks, habits, email | weekdays 18:30 |
| Tomorrow's calendar | tomorrow's calendar | Sun–Thu 20:00 |
| Task review | tasks | weekdays 09:00 |
| Email follow-up review | follow-ups, email | weekdays 16:00 |
| Knowledge digest | one Space's changes over the week; asks which Space | Fri 17:00 |
| Habit check-in | habits, goals | daily 20:30 |

- A preset opens the ordinary form, prefilled. Nothing is created until Create.
- **Project / Space update** is not separate: with today's tools it would be the Knowledge
  digest again.

**No accidental duplicates.**

- An idea already in use says "Ya agregada" and opens that schedule.
- Schedules from before presets count as the Morning Brief when they read today's calendar
  without a Knowledge block (`presetOf`).
- "Mi brief" (`briefNow`) reads that Morning Brief, not a weekly plan.

**Naming:**

- A result and its notification use the schedule's own name ("Planificación semanal"). They
  used to say "Morning Brief" for everything.
- The briefing prompt is generic: the user's instructions say what it is for.

**Page layout:**

1. "Nueva tarea programada" (primary);
2. "Tus tareas programadas", with the existing controls: Run now, Pause/Resume, Edit, History,
   Delete;
3. "Ideas para ELISE" as a compact grid (one column on mobile).

**Chat:** `schedules.propose` accepts `horizon` and `knowledgeSpaceId`, so tasks proposed in
chat use the same model. `schedules.list` and the notification tools already read every
schedule.

## Consequences

- A Space reads in sources a user recognizes. Item numbers live in the source's details.
- "Needs attention" always leads to a reason and, when something can help, an action.
- Scheduled can grow by presets without new tables, services or handlers. A truly new kind of
  scheduled work (running the agent loop with tools) would still be a new `action_type`.

## Not built

- **Splitting existing multi-root sources** (see above).
- **Natural-language recurrence in the form** ("todos los lunes a las 8"). Chat already does
  this through `schedules.propose`; the form keeps its day/time picker.
- **Per-item reasons stored as codes.** Reasons are derived from ELISE's own messages. A new
  message needs a pattern in `attention.ts`, or it shows as "unknown" with its technical
  details.
