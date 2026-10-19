# ADR-096: Voice from any page (the floating Orb)

**Status:** Accepted (2026-10-19). Builds on ADR-014 and ADR-017 (one voice session, the same
chat turn). Supersedes one part of ADR-095 §4: a wake on another page no longer navigates to
Inicio.

## Context

The person is on another page, for example Finanzas or Tareas, and wants to ask ELISE something
without going to Inicio. Their request: "solo voz, sin moverme". Nothing should interrupt the
page, and the conversation should still be logged on Inicio.

Before this ADR, the voice session lived only on Inicio (`ChatSurface`). On Desktop, a wake word
heard on another page navigated the window to Inicio, which changed what the person was
looking at.

## Decision

1. **A small Orb in the bottom-right corner**, on every page except the ones that have a
   conversation of their own: Inicio, `/chat/…` and onboarding. It works on the web and on
   Desktop (`QuickVoice`, `src/features/voice/quick-voice.tsx`).
2. **Voice only.** The Orb shows the session's state: listening, thinking, speaking. Nothing else
   appears; there is no panel, transcript or toast, and the URL stays the same.
3. **Same pipeline, nothing new on the server.** The Orb uses the legacy voice session
   (`useVoice`) on top of the same chat stream (`useEliseChat`, `headless`). A headless chat does
   not rewrite the URL.
   - Turns are stored like any spoken turn (`interaction_turns`).
   - The conversation becomes the tab's active interaction (ADR-032), so Inicio opens it next.
4. **A tap starts listening; tapping again ends it.** A tap after a finished conversation starts
   a new one.
5. **Desktop's wake word hands over to whichever session is mounted**: Inicio's, or the Orb's on
   other pages. The page stays where it is.
6. **Other floating actions** (Finance's "+") stand to the Orb's left through
   `--quick-voice-space`.

## Consequences

- Something that needs the screen (an approval card, a Surface) isn't shown there. Approvals
  still wait in Aprobaciones, and Inicio shows the full conversation.
- Desktop needs a cloud deploy that sends `profile.voice` in `/__bootstrap`. On an older deploy,
  the Orb doesn't show.
- GPT-Live isn't used by the Orb; it runs on the legacy runtime, like Desktop's background voice.
