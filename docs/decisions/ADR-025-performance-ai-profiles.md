# ADR-025: Measured performance, AI profiles and adaptive routing

**Status:** Accepted (2026-10-02). Refines ADR-001 (agent loop), ADR-019 (model policy) and
ADR-014 (voice). No migration: timings live in `ai_runs.token_usage.perf`. Measurements are in
`docs/performance/README.md`.

## Context

Real usage felt slow, and the first measurements confirmed it: a simple "¿Qué tengo hoy?" took
~20 s and meeting prep took ~35 s. Measured causes, largest first:

1. **Reasoning at the default (medium) effort on `gpt-5-mini`** for every turn. That was 3–18 s
   per model call, including ~2,000 reasoning tokens to phrase a list of tasks.
2. **All 148 tools on every call,** about 27k input tokens per call.
3. **About 12 sequential database round trips before the first byte,** plus a Recall prefetch of
   up to 2.5 s that blocked the stream and was then repeated by the model's own `history.search`.
4. **Model calls that only said "done",** and meeting prep making 3–4 calls (an extra call to
   present a Surface).
5. **Independent read tools in one model turn ran one after another.**
6. **Per-turn data (the time to the minute, visible Surfaces) at the start of the instructions,**
   which broke prompt caching.

## Decision

1. **Measure every turn.** `TurnPerf` records setup spans, first byte, event, text and Surface,
   and every model call (profile, effort, service tier, tokens, cached tokens, tools exposed) and
   tool. It holds numbers and names only, never content, and is stored with the run and logged as
   `turn.perf`. `/admin/perf` (admins only) shows the timelines and p50/p90 per intent.
2. **AI profiles, configured centrally.** `fast | standard | deep | background`, each set as
   `AI_PROFILE_* = model[:effort[:serviceTier]]`.
   - Defaults (benchmarked): Luna low for fast, standard and background; Luna medium for deep.
   - Effort is mapped to what each model accepts (`effortFor`).
   - Business logic asks for a profile, never a model.
3. **Adaptive routing (`ELISE_AI_ROUTING=adaptive`).** Turns run on fast. Explicitly open-ended
   asks (investigate, compare, explain, catch me up, longer than 400 characters) start on deep.
   The call after `meeting.prepare`, `web.research`, `work.brief` or `knowledge.compare` escalates
   to deep. This uses deterministic signals only, with no classifier call.
4. **Tool selection (`ELISE_TOOL_SELECTION=selected`).**
   - Each turn sees a fixed core (calendar, tasks, Knowledge, Recall, workspace, settings,
     meeting, planning, briefs).
   - Groups are added from the message's words, the visible Surfaces, recent turns' tools and the
     active context.
   - Everything else is one `tools.more` call away. That call is the runtime's own step, so
     nothing becomes unreachable.
   - The core comes first in a fixed order, as a stable cache prefix.
5. **Fewer round trips.**
   - Read-only calls in one model turn run in parallel, and each result is shown as it lands.
     Writes keep the model's order.
   - A response that already holds the answer and only arranges the screen (`ui.*`) ends the turn.
   - A tool whose result confirms itself (`confirm`, e.g. appearance) answers without another
     model call. This applies only after it succeeded; approvals are untouched.
6. **Setup in dependency phases.** Independent reads share one round trip. Nothing is written
   before the rate limit passes, and history is read before this turn's message is saved. The
   blocking Recall prefetch is off under adaptive routing.
7. **Prompt-cache layout.** Stable instructions come first. History follows, then this turn's
   context as a developer message just before the user's words. Each profile sends a
   `prompt_cache_key`.
8. **Voice.** When tools are needed, ELISE starts the response with one short spoken line of what
   it's checking. It never guesses the result. In the spoken part, the preamble is followed by
   the tool's confirmation.
9. **Quality guards kept by the fast profile.**
   - Defaults fill details, never content: tasks reject placeholder titles ("Tarea", "New task"),
     and ELISE asks.
   - When Maps isn't set up, travel times are never estimated from memory or web pages.
10. **Client bundle.** The browser no longer imports the zod-based Surface schemas: `isOpen`,
    video embeds, approval ops and brief capabilities moved to schema-free modules. Home stays
    free of the 382 KB zod chunk. The Maps JS API already loads only when a Map Surface renders.
11. **Fast mode (priority processing) stays off.** It doubled cost with no measurable gain on
    Luna (experiment D). It can be enabled per profile with `:fast`.

## Benchmark suite

| Class | Requests |
| ----- | -------- |
| Fast | "¿Qué tengo hoy?", "Cambiá tu color a verde.", "¿Cuánto tardo de A a B en auto?", "Mostrame mis tareas.", "¿Qué dijimos sobre X?", "Creá una tarea para mañana." |
| Medium | Day plus priorities, a Section question, a short meeting prep |
| Complex | Full meeting prep, web research, a study explanation from notes, a work brief |
| Regression | Knowledge vs Calendar, Recall by voice, "Borrá eso.", multi-account email |
| Voice | Three of the above, spoken |

## Consequences

- Typed turns are ~2× faster at p50 (first text 17.1 → 9.3 s; simple requests 11.0 → 5.7 s) at
  about one third of the cost. Routing quality is kept, with the placeholder guard added.
- p90 is still dominated by provider stalls and by the 2–3 model calls of tool turns.
- The previous configuration is a few env vars away, for comparison.
- Realtime voice migration, later, can reuse the same pieces: the runtime (`runElise` behind the
  `AIProvider` port), tools, policies, approvals, the split context (stable instructions plus a
  per-turn developer message) and Surface ops. Blockers:
  1. Realtime sessions keep their own conversation. The per-turn context must be injected as
     conversation items, and tools changed with `session.update` (`tools.more` maps onto that).
  2. Function calls must reach ELISE's executor. That needs a server relay (Vercel functions
     don't hold WebSockets), or a WebRTC client that forwards calls to an ELISE endpoint.
  3. The per-event handling in `chat-service` (persistence, Surfaces, perf, approvals) must move
     out of the HTTP stream into a transport-independent turn session.
  4. Transcripts must keep landing in `interaction_turns` for History and Recall.
- **What Realtime would remove:** endpointing hangover, the STT upload, the TTS hop and one HTTP
  round trip, about 2.5–3.5 s of today's ~6.4 s speech-to-audio p50. Recommendation: migrate
  voice once blocker 3 (the turn-session refactor) is done. That refactor is worth doing anyway.
