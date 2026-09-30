# ADR-009 — Unified Tasks and native Task Lists

**Status:** Accepted (2026-09-30)

## Context

Tasks come from several providers at once: ELISE Native and one or more Google Tasks accounts.
Home showed overdue counts while the Tasks screen could look empty, because the two screens
read tasks differently. The Tasks screen asked for "all" tasks capped at 50, so completed tasks
crowded out open ones. Home asked for "open" tasks with its own cap. The Google adapter also
read only the first 10 lists and one page of each. Native Tasks had no organization at all.

An audit confirmed that Google Tasks are never copied into native storage. Each task is read
live from its own account and keeps its provenance.

## Decisions

1. **Each source stays the source of truth.** The Tasks capability aggregates ELISE Native and
   every enabled Google Tasks connection at read time. There is no import, no copy and no
   cross-account mixing. A Google task keeps its provider, connection, list, external id and
   URL. Connecting another account makes its tasks visible immediately.
2. **One definition, one read path.** `isOpenTask`, `inTaskView` and `taskCounts` in
   `core/capabilities/tasks.ts` define open, today, overdue and completed. Home counters, the
   Tasks screen, Chat (`tasks.list`) and the Morning Brief all use them, through
   `application/tasks-service.ts` and the same tool. Open tasks load up to 500 across
   accounts. Completed tasks load only in the Completed view (most recent 50).
3. **Task Lists are the primary organization.** Every workspace has a default native `Inbox`.
   Existing tasks were moved into it by migration, without deleting or duplicating anything.
   A native task belongs to one list. Google lists keep their Google identity. List ids are
   scoped by provider and connection (native UUIDs, Google connection refs) and are never
   assumed to be globally unique. Categories and tags stay secondary.
4. **Destinations.** A new task goes to the default account and list unless one is named. A list
   reference routes the write to its own account. A list name ("Clients") is resolved within
   the account the resolver chose. When several lists match, or none does, ELISE asks.
5. **Google adapter.** It reads every list (paginated) and pages through each list's tasks.
   Moving a Google task between lists is not supported yet and is reported as such.

## Consequences

- Home "N overdue" links to Tasks → Overdue, and both show the same logical set, unless a
  provider is unreachable. Unreachable accounts are named on screen.
- Reads call each provider live. Caching per connection can come later behind the same
  provider interface, keeping one cache per connection and no shared user-visible copies.
