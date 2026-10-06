# ADR-045: Native Time — timers that belong to the user, not to a chat

**Status:** Accepted (2026-10-05).

## Context

Users ask ELISE for timers ("poneme 25 minutos"), Pomodoros, stopwatches and the time. A
timer must survive leaving the conversation, navigating, reloading, a closed tab and a
sleeping laptop. A countdown kept in a React component, or decremented in the database
every second, survives none of those.

## Decision

1. **A canonical internal capability, `time`**, with five tools:
   - `time.start`: timer, pomodoro or stopwatch.
   - `time.list`: what's left, computed exactly.
   - `time.control`: pause, resume, cancel, reset, lap or skip.
   - `time.addTime`: plus or minus.
   - `time.now`: the time here or anywhere, optionally shown as a clock.

   They are always offered, because "¿cuánto falta?" and "pausalo" name no keyword. Every
   change is a low-risk write: automatic, recorded and audited.
2. **Owned by the user, not the conversation.** The `timers` table is RLS owner-only.
   Conversation, session, Schedule and Space ids are kept as provenance only (no foreign
   keys), so deleting a conversation never touches a timer.
3. **Timestamps, never a countdown.**
   - A running timer stores `ends_at`, and what's left is `ends_at − now`.
   - A paused one stores `remaining_ms`.
   - A stopwatch stores `elapsed_ms` plus the start of its current running stretch.
   - Nothing is written per second. Realtime carries only state changes, and the page
     corrects its clock by the server's time.
4. **Versioned changes.** Every write is conditional on the version it was computed from
   and bumps it. Concurrent tabs can't overwrite each other.
5. **Durable completion.**
   - Every change that leaves a timer running enqueues a delayed Trigger.dev run
     (`time-complete`) at `ends_at`, with idempotency key `timer:<id>:v<version>`.
   - The run re-reads the timer and completes it only if it is still at that version
     (`endRunDecision`). An older run is stale after a pause, added time, a cancel or a
     restart.
   - Every read also settles overdue timers, which covers a missed run, a local setup without
     the worker, and a sleeping laptop. Completion is recorded at the real end time.
   - Exactly one writer wins, and it inserts one `time.completed` notification (unique per
     timer version).
6. **Pomodoro.**
   - Default phases are 25/5, a 15-minute long break and 4 cycles. They are configurable
     and finite.
   - By default breaks start on their own, and the next focus block waits for the user.
     This can be changed to "all" or "none".
   - A laptop that slept through several phases lands in the correct phase.
7. **Surfaces.**
   - Each timer has one `timer` Surface, keyed by its id. Every change updates it in place.
   - While running or paused, it stays on the Canvas as the conversation moves on. A
     cancelled timer's Surface is transient.
   - The size is compact, standard, or focus (large digits). There is also a `clock` Surface.
8. **Global presence.**
   - A mini timer (bottom-left) and a full-screen Focus view are mounted on every page,
     reading one client store that follows the server.
   - My Elise → Time lists the timers and holds the preferences: sound (ELISE, soft or none),
     browser notifications, and Pomodoro durations, cycles and auto-start.

## Browser reality

- **Sound** plays only in an open ELISE tab. It is a short synthesized chime, unlocked by
  the user's first tap or key press. Only completions fresher than 2 minutes ring.
- **Browser notifications** appear when ELISE is open but not in view, if the user granted
  permission.
- **With every ELISE tab closed**, the timer still completes on time on the server, and the
  in-app notification waits for the user. Web Push for closed browsers (a service worker,
  VAPID keys, subscriptions) is deferred. ELISE never claims OS-alarm behavior.
- A **Desktop Companion** can later subscribe to the same `time.completed` events for native
  alarms.

## Consequences

- Each running stretch costs one delayed run. Stale runs exit early, which is cheap and keeps
  the design simple; cancelling them is unnecessary for correctness.
- Several open tabs may each chime once.
- Spoken completion while voice mode is active is not wired yet. The toast and notification
  carry the line.
- Time tracking does not feed Habits or Goals. That needs an explicit, user-configured link
  first.
