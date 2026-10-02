# ELISE performance: measurements and AI profiles

Measured 2026-10-02 (ADR-025). Every number below comes from real ELISE turns against the real
account: Google Calendar, Tasks and Gmail, Drive Knowledge, and Recall including voice. Nothing
comes from synthetic prompts.

## How it was measured

- **Server timing.** `TurnPerf` (`src/core/perf.ts`) records every turn in
  `ai_runs.token_usage.perf` and logs it as `turn.perf`:
  - the setup steps;
  - the first byte, first event, first text and first Surface;
  - every model call: profile, effort, service tier, start → first event → end, input, cached and
    output tokens, tools exposed, calls requested;
  - every tool: start → end, and whether it succeeded;
  - totals.

  It records numbers and names only, never content. The admin-only view is `/admin/perf`.
- **Client timing.** A browser harness sends the requests through `/api/chat` as the real user and
  times the first byte, first event, first text (spoken text for voice), first Surface and the
  complete stream. It then joins the server record by run id.
- **UI timing.** Real Chrome on Home: the time from submit to the stop button appearing (the
  acknowledgement), to the first Surface in the DOM, and to the first streamed text.
- **Voice pipeline.** Real Spanish audio goes to `/api/voice/transcribe`, then a voice turn runs,
  then the first completed spoken sentence goes to `/api/voice/speak`, timed to the first audio
  byte. End-of-speech detection adds its configured 1.1 s silence (`core/voice/turn.ts`).
- **Server under test.** `next build` + `next start` on a development machine in Buenos Aires.

  > **Network note.** From this machine a Supabase round trip is **~200 ms** (p50; 176–262) and an
  > OpenAI round trip ~1.2 s. On Vercel `iad1` next to Supabase US-East, a round trip is a few
  > milliseconds. Setup (first byte) is therefore heavily inflated here. Model and tool times are
  > representative.

- **Suite.** 20 requests: 6 fast, 3 medium and 4 complex, plus 4 regressions (Knowledge vs
  Calendar, voice Recall, a dangerous clarification, multi-account email) and 3 voice turns.
  Each turn was scored on tool selection (expected and forbidden tools), and the answers were
  read.

## Results: before and after

The rows are the baseline (`gpt-5-mini` at its default effort, every tool on every call) and the
final configuration E (adaptive routing, selected tools, `gpt-6-luna` low/medium). Both ran
2 reps × 20 requests. Times are p50 / p90 in seconds.

| Class         | First text before | First text after | Total before | Total after | Input tokens/turn | $ / 1k turns  |
| ------------- | ----------------- | ---------------- | ------------ | ----------- | ----------------- | ------------- |
| Fast          | 11.0 / 20.0       | **5.7 / 10.6**   | 12.1 / 23.6  | **7.1 / 11.7** | 46k → 25k      | 4.04 → 0.86   |
| Medium        | 18.4 / 37.4       | **9.9 / 16.8**   | 22.1 / 38.9  | **11.6 / 18.5** | 76k → 32k     | 6.41 → 1.80   |
| Complex       | 29.6 / 40.1       | **23.0 / 45.4**  | 34.3 / 51.4  | **24.4 / 50.4** | 64k → 58k     | 7.86 → 3.35   |
| Regression    | 15.0 / 25.1       | **6.1 / 9.3**    | 18.9 / 28.0  | **7.9 / 12.6** | 49k → 28k      | 6.10 → 1.67   |
| Voice (text)  | 11.0 / 22.0       | **10.0 / 16.7**  | 16.0 / 25.5  | **11.0 / 18.2** | 62k → 37k     | 4.40 → 1.96   |
| **All**       | 17.1 / 31.0       | **9.3 / 23.0**   | 20.0 / 38.9  | **10.6 / 24.4** | 57k → 35k     | 5.63 → 1.82   |

- First byte (server): p50 3.2 s → 2.3 s. On this network that's about 5 sequential round trips
  of ~200 ms, versus about 12 before.
- First Surface: p50 8.3 s → 6.1 s.

### Per flow (p50)

| Flow                                    | First text      | Total           | Model calls | Input tokens |
| --------------------------------------- | --------------- | --------------- | ----------- | ------------ |
| A "¿Qué tengo hoy?"                     | 16.5 → 6.9 s    | 19.7 → 8.3 s    | 2 → 2       | 55k → 24k    |
| B "Cambiá tu color a verde."            | 8.1 → 5.1 s     | 9.1 → 5.7 s     | 2 → **1**   | 54k → 12k    |
| C Recall "buscame la conversación…"     | 17.3 → 8.3 s    | 20.0 → 9.2 s    | 2 → 2       | 55k → 29k    |
| D Knowledge (Section document)          | 18.3 → 8.1 s    | 21.2 → 9.5 s    | 2 → 2       | 59k → 31k    |
| E Meeting prep (brief)                  | 25.4 → 15.4 s   | 27.0 → 16.7 s   | 3 → 3       | 86k → 40k    |
| E Meeting prep (full context)           | 33.1 → 23.0 s   | 34.3 → 24.4 s   | 3 → 3       | 86k → 52k    |
| F Web research                          | 31.0 → 19.8 s   | 45.6 → 24.2 s   | 2 → 2       | 56k → 30k    |
| Study explanation (Knowledge)           | 20.4 → 13.5 s   | 28.3 → 17.9 s   | 2 → 3       | 59k → 47k    |
| Work brief (UTN)¹                       | 13.4 → 26.4 s   | 15.0 → 29.0 s   | 2 → 4       | 54k → 78k    |

¹ The work brief now reads the actual emails, calendar and tasks (4 calls) instead of answering
from the brief tool alone. It is slower and much richer (exact dates, deliverables). If that depth
isn't wanted for a quick ask, this is the place to tune.

### Quality

| Run                    | Tool-routing score | Notes |
| ---------------------- | ------------------ | ----- |
| Baseline               | 39/40              | The spoken "¿Qué dijimos sobre…?" answered **without searching Recall**. |
| A (code only, gpt-5-mini) | 20/20           | The Recall miss is fixed by tool selection (Recall is in every turn's core). |
| B / C / D (Luna)       | 15–16/20           | Luna at low effort created a placeholder task "Tarea" for "Creá una tarea para mañana." Fixed by a guidance rule plus a schema guard: placeholder titles are rejected and ELISE asks. |
| E (final)              | 34/40 → 38/40 after review | The remaining "misses" are acceptable: `briefs.today` for "¿Qué tengo hoy?" (it reads the calendar), and `ui.listSurfaces` for "Borrá eso." (a read of the screen, then it asks). |
| F (final + guard)      | 18/20              | "Creá una tarea para mañana." now asks "¿Qué tarea querés que cree?". |
| H (Luna, all tools)    | 17/20              | It skipped tools for meeting prep and Recall, and used web search for a travel time. More tools made routing worse. |

All regression cases stayed correct in E/F:

- Knowledge vs Calendar ("cronograma de análisis matemático 2" → `knowledge.search`, no Calendar).
- Voice Recall finds the past voice conversation.
- "Borrá eso." asks first; nothing is deleted.
- Multi-account email ("cuenta UTN") reads the UTN account.
- The Knowledge Section is resolved before tools run.
- Meeting prep and study answers cite their sources.

### Model and profile experiments

All runs are 1 rep × 20 requests unless noted.

| Run | Configuration                                          | First text p50 | Total p50 | $ / 1k | Quality |
| --- | ------------------------------------------------------ | -------------- | --------- | ------ | ------- |
| baseline | gpt-5-mini (default effort), all 148 tools, legacy | 17.1 s         | 20.0 s    | 5.63   | 39/40   |
| A   | Code changes only (gpt-5-mini)                         | 15.9 s         | 18.4 s    | 5.36   | 20/20   |
| B   | Luna low (fast) / Luna medium (deep)                   | 8.2 s          | 9.3 s     | 1.70   | 16/20*  |
| C   | Luna none (fast) / **Sol low** (deep)                  | 9.6 s          | 10.9 s    | 14.93  | 15/20*  |
| D   | B + **Fast mode** (priority processing)                | 8.9 s          | 10.5 s    | 3.68   | 15/20*  |
| E   | B + prompt-cache layout (2 reps)                       | 9.3 s          | 10.6 s    | 1.82   | see above |
| G   | Deep at **low** (medium + complex only, 2 reps)        | complex 18.8 s | complex 20.4 s | 2.54 | equal routing; answers a bit thinner |
| H   | Luna profiles but **all tools** on every call          | 8.5 s          | 10.0 s    | 2.42   | 17/20   |

\* Before the placeholder-title guard. The other flagged cases are the acceptable ones above.

What the experiments show:

- **Reasoning effort was the main bottleneck.** `gpt-5-mini` at its default (medium) effort spent
  up to ~1,900 reasoning tokens writing a short list of tasks; a second call took 10–18 s. Luna at
  low effort answers the same calls in ~1.1–1.5 s to first token.
- **Sol for deep work** cost ~15× more for complex turns (C: $51.72 / 1k) with no clear latency or
  routing gain on these requests.
- **No reasoning at all (Luna "none")** degraded routing: it used web search to estimate a travel
  time.
- **Fast mode** on Luna gave no measurable gain at this sample size, at 2× the price. Keep it off.
  Revisit for voice if OpenAI capacity varies.
- **Deep at low effort** saved no clear latency on synthesis, and its answers were thinner. Keep
  medium for deep work.
- **Tool selection beats all tools.** It is cheaper (35k vs 50k tokens per turn) and routes better
  (H lost three cases).

### Prompt caching

- **Before.** Instructions contained the time to the minute and the visible Surfaces, and all 148
  tools were sent. 88% of input tokens were cached, but each turn sent ~57k tokens, so about 7k
  were uncached.
- **After.** Stable instructions come first. History follows, then this turn's context as a
  developer message right before the user's words. A stable `prompt_cache_key` is used per
  profile, and tool selection is on.
  - Within a turn, later model calls hit the cache (≥ 99% of their prefix).
  - Across turns, a hit needs an identical tool list. Turns that see only the core tools hit
    (11.7k of 11.7k cached).
  - Turns that add a group (email, contexts, location), or that change profile, start uncached:
    0 cached tokens, not a partial hit.
  - Net result: ~59–62% cached of ~35k per turn, about 14k uncached. Uncached tokens grew, but
    total and billed tokens fell, and Luna's uncached price is low ($0.10 / 1M).
- **Lever for later.** Fixed tool bundles per intent would make cross-turn prefixes repeat more
  often.

### Voice (current pipeline, before Realtime)

| Step (p50 / p90)                    | Legacy sample² | Final, before preamble | Final (with spoken preamble) |
| ----------------------------------- | -------------- | ---------------------- | ---------------------------- |
| Speech end → turn ends (silence)    | 1.1 s          | 1.1 s                  | 1.1 s (fixed setting)        |
| Transcript (upload + STT)           | 0.7 s          | 0.86 / 1.55 s          | 1.03 / 1.42 s                |
| Transcript → first spoken sentence  | 11.6–12.8 s    | 5.2 / 11.7 s           | **3.1 / 9.6 s**              |
| Sentence → first audio byte (TTS)   | 0.9–1.2 s      | 0.89 / 1.36 s          | 1.0 / 1.7 s                  |
| **Speech end → first audio**        | **14–16 s**    | 8.1 / 14.8 s           | **6.4 / 12.9 s**             |

² Two legacy samples. The run stopped early (a harness error), but the baseline's voice class
matches it.

TTS was already pipelined sentence by sentence (`voice-controller` chunks the spoken stream). The
remaining voice time breaks down as:

- the 1.1 s endpointing silence;
- ~1 s transcription;
- setup, ~2 s here and ~0.3 s expected in production;
- the first model call, ~1.2 s to first token;
- ~1 s TTS first byte.

Estimated in production (not measured): **≈ 4.5–5 s** from speech end to first audio for a
simple tool request.

### Real browser (Home dock)

| Request (single sample)            | Ack (stop button) | First Surface: legacy → final | First text: legacy → final |
| ---------------------------------- | ----------------- | ----------------------------- | -------------------------- |
| ¿Qué tengo hoy?                    | 13 → 16 ms        | 8.7 → 6.3 s                   | 17.4 → 29.2 s³             |
| Mostrame mis tareas.               | 8 → 9 ms          | 5.6 → 5.2 s                   | 19.2 → 6.2 s               |
| ¿Qué dijimos sobre revisar correos? | 8 → 9 ms         | 9.9 → 6.1 s                   | 15.3 → 9.4 s               |
| Preparame brevemente…              | 8 → 8 ms          | 8.3 → 4.4 s                   | 32.3 → 16.1 s              |

³ A provider stall: the second model call waited 23 s for its first token on an 81-token answer.
p90 tails in every run come largely from this kind of OpenAI latency outlier, not from ELISE.

## Recommended production profiles

These are the defaults when unset (`src/infrastructure/ai/profiles.ts`):

| Profile    | Model        | Effort | Service tier | Used for |
| ---------- | ------------ | ------ | ------------ | -------- |
| fast       | gpt-6-luna   | low    | default      | Every turn's first call: lookups, settings, tasks, routes, Recall, Knowledge, Surface commands, Shortcuts, voice |
| standard   | gpt-6-luna   | low    | default      | Legacy routing (`ELISE_AI_ROUTING=legacy`) and study helpers |
| deep       | gpt-6-luna   | medium | default      | Open-ended asks (investigate, compare, explain, catch me up) and the synthesis call after `meeting.prepare`, `web.research`, `work.brief`, `knowledge.compare` |
| background | gpt-6-luna   | low    | default      | Recall summaries, mapping |

Estimated cost of the representative suite: ≈ $1.8 per 1,000 interactions, against $5.6 before.

To reproduce the old setup without code changes:

```
ELISE_AI_ROUTING=legacy ELISE_TOOL_SELECTION=all AI_PROFILE_STANDARD=gpt-5-mini
```

## Remaining bottlenecks (measured)

1. **Model round trips.**
   - A tool turn needs ≥ 2 calls, at ~1.1–1.5 s to first token each with Luna.
   - Meeting prep: tool time is ~5 s, then deep synthesis at ~4–8 s to first token.
2. **Slow tools.**
   - `meeting.prepare`: 5–6.6 s.
   - `web.research`: ~10 s.
   - `history.search`: 1.7–2.5 s (embedding plus catch-up).
   - `knowledge.search`: ~2 s.
   - `briefs.today`: ~2.5–3.3 s.
3. **Provider tail latency.** Single calls sometimes stall 10–20 s.
4. **Uncached first calls** when the tool set or profile changes (see Prompt caching).
5. **Voice endpointing** (1.1 s) and the STT/TTS hops. These are what Realtime would remove.

## Running the benchmark again

The harness scripts are dev-only and not shipped. To compare runs:

1. Run `next build && next start` with the configuration under test.
2. Send the suite's requests as a logged-in user.
3. Read `/admin/perf` (needs `ELISE_ADMIN_EMAILS`), or query
   `ai_runs.token_usage->'perf'` for p50/p90.

The suite's requests are listed in ADR-025.
