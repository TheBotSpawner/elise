# infrastructure/background

Durable runtime adapter for routines, background jobs, knowledge sync, document processing, retries, long jobs and approval-waiting workflows. The initial choice is Trigger.dev (`@trigger.dev/sdk`, `@trigger.dev/build`).

Rules:

- Trigger.dev tasks are thin wrappers. Routine business logic lives in `src/core/routines`, not only inside a task.
- The Next.js build must not depend on Trigger.dev credentials.

## Pending manual setup

Not initialized, because `init` requires login and a real project ref. When the Trigger.dev project exists:

```bash
npx trigger.dev@latest login
npx trigger.dev@latest init --project-ref <proj_ref> --skip-package-install
```

When prompted for the trigger directory, use `src/infrastructure/background/trigger`. Then set `TRIGGER_SECRET_KEY` in `.env.local` and in Vercel.
