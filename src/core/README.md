# core

ELISE's own concepts: capabilities, providers (as abstractions), agents, skills, rules, routines, knowledge, memory, entities.

Rules:

- No imports from Supabase, Trigger.dev, OpenAI, external APIs or provider SDKs (enforced by ESLint).
- No imports from `@/infrastructure`, `@/features`, `@/components` or `next/*`.
- Think in capabilities (Email, Calendar, Knowledge, Tasks, Voice, Finance), never in providers (Gmail, Notion, OpenAI).
- Core defines interfaces (ports); `src/infrastructure` implements them.
