# ADR-072: Copy for anyone, and completion that feels finished

**Status:** Accepted (2026-10-16).

## Context

- **Shipped copy assumed internal context.** Examples referred to the team's own world:
  - the Vision placeholder was "Firbot Solutions es una agencia boutique…";
  - the area and Book placeholders named Firbot;
  - the speech-recognition lexicon included RSFA and UTN.
- **Model-facing text did the same.** Tool descriptions and prompts used "Firbot", "RSFA" and
  "UTN › AMII", which invited the model to reuse them.
- **Much copy explained what the UI already shows.** Long subtitles and placeholders written as
  instructions.
- **Completing things gave no feedback.** Checking a habit day, a task or a goal gave nothing
  beyond the state change.

## Decision: copy

- **Shipped copy is generic.** Examples anyone understands: "Construir un negocio sostenible",
  "Leer 12 libros este año", "Supermercado", "Trabajo › Cliente A". Internal names were removed
  from:
  - dictionaries, prompts and tool descriptions;
  - the lexicon;
  - code comments.
- **User data is untouched.** A Space called "Firbot Marketing" is shown as is. Only what ships
  changed.
- **Shorter copy.** Page and modal subtitles are a short phrase. Placeholders are at most 8
  words, as content examples, never instructions. Empty states are a headline and one line.
  - The onboarding asks "¿Qué querés organizar con ELISE?".
  - The roadmap promise ("en la futura app móvil…") was removed.
  - Privacy and permission explanations stay, in their info affordances.
- **Prompt guardrail.** `CORE_INSTRUCTIONS`: invented examples and suggestions are short and
  neutral, never a company, client or project name unless it comes from the user's data.
- **Enforced by `tests/unit/product-copy.test.ts`:**
  - no internal name anywhere in `src`;
  - placeholders are at most 8 words in es and en;
  - es and en have the same placeholder keys.

## Decision: completion feedback

- **One primitive:** `features/feedback/completion.ts`, with
  `completionFeedback({ kind, key, element })` where kind is `habit`, `task` or `goal`. It does
  three things:
  - **Pop.** A Web Animations scale (0.94 → 1.04 → 1) with a thin accent glow on the element
    that was tapped: 260 ms, or 420 ms for a goal. No layout change, no confetti. It is skipped
    under `prefers-reduced-motion`.
  - **Tone.** Synthesized with Web Audio, like the startup sound: two soft sines a fifth apart
    (A5 → E6), about 220 ms. A goal adds A6 and lasts 380 ms. It uses one reused
    `AudioContext` created inside the tap, so it doesn't fight autoplay rules. There is no file
    and no network request.
  - **Haptic.** `navigator.vibrate(8)` only on coarse pointers, and `[10, 60, 10]` for a goal.
- **Decoration only.** Each part fails silently, and the domain action never waits on it.
  "Sonidos de interacción" (Configuración › Voz › Sonidos, on by default, per device) turns
  the tone off.
- **Played only for an explicit not-done → done by the user, called from the interaction:**
  - **Habits:** `write` uses `completesDay(habit, before, value)` from core. Undo, a lower
    value, or a day already met plays nothing. Measured habits only play when the target is
    reached.
  - **Tasks:** the task workspace row and detail, and the Canvas task row. The completed row
    stays in its view for 450 ms (checked) so the pop is seen. The write is never delayed. Every
    provider (ELISE, Google) goes through the same canonical action.
  - **Goals:** `useNative.act("goals.complete")` primes audio inside the tap and plays when the
    server confirms. The progress ring already animates to 100%; the pop lands on it.
- **No replays.** Refetches, realtime updates, Chat or voice changes and reloads render the
  completed state without calling the primitive. The same key within 1.5 s plays once, which
  covers double taps and two handlers.

## Validation

- **Real browser** (`e2e/completion-validation.spec.ts`), counting oscillators, `animate` calls
  and vibrations:
  - **Desktop:** habit 2 tones and 1 pop; undo silent; reload silent; task 2 and 1; goal 3 and 1.
  - **Phone** (touch, reduced motion): no pops, the tone sounds, vibration 1 for each.
  - The Vision modal reads "Una dirección a largo plazo." with the placeholder
    "Construir un negocio sostenible".
- **Unit tests:**
  - `completion-feedback.test.tsx`: the once window, sounds off, reduced motion, refused audio,
    haptics, `completesDay`;
  - `completion-wiring.test.tsx`: goal success, failure and progress updates; Canvas tasks;
    already-completed items.
