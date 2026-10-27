# ADR-123: Quick reads — plain questions about Mi ELISE answered without the model

**Status:** Accepted (2026-10-27). Extends ADR-025 (performance) and ADR-017 §12 (preset calls).

## Context

"¿Tengo alguna alarma hoy?" took 21 s:
- three model calls of about 7 s each (34k-token prompt, 87 tools), one of them only loading
  more tools;
- the read itself took 0.3 s.

The answer was also wrong. The 13:00 alarm had already rung, so it had no next ring, and the
"today" filter dropped it. The widget then said "no alarms yet" although there were four.

Questions about the user's own ELISE data (Mi ELISE) should be the fastest thing ELISE does.

## Decision

1. **Quick reads.** A short question about alarms or timers, with no request for a change, is
   recognized before the model (`core/agents/quick-reads.ts`).
   - Its read runs as a preset call, through the same executor, validation, policy and audit as
     any other call.
   - The spoken answer is written from the result, and no model is called.
   - Anything else goes to the model as before: a change, a detail (sound, where it rings), a
     long or conditional request, or a failed read. The model then gets the read's result, so it
     doesn't repeat the read.
2. **"Today" includes what already rang.** `time.listAlarms` for a day also counts alarms that
   rang earlier that day, marked `alreadyRang`.
3. **The alarms widget always shows every alarm**, as the Tiempos page does. The output for the
   model holds the day's answer.

## Consequences

- These questions answer in about the time of the read, with no model wait.
- The patterns are a deliberate allowlist. Widening it (tasks for today, lists) means adding a
  pattern, a read and an answer, with tests.
- An answer written without the model follows fixed phrasing.
