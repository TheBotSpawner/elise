@AGENTS.md

# ELISE: rules for Claude Code

1. Before implementing a feature, read the relevant documents in `/docs` (index: `docs/README.md`).
2. `/docs` is the source of truth for product and architecture decisions.
3. Do not invent behavior the docs don't define.
4. If an important decision is undocumented, stop and flag it before introducing irreversible architecture. Record accepted decisions as ADRs in `docs/decisions/`.
5. Keep `src/core` free of direct dependencies on external providers, SDKs, Supabase, Trigger.dev and OpenAI (ESLint enforces this).
6. External providers live behind adapters/interfaces in `src/infrastructure`. The core thinks in capabilities (Email, Calendar, ...), not providers (Gmail, ...).
7. TypeScript strict. No `any` without an explicit, commented justification.
8. Do not add dependencies without a concrete reason.
9. Do not implement features outside the requested scope.
10. Multi-tenant security is a requirement even during the MVP (RLS, tenant scoping, no cross-user data access).
11. Never commit secrets. Server secrets go only in `server-only` modules, never in `NEXT_PUBLIC_*`.
12. Prefer simple, readable solutions over premature abstractions.

Before finishing, run: `npm run format:check && npm run lint && npm run typecheck && npm run test:run && npm run build`.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-tasks`, `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`.
<!-- TRIGGER.DEV SKILLS END -->
