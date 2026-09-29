# infrastructure/ai

The only place where model SDKs (currently `@openai/agents`) may be imported.

- ELISE's core must never import model SDKs directly. It depends on the `AIProvider` port in `src/core/agents/ai-provider.ts`.
- Each provider (OpenAI today, others later) is an adapter here that implements that port.
- Server-only: API keys (`OPENAI_API_KEY`) must never reach client code.

No agents are implemented yet. See `docs/architecture/12-agent-runtime.md`.
