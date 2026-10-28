# ADR-124: The Study widget — every question, its mark, and entering Study mode

**Status:** Accepted (2026-10-28). Extends ADR-016 (Study) and ADR-122 (question banks).

## Context

Study mode showed only the question being asked. The questions already asked, and how each
went, were nowhere on screen. The user wants:

- to page back through the questions;
- to see which were answered right or wrong;
- to correct that with a tap.

Being evaluated also didn't reliably enter Study mode. "Tirame una pregunta de EPI de
legislación" searched Knowledge, loaded an unrelated Method ("Planificación diaria en bloques")
and made up a question.

## Decision

1. **A question log per session** (`study_sessions.log`, migration 069): every question asked,
   in order, with its mark — `correct`, `wrong` or `unanswered` — and its source (document and
   page, never the answer). At most 50 entries.
   - Asking a question logs it as unanswered.
   - The evaluator's verdict sets the mark. Only a strong answer counts as correct; a partial one
     counts as wrong until the user changes it.
   - Read and written apart from the rest of the session, so a database without the column
     still studies, just without history.
2. **The Study widget** replaces the question Surface. It shows:
   - "Modo estudio · Pregunta N de M", the question and its source with "Ver en documento" (the
     document viewer, at the page);
   - one status chip per question asked, between ← → arrows.

   Tapping another chip shows that question. Tapping the chip of the question on screen cycles
   its mark (dot → tick → cross → dot) through `study.mark`. A mark corrected this way changes
   the log only, not the concept's progress.
3. **Entering Study mode is announced once.** `study.start` asks the reply to begin with
   "Modo Estudio."; later questions don't.
4. **Being evaluated is Study mode.** The rule covers "tirame / preguntame / evaluame / tomame /
   practiquemos / quiz / trivia":
   - `study.start` with the subject as context;
   - never questions written by the model, a Knowledge search or a Method to make them up;
   - general knowledge only when the subject has no material, and saying so.
5. **The Method index lists only related Methods.** With few Methods, every one was listed as
   applying to every turn, so the model loaded unrelated ones. Now only Methods with some lexical
   relation to the message are listed; the rest stay findable with `methods.search`.

## Consequences

- One mark per question, with three states. "Partial" has no state of its own: it shows as
  wrong, correctable by the user.
- A mark corrected in the widget doesn't change spaced repetition. Changing that later means
  updating the attempt and the concept, not the log.
