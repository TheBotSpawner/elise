# ADR-099: Finding the email a day is about, and Slack's unread messages

**Status:** Accepted (2026-10-19). Extends ADR-005 and ADR-058 (email search), ADR-062 (Slack)
and ADR-098 (email dates).

## Context

- **The email miss.** On Monday 19 Oct the user asked whether there was a mail for "today's
  Análisis de Sistemas class". ELISE said there wasn't. There was one, received Saturday 17:
  "…K2131: Actividades para el Lunes 19/10".
  - Provider search is literal: every word must be there.
  - Its dates are delivery dates.
  - The model searched mail received today, with request words ("clase") in the text.
- **The Slack answer.** "¿Tengo mensajes sin leer en Slack?" got "I can't see read state". The
  integration only searched and read conversations. Yet read state is reachable with the scopes
  ELISE already has: each conversation's `last_read` (`conversations.info`) and what came after
  it (`conversations.history`).

## Decision

1. **`aboutDay` on `email.search`.** It is the day a message should be about, not when it arrived.
   - ELISE searches mail received in the 14 days up to that day.
   - Each result says `mentionsAboutDay`, deterministic over its subject and snippet ("19/10",
     "lunes 19", "19 de octubre", "Oct 19"…), and those come first.
   - ADR-098's rule holds: a notice about another day never confirms this one.
2. **A search that finds nothing is retried, and says so** (`searchLadder`, in order, stopping
   at the first hit):
   1. Drop request words (clase, correo, hoy…).
   2. Two more weeks back.
   3. Search the sender's words anywhere, not only in From.

   The output names each relaxation (`searchRelaxed`). Guidance: an account's name ("en UTN") is
   the destination, never `from`. Request words stay out of `text`.
3. **`teamMessaging.unread`.**
   - It scans, in every connected workspace (merged), the conversations the user is in: direct
     messages first, at most 30 per workspace, 5 at a time.
   - For each: `last_read`, then the messages from others after it (one page of 15; "15+" if
     more).
   - Slack's own `unread_count_display: 0` skips the history read.
   - It reports how many conversations it checked of how many, is read-only, and never marks
     anything as read.
   - No new scopes are needed.

## Consequences

- An empty search costs up to four provider calls instead of one; a search with results costs
  one.
- `mentionsAboutDay` reads subject and snippet only. A date mentioned only deep in the body is
  missed until the message is read.
- Unread is bounded. A workspace where the user is in more than 30 conversations has the rest
  unchecked, and ELISE says so. Rate limits are handled by the existing client (Retry-After).
