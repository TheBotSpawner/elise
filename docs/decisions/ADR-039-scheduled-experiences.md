# ADR-039: Scheduled Experiences: runs as narrated, component-based sessions

**Status:** Accepted (2026-10-05). Extends ADR-006 (schedules), ADR-017 §15 (brief now),
ADR-021/027 (visualizations), ADR-030 (ELISE's voice), ADR-037 (presets) and ADR-038 (Weather).

## Context

A Morning Brief rendered as a document: a title, a 120–220 word markdown summary, and raw lists
underneath. The browser's speech engine read the markdown aloud. Nothing on screen followed what
was being said, and the structured data (habits, weather, tasks) was mostly shown as counts in
prose.

## Decision

1. **One output model for every scheduled run**: `ScheduledExperience`
   (`core/schedules/experience.ts`), an ordered list of segments. Each segment has:
   - `say`: one spoken line. The visible message and the voice script are the same text.
   - an optional short `label`;
   - typed `blocks`: `text`, `chart` (any `VisualizationSpec`), `weather`, `agenda`, `tasks`,
     `emails`, `followups`, `habits`, `goals`, `finance`, `news`, `knowledge`, `focus` and
     `issues`.

   Blocks are data and never markup. `spokenScript()` is the voice script.
   `textExperience()` covers a run that only has text. The renderer ignores block kinds it
   doesn't know, so newer runs degrade gracefully.
2. **Morning Brief adapter**: `briefExperience(brief, locale)` builds the experience at render
   time, so stored briefs from before this change render the same way. It is the relevance
   layer:
   - Only parts with something to show appear, in presentation order: focus, agenda, tasks,
     weather, inbox (emails and follow-ups), habits, goals, finance, news, knowledge.
   - The agenda always appears when the calendar was requested; "no meetings" is information.
   - Habits and goals use the Live Canvas chart templates (the week streak, progress bars) when
     the data allows, and lists otherwise.
   - Source problems come last, as a quiet card that is never spoken.

   Every preset (weekly planning, end of day, reviews) uses the same adapter.
3. **Narration instead of a written summary.** The scheduled handler makes one bounded model
   call, `narrateBrief`, which returns JSON `{greeting, lines: {topic: text}, closing}`.
   - The topics given to the model are exactly the parts on screen, and the result is validated
     against them, so the model cannot talk about a card that isn't there.
   - Each line is one or two spoken sentences that point out what matters and never read every
     item.
   - If the model is unavailable or returns something unusable, deterministic lines computed
     from the same data are spoken ("No tenés reuniones hoy.", "Entre 14 y 22 grados, con 70%
     de probabilidad de lluvia."). The brief never depends on the model.
   - Older briefs keep their markdown summary as a collapsed transcript.
4. **Voice that follows the screen** (`use-narration.ts`):
   - "Escuchar" plays the script in ELISE's own voice (`SpeechPlayer`, `/api/voice/speak`), one
     segment at a time.
   - The next line is synthesized while the current one plays, so there is no dead air.
   - The segment being said is highlighted (`aria-current`) and scrolled into view; the others
     dim. Each segment has its own play button.
   - Scrolling by hand stops the auto-follow.
   - If ELISE's voice is unavailable, the browser's speech engine continues from that line.
   - Playback starts on a tap; browsers block autoplay of audio, so it never autoplays.
5. **One renderer**: `ExperienceView` renders any experience. A chat reply ("my brief now")
   shows only the cards, because the conversation does the talking.

## Consequences

- A new kind of scheduled job only has to produce a `ScheduledExperience`, either stored in its
  result or built from its data. It needs no page of its own.
- `scheduled_results.content` is unchanged for briefs (it stays a `MorningBrief`, with new
  optional `narration` and `charts`), so no migration is needed.
- The written prose summary (`synthesizeBrief`) is gone. Briefs from before this change keep
  theirs as a transcript.
