# ADR-003 — Tasks are day-level and soft-deleted

**Status:** Accepted (2026-09-29)

## Context

`16-data-model.md` suggests `tasks.due_at timestamptz`. Most task requests ("mañana", "el
viernes") are day-level, the first external provider (Google Tasks) only stores dates, and a
timestamp would force an arbitrary time and timezone-dependent "overdue" bugs.

## Decision

- `tasks.due_date` is a `date` in the user's timezone. "Today/overdue/this week" are computed
  deterministically from the profile timezone (`toTaskQuery`), never by the model.
- Timed work belongs to Calendar events, consistent with `10-native-structured-data.md` §12.
- Deleting a task sets `archived_at`; there is no client DELETE policy. `completed_at` must be
  set if and only if `status = 'completed'` (DB constraint).

## Consequences

- If timed reminders on tasks become necessary, add a nullable `due_time` rather than changing
  `due_date` semantics.
