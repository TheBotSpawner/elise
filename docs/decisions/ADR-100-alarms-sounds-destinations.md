# ADR-100: Alarms, sounds and where they ring

**Status:** Accepted (2026-10-19). Extends ADR-045 (native time), ADR-081 (Desktop) and ADR-029
(Live Workspace reconcile).

## Context

ELISE had timers, Pomodoros and stopwatches (ADR-045). It had no alarms. An alarm rings at a clock
time on a device, possibly days from now, possibly every week.

A wrong alarm costs a missed class or flight. Two rules follow from that:

- ELISE must never say an alarm will ring somewhere it can't deliver.
- The model is never the source of timing or authorization truth.

## Decision

1. **Stored as local time plus timezone.** Each alarm keeps:
   - `local_time`;
   - either a single `local_date` or a set of `weekdays`, never both;
   - the user's `timezone` and a computed `next_fire_at`.

   Daylight saving time works as follows (`localInstant` in `src/core/timers/alarms.ts`):
   - a time skipped by the clock change rings at the first minute that exists;
   - a repeated hour rings at the earlier instant.
2. **The server fires.** Each alarm, at each `version`, gets one delayed Trigger.dev run (`time-alarm`).
   - The run's idempotency key is `alarm:<id>:v<version>`.
   - The run inserts an `alarm_occurrences` row, unique on `(alarm_id, fire_at)`. Duplicate or
     late runs therefore collapse.
   - Any edit bumps `version`. A run that finds an older version does nothing.
   - Reading the list also settles due alarms, so a lost run still fires on the next read.
   - A fire later than 15 minutes is recorded as `missed` instead of ringing late, so there is no
     catch-up storm.
   - An occurrence stops ringing after 10 minutes (failsafe).
   - Snooze schedules `alarm-snooze:<occ>:<rings>`.
3. **Destinations are explicit.** Today an alarm can ring on two kinds of device:
   - **A browser the user chose.** It is opt-in. It rings only with ELISE open, the computer
     awake, and after one touch, because of autoplay rules.
   - **An ELISE Desktop installation.** The main process keeps the next 48 hours on disk
     (`alarms.json`). It rings minimized, in the tray, offline and after a restart. If no window
     exists, a hidden one is created.

   A device counts as online when it was seen in the last 3 minutes.

   Tools and UI say where an alarm rings, which device is offline now, and when it has nowhere to
   ring. ELISE Mobile and ELISE Home with a speaker are future destinations: architecture only, and
   never offered.
4. **Receipts, not assumptions.** Each device reports one of: received, playing, blocked (no
   audible start) or stopped. Snooze or stop on one device stops the ring on all of them through
   Realtime. A local failsafe stops the ring after 10 minutes regardless.
5. **Sounds.**
   - **ELISE's own sounds.** ELISE, Brisa (the default), Amanecer, Campana and Pulso are synthesized
     with WebAudio from notes, so there is nothing to license.
   - **Uploads.** Uploaded sounds go to the private bucket `alarm-sounds` through the server only:
     - the file type is checked by its magic bytes;
     - each file is at most 2 MB, with at most 10 per user;
     - they play through 300-second signed URLs.
   - **Deleting an upload.** The alarms that used it go back to the default sound. If it was the
     default, Brisa becomes the default again.
6. **Tools resolve deterministically.**
   - The tools are `time.setAlarm`, `time.listAlarms`, `time.changeAlarm`, `time.deleteAlarm`,
     `time.alarmAction`, `time.alarmSounds` and `time.alarmDestinations`.
   - Day words, destinations and sounds are resolved in code.
   - `forModel` reports `ringsOn`, `offlineNow` and `noDestination`, and the guidance says to
     repeat only that.
   - Results show as the `alarms` surface, which is updated in place.
7. **Security.**
   - All four tables are owner-only under RLS, and the owner of an alarm can't be changed.
   - `alarm_occurrences` is inserted only by the dispatcher (admin client).
   - Desktop IPC `alarmSchedule` is validated with zod: at most 50 items, uuids and datetimes.

## Consequences

- An alarm on a sleeping or closed computer doesn't ring. It is recorded as missed, and the UI says
  so up front.
- No OS-level guarantee: ELISE never claims to bypass silent mode or Do Not Disturb.
- Rollout needs migration 058, which creates the bucket, and a deploy of the Trigger task
  `time-alarm`. No new environment variables.
