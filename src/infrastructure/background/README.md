# infrastructure/background

Trigger.dev behind ELISE's `BackgroundRuntime` port (`src/core/schedules/runner.ts`). See
[ADR-006](../../../docs/decisions/ADR-006-schedules-background-runtime.md).

- `trigger/runtime.ts` — `TriggerDevBackgroundRuntime` (enqueue with idempotency key, cancel).
- Task entry points live in `src/trigger/` (configured in `trigger.config.ts`). They stay thin:
  validate the payload and call `src/application/background.ts`.
- The Next.js build never needs Trigger.dev credentials.
