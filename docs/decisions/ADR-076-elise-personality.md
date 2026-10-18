# ADR-076: ELISE's base personality

**Status:** Accepted (2026-10-18). Extends ADR-012 (self-control settings) and ADR-030 (voice).
No migration: the preference lives in `user_preferences` under the key `elise.personality`.

## Decision

- **Five presets.** The setting is a typed enum, `ElisePersonality` (`core/personality.ts`):
  - `efficient` · **Servicial y eficiente**: the default;
  - `motivating` · **Positiva y motivadora**;
  - `demanding` · **Exigente y directa**;
  - `friendly` · **Cercana y amistosa**;
  - `provocative` · **Ácida y provocadora**: never humiliating, and no sarcasm on sensitive
    topics.
- **Tone only.** Personality changes wording, warmth, directness and humor. It never changes:
  - permissions, approvals or tool access;
  - risk classification or data access;
  - facts or calculations.

  The executor and the policy never read it, so the same request takes the same path in every
  personality.
- **Separate from the voice.** Any voice works with any personality, and changing one never
  changes the other.
- **One preference.** It is stored per person and workspace, under RLS. All of these write it:
  - Settings › Personalidad;
  - the onboarding step "¿Cómo querés que sea ELISE?" (preselected default);
  - chat and voice, through `settings.setPersonality`.

  A missing or unknown value resolves to `efficient`. The change is audited as
  `settings.personality_changed`.
- **Changing it from a conversation** is a typed settings change, never prompt editing:
  - "ponete exigente" saves `demanding`;
  - "volvé a lo normal" saves `efficient`;
  - "cambiá tu personalidad" with no target shows the five choices (the `personality` surface)
    and saves nothing until one is picked;
  - a one-off "hoy hablame más tranquila" only adapts that conversation.

  The new tone applies from the next reply, and Settings shows the same value.
- **One short instructions block, applied centrally.** `personalitySection()` adds a few lines,
  never a persona prompt, to:
  - the chat and voice context, in the cached prefix right after the identity;
  - the GPT-Live voice prompt;
  - the Morning Brief narration.

  So tool confirmations, summaries and workspace explanations share the same tone.
