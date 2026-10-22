# Wake word evaluation (ADR-108)

Measures how the shipped wake word model and the shipped decision rules behave on a synthetic
Rioplatense corpus under simulated distance, music and meeting conditions.

1. `pip install vosk numpy` (Python 3.10+).
2. `python desktop/scripts/wake-eval/generate_clips.py`: about 86 short TTS clips with your
   `OPENAI_API_KEY` (a few US cents). They are cached in `.clips/`, which git ignores.
3. `python desktop/scripts/wake-eval/simulate.py`: runs `vosk-model-small-es-0.42` with the
   detector's energy gate and writes the recognizer's events (text and timing only, no audio) to
   `tests/fixtures/wake-eval-traces.json`.
4. `npx vitest run tests/unit/voice/wake-eval.test.ts`: replays the traces through
   `src/core/voice/wake-arbiter.ts` (the rules that ship) and prints the before/after report.

The corpus is a proxy. It has no real microphone, no echo cancellation or AGC, and no music with
vocals. Real voices and rooms still need the manual check in
`docs/engineering/31-desktop-wake-and-audio.md`.
