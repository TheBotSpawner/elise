# ADR-008 — My Elise Native: Habits, Goals, Lists, Notes

**Status:** Accepted (2026-09-29)

## Context

ELISE Native already provides Tasks. Habits, Goals, Lists and Notes complete the native
structured-data layer (docs/architecture/10, 16 §45-56) and must work the same from the UI and
from Chat, through the existing capability → resolver → provider → repository path.

## Decisions

1. **Capabilities, not modules.** `habits`, `goals`, `lists`, `notes` are capabilities whose
   provider is ELISE Native. Every workspace gets grants and default bindings for them
   (provisioning trigger + backfill). Tools are canonical (`habits.checkIn`, `lists.addItem`…).
2. **Explicit tables.** `habits`, `habit_entries`, `goals`, `goal_links`, `lists`, `list_items`,
   `notes`; no EAV. Every row has `workspace_id`, RLS, `created_at/updated_at`, `source`
   (`user_ui` | `ai` | `schedule` | `import` | `system`); significant records are archived, not
   deleted. Same-workspace triggers guard entries, items, parent goals, note Spaces and goal links.
3. **Habit model.** `frequency_type` daily | weekly | specific_days with `target_value` and an
   optional `unit` (quantitative habits). One `habit_entry` per habit per local day (unique):
   check-ins add to (`add`) or correct (`set`) that day; `skipped` never counts. Progress, weeks
   (ISO, Mon–Sun, in the user's timezone), "at risk" and streaks are computed in
   `core/capabilities/habits.ts`; streak rules are documented there.
4. **Goal model.** `progress_type` binary | numeric | percentage, `progress_mode` manual |
   linked | hybrid, `direction` increase | decrease (race times). Linked progress = mean of
   completed-task share and each linked habit's weekly share; hybrid = mean of manual and
   linked. Unmeasurable goals return `null` with a stated basis — never an invented percentage.
   `goal_links` point to existing habits/tasks/goals/notes (entities later); nothing is copied.
5. **Notes ↔ Knowledge.** The note row is the only editable copy. A note filed in a Knowledge
   Space gets a Knowledge item (`source_type` note, `external_id` = note id) in that Space's
   "ELISE Notes" source; every change creates a version that is re-indexed (unchanged text is
   deduplicated by hash). Moving a note re-creates the item; archiving or removing the Space
   deletes the indexed item. Ingestion always reads the note's current text.
6. **Approvals.** Everyday native writes are automatic; archiving a habit/goal/list/note asks
   when ELISE proposes it (UI actions are the user's confirmation).
7. **UI through the same path.** My Elise screens read from the repositories and write only
   through the native tools (`runUserTool`), so policy, audit and provenance match Chat.
8. **Import.** CSV for Habits, Goals and Lists: deterministic header mapping (EN/ES synonyms),
   per-row validation preview, user confirmation, then creation of valid rows with source
   `import`; invalid rows are reported. Synchronous (≤ 500 rows).
9. **Morning Brief.** New `habits` and `goals` blocks (default on for new briefs): habits at risk
   or still open today, and up to three active goals with open linked tasks.

## Consequences

- Entity linking waits for the Entities milestone (no entity tables exist yet); `goal_links`
  already accepts `entity`.
- Import doesn't read XLSX directly (export as CSV) and does not use AI to guess mappings.
