# ADR-127: No accidental duplicates; chat never empties the Canvas

**Status:** Accepted (2026-10-28). Adjusts ADR-021 (Live Canvas decay), ADR-036 (the tail) and
ADR-100 (alarms).

## Context

Real use on 2026-10-28:

- **Duplicates.** "Alarma para las 14:30" said twice created two identical alarms.
- **A repeated request.** In continuous conversation, noise in the window after a request cut the
  request; an empty transcript then sent the same request again. That happened five times in
  21 s, leaving five "Muy bien, muy bien." turns and empty replies.
- **An empty Canvas.** Untouched Surfaces decayed after 4 turns. Those five turns emptied the
  Canvas, and Home fell back to the plain transcript with no way back.

## Decision

1. **Ask before an identical write.** If the same thing already exists, `time.setAlarm`,
   `time.start` and `tasks.create` create nothing; ELISE asks first, and `allowDuplicate` creates
   it after the user confirms. The same thing means:
   - an enabled alarm at the same time and day (or the same weekdays);
   - a timer of the same kind, duration and label started less than a minute ago;
   - an open task with the same title (ignoring accents, case and punctuation).
2. **Cutting a request needs real speech.** At least 600 ms of voice, not 250 ms. A request sent
   again because the cut produced no words gets no window, so it can't be cut again.
3. **Decay happens on present, not on turn.** A turn removes only transient confirmations.
   Surfaces untouched for 4 turns make room only when a new Surface is presented. Chit-chat
   ("muy bien", "gracias") never empties the Canvas.
4. **The keyboard closes on a tap outside the composer** when nothing has been typed.

## Consequences

- A deliberate second identical alarm, timer or task costs one confirmation.
- A Canvas can hold old Surfaces longer during a long chat. They still leave as soon as
  something new is shown, and the user can close them.
