# infrastructure

Concrete adapters to external services. The only place allowed to import external SDKs (enforced by ESLint).

| Core concept         | Infrastructure implementation (initial) |
| -------------------- | --------------------------------------- |
| Email capability     | Gmail provider (future)                 |
| AI boundary          | `ai/` → OpenAI (future)                 |
| Routine service      | `background/` → Trigger.dev (future)    |
| Persistence and auth | `supabase/`, `auth/`                    |

Server-only modules must start with `import "server-only";`.
