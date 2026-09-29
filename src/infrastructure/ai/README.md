# infrastructure/ai

The only place where model SDKs (currently `openai`) may be imported. ESLint enforces this.

- ELISE Core depends on the `AIProvider` port in `src/core/agents/ai-provider.ts`. A provider
  performs one streamed model turn; ELISE Core owns the tool loop, validation, policy,
  approvals and persistence (see `docs/decisions/ADR-001-elise-owned-agent-loop.md`).
- `openai/provider.ts` implements the port with the Responses API (`store: false`).
- `index.ts` picks the configured provider. Model names come from `OPENAI_MODEL` /
  `OPENAI_MODEL_FAST`, never from feature code.
- Server-only: `OPENAI_API_KEY` must never reach client code or model context.
