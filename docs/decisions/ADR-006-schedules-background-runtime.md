# ADR-006 — Schedules, background runtime and Morning Brief

**Status:** Accepted (2026-09-29)

## Context

ELISE must work while the user is away (docs/architecture/13, 14). Trigger.dev is the chosen
durable runtime, but it is infrastructure: product state, timing semantics and business logic
must stay in ELISE.

## Decisions

1. **ELISE owns time.** A Schedule stores a structured definition (`once` at a local date-time,
   or `weekly` days + local time) and an IANA timezone. `nextOccurrence` converts each local date
   on its own, so 07:30 stays 07:30 across DST. `next_run_at` is stored in UTC for querying only.
2. **One dispatcher, no per-schedule runtime schedules.** A Trigger.dev cron task
   (`schedules-dispatch`, every minute) calls `dispatchDue`: it claims each due occurrence with a
   compare-and-set on `next_run_at`, inserts a `schedule_runs` row (unique per
   `(schedule_id, scheduled_for)`) and enqueues `schedule-run` with idempotency key
   `schedule-run:{runId}`. Pause is a status; resume and edit recompute `next_run_at`. Nothing
   has to be kept in sync inside Trigger.dev.
3. **Run Now is the same path.** It inserts a manual run and enqueues the same task.
4. **BackgroundRuntime port** (`enqueue`, `cancel`) lives in Core; `TriggerDevBackgroundRuntime`
   implements it. Payloads carry `workspaceId` + `scheduleRunId` only, never tokens. Trigger.dev
   entry points live in `src/trigger/` and only call application services.
5. **Execution revalidates everything.** `executeRun` reloads run + schedule scoped to the
   workspace, checks the schedule is not archived (or paused, for scheduled runs) and that the
   owner is still an active member. Data is read through the normal executor
   (`origin: "schedule"`), so bindings, permissions and policies are resolved at run time.
   Background work uses the service role with explicit workspace scoping, acting as the owner.
6. **Overlap, missed runs, staleness.** At most one active run per schedule (partial unique
   index); an overlapping occurrence is recorded as `skipped`. A Morning Brief more than 3 h late
   is recorded as `missed`. After an outage only the next future occurrence is scheduled. Runs
   still active after 45 min are expired as `TIMEOUT` so they never block the schedule.
7. **Retries.** Transient errors (retryable codes) are rethrown so Trigger.dev retries them
   (3 attempts, exponential backoff); permanent ones fail the run immediately. Results
   (`scheduled_results.schedule_run_id` unique) and notifications (unique per run + type) are
   idempotent, so retries never duplicate them.
8. **Approval waits are event-driven.** A handler that meets `approval_required` leaves the run
   `waiting_for_approval` with its `approval_id`; deciding the approval completes the run. No
   process waits inside the runtime.
9. **Morning Brief** = deterministic gathering (today's calendar, unread email of the last 24 h,
   follow-ups, open tasks) in parallel through the existing tools → deterministic filtering and
   ranking (`assembleBrief`) → one bounded synthesis call. Failed sources become warnings
   (`completed_with_warning`); only a brief where no source could be read fails.
10. **Schedules from chat.** `schedules.propose` is an ELISE-internal, read-only capability
    (`schedules`, no provider binding). It returns a structured proposal card; the Schedule is
    created only when the user presses Create.

## Consequences

- The dispatcher costs one short Trigger.dev run per minute per environment; dispatch precision
  is about one minute.
- Trigger.dev needs the server environment variables (Supabase, encryption key, Google, OpenAI)
  in its dashboard to execute runs.
- Without `TRIGGER_SECRET_KEY`, Schedules can be created and edited but not executed.
