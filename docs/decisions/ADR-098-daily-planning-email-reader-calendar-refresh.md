# ADR-098: Daily planning as a timeline, ELISE's email reader, and the calendar after a write

**Status:** Accepted (2026-10-19). Extends ADR-017 §14 (daily planning), ADR-029 (Surface
lifecycle), ADR-033 (calendar Surface), ADR-034 (spoken acknowledgements) and ADR-048
(presentation discipline). It changes ADR-034 in one point: every request is acknowledged.

## Context

A real conversation (Monday 19 Oct 2026) showed six problems:

1. The user asked for a plan for "mañana" (Tuesday). ELISE narrated a block-by-block schedule
   by voice, but no schedule appeared on screen until the user asked to see it.
2. Nothing modelled a day's plan. `planning.today` only gathers today's sources, and
   `ui.timeline` places dates, not time blocks.
3. An email about Monday ("Actividades para el Lunes 19/10") was treated as if it confirmed
   Tuesday's class.
4. The chat showed "Email · 0 correos" next to the thread that matched. A search with no hits
   rendered its own card alongside the thread found another way.
5. Broad Knowledge matches crowded out the email the user had asked about.
6. Calendars shown by an orchestration (`present()` in `planning.today`) had no `query`, so a
   later write never refreshed them (ADR-029 only re-runs Surfaces that keep their read).

A tapped email opened Gmail. The thread Surface showed only a 3-line excerpt.

## Decision

1. **A day's plan is a Surface, `day_plan`, and a tool, `planning.proposeDay`.**
   - The plan carries:
     - its date and timezone;
     - blocks (start/end "HH:mm", label, category, notes);
     - an `origin` for each block (`user` for times the user gave, `suggested` for ELISE's
       estimates, `calendar` for existing events);
     - a `state` for each block (`proposed` or `saved` with its `eventId`);
     - conflicts, free stretches, warnings and a version.
   - `core/planning/day-plan.ts` checks it deterministically, never the model.
     - Rejected: invalid times, and a block that ends before it starts.
     - Kept but flagged: overlaps with each other or with the calendar, and times the clock
       skips that day (DST). Durations are real instants.
     - That day's timed events join the plan as they are. A proposed block that matches one
       (same times, related title) is that booking, `saved`. Nothing is invented or
       duplicated.
   - The day is resolved by ELISE: `day` (today, tomorrow, day after tomorrow) or a `date`.
   - The tool is a read (`proposeDay: READ`). It never writes.
2. **One plan per day.**
   - The Surface id and dataset are `day_plan:<date>`, so every change ("mové el gimnasio a las
     21") updates the same Surface with the next version.
   - The plan keeps its read (`query`). Calendar writes already reconcile `planning.*`
     Surfaces (ADR-029 `AFFECTS`), so after a save the plan re-reads the calendar and shows
     the saved blocks as `saved`. Reconciling keeps the version.
3. **Saving is the conversation's, under the existing approval rules.**
   - "Guardar en el calendario" is a prompt action. The model creates each still-proposed block
     once, with `calendar.createEvent` and the plan's exact times.
   - Orchestrations can't write (nested reads only), and this ADR doesn't change that.
4. **Shown without asking.**
   - The guidance tells the model that the timeline is the answer, and that voice says the
     plan's shape in one or two sentences.
   - Fallback: if a turn's reply lays out three or more time ranges and no plan or timeline was
     presented, the reply's blocks become a `day_plan` (`planFromReply`). The day comes from the
     user's words, where the latest correction wins ("mañana… no, hoy lunes" → today) and "por
     la mañana" is a morning. Then the reply's words, then today.
5. **Email dates and evidence.**
   - The guidance separates the received date, the day a message is about, and the day the user
     asks about. A notice about one day never confirms another.
   - A search with no hits is hidden when the same turn found the mail another way. When it is
     shown, it says "sin resultados en esta búsqueda".
   - On an explicit email request (`explicitEmail`: email words, no document or Knowledge words),
     `knowledge.search` results stay off the Canvas and email results replace them
     (`beforePresenting`).
   - The tool list itself is unchanged, to keep the prompt-cache prefix.
6. **ELISE's email reader.** Tapping an email in a list (Canvas or chat), or a thread Surface,
   shows the conversation inside ELISE.
   - The full plain text is fetched on demand: `GET /api/email/thread` →
     `email.getThread { reader: true }`, run as the user with the same routing and account
     checks. Only then does the display keep bodies (max 100k chars). A turn's display never
     carries them.
   - Bodies are rendered as text: no markup, no remote images, only https: links (opened with
     no referrer).
   - "Abrir en Gmail/Outlook" stays. A tapped email is also focused, so "¿qué dice?" refers to it.
7. **Every request is acknowledged at once.**
   - ADR-034 acknowledged only predicted lookups or a started tool. Now every voice request of
     two or more words gets a neutral line from the `instant` bank ("Un segundo.", "Okay.",
     "Ahí va.") the moment it ends, unless it predicts a lookup, which keeps its specific line.
   - Social words ("gracias", "hola") get none.
   - A reply that's faster drops it (`stillSayable`).
   - Desktop warms the acknowledgements' audio when its session mounts, because a wake-word turn
     goes out already transcribed.

## Consequences

- The plan is only as good as its blocks. Recurring events show as their instances on that day;
  all-day events aren't blocks.
- Saving creates events one by one. A repeat is prevented by the plan's saved state and the
  executor's idempotency. A partial failure leaves the unsaved blocks `proposed`, visible.
- Provider propagation delay: the refresh is the provider's own read right after the write. No
  polling loop.
- The reader shows plain text only. HTML formatting is lost by design.
- GPT-Live (web) speaks its own reply, so the `instant` bank applies to the classic pipeline
  (Desktop, and the web when Live is off).
