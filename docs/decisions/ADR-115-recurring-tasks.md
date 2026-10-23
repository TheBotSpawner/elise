# ADR-115: Recurring tasks

**Status:** Accepted (2026-10-23). Extends ADR-009 (unified tasks) and ADR-050 (ELISE enrichment
of provider tasks). Migration `20261117000066_task_recurrences.sql`.

## Context

Users ask for "sacar la basura todos los lunes" or "pagar el alquiler el 10 de cada mes". Tasks
live in ELISE Native or Google Tasks, and neither API gives ELISE recurrence: Google Tasks exposes
none. Programados (Schedules) are a different thing: things ELISE runs, not things the user does.

## Decision

1. **A series is ELISE's own layer over any task provider,** like labels and priority.
   - The provider holds exactly one live occurrence, an ordinary task.
   - A `task_recurrences` row holds:
     - the rule: an RFC 5545 RRULE subset without DTSTART;
     - the anchor date (`dtstart`) and the rule date of the live occurrence;
     - how many occurrences exist;
     - the user's IANA timezone;
     - a template: title, description, priority and labels.
   - Nothing is generated in advance.
2. **The rule.** The supported subset is:

   | Part | Values |
   | --- | --- |
   | FREQ | DAILY, WEEKLY, MONTHLY, YEARLY |
   | INTERVAL | 1–365 |
   | BYDAY | days of the week; for monthly, one day with an ordinal (`2TU`, `-1FR`) |
   | BYMONTHDAY | 1–31, or -1 |
   | Ending | COUNT or UNTIL |

   Anything else is refused, never half-read.
   - **Dates only:** tasks have dates, not times (ADR-050), so DST can't move an occurrence. The
     timezone only decides "today".
   - **Day 31** in a shorter month is that month's last day, and 29 February is 28 February in a
     common year. People mean "end of month", so this is a deliberate departure from RFC 5545's
     skip.
3. **Completing advances, idempotently.**
   - Completing the live occurrence computes the rule's next date after the occurrence's rule
     date, skipping dates already in the past. A daily task completed a week late doesn't come
     back seven times.
   - An atomic claim (`update … where current_task_id = <completed>`) means two completions or a
     retry create one next task.
   - If creating it fails, the claim is reverted.
   - COUNT or UNTIL reached ends the series.
   - A live task completed outside ELISE (in Google Tasks) is noticed on the next full read of
     open tasks (at most 3 checks per read) and advances the same way. A deleted one ends its
     series.
4. **Editing.**

   | Scope | Effect |
   | --- | --- |
   | `this` (default) | Changes only this occurrence. Moving its date doesn't move the rule. |
   | `all` | Changes the series: the rule and what next occurrences copy. |
   | `following` | Ends the series here and starts a new one from this occurrence, so earlier history keeps its rule. |
   | `repeat: null` | Stops repeating and keeps the task. |

   Deleting the live occurrence ends the series. Subtasks can't repeat.
5. **Surfaces.**
   - **Task detail "Repetir":**
     - presets: no repeat, daily, weekly on its day, weekdays, monthly on its day, yearly;
     - "Personalizado…": every N days, weeks, months or years, days of the week, the day of the
       month or the Nth weekday, and an end of never, a date or N times;
     - a scope switch: solo esta, esta y las siguientes, toda la serie.

     Rows show a repeat icon with the rule in words.
   - **Chat and voice:** `tasks.create`/`tasks.update` take `repeat`/`repeatScope`, with
     Rioplatense examples. `tasks.complete` returns `nextOccurrence`, so ELISE says when the task
     comes back.
6. **Security.** RLS: members of the workspace only, and the connection must belong to the same
   workspace. Every query is also scoped to the workspace in code.

## Consequences

- One small table and no background job: the next occurrence appears on completion.
- Before the migration is applied, tasks work unchanged. Reads show no series, and asking for
  one says the database needs the update.
- **Rollback:** `drop table public.task_recurrences;`. Existing tasks stay as plain tasks.
