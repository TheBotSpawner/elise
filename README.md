# ELISE

One persistent intelligence that coordinates your digital world through chat, capabilities and
replaceable providers.

**Status:** pre-MVP — Slice 1 (Foundation) and Slice 2 (Google Calendar + Tasks) implemented. See [What works today](#what-works-today).

## Stack

Next.js 16 (App Router, `src/`) · React 19 · TypeScript strict · Tailwind CSS 4 · Supabase (Auth,
Postgres + RLS, Realtime) · OpenAI (behind ELISE's `AIProvider` port) · Zod · Motion · Vitest +
Testing Library + PGlite · Trigger.dev (not connected yet).

## Requirements

- Node.js 24+ and npm
- A Supabase project (for accounts and data)
- An OpenAI API key (for chat)

## Local setup

```bash
npm install
cp .env.example .env.local          # fill in Supabase + OpenAI values
```

Apply the database migrations to your Supabase project (Supabase CLI, no global install needed):

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push                # applies supabase/migrations/*
```

In the Supabase dashboard:

- **Authentication → URL Configuration:** Site URL `http://localhost:3000`; add
  `http://localhost:3000/auth/callback` to Redirect URLs.
- **Authentication → Providers → Google (optional):** enable it with your Google OAuth client to
  make "Continue with Google" work. Email/password and magic links work without it.

### Google Calendar + Google Tasks (optional)

Connections to Google are separate from signing in to ELISE. To enable them:

1. **Google Cloud Console** → create (or pick) a project.
2. **APIs & Services → Library:** enable **Google Calendar API** and **Google Tasks API**.
3. **Google Auth Platform → Branding / Audience:** app name, support email; User type
   _External_; while in _Testing_, add your Google accounts as **test users**.
4. **Data Access (scopes):** add `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`,
   `https://www.googleapis.com/auth/calendar.events`,
   `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/tasks`.
5. **Clients → Create client → Web application:**
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/api/connections/google/callback`
6. Put the client ID/secret in `.env.local` (`GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`), plus `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_APP_URL` and an
   encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → ELISE_ENCRYPTION_KEY
```

Calendar and Tasks are _sensitive_ scopes: publishing the app for other users requires Google's
verification. Testing mode works for the listed test users.

Then:

```bash
npm run dev                         # http://localhost:3000
```

Without Supabase variables the app still builds and starts; `/login` explains what is missing.
Without `OPENAI_API_KEY`, everything works except chat, which reports that AI is not configured.

## Environment variables

| Variable                                                           | Required | Purpose                                            |
| ------------------------------------------------------------------ | -------- | -------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes      | Auth + data (browser-safe; RLS enforces access)    |
| `OPENAI_API_KEY`                                                   | for chat | Server-only AI provider key                        |
| `OPENAI_MODEL`, `OPENAI_MODEL_FAST`                                | no       | Model names (defaults `gpt-5-mini` / `gpt-5-nano`) |
| `NEXT_PUBLIC_APP_URL`                                              | prod     | Base URL for auth redirects                        |
| `ELISE_ENV`                                                        | no       | `development` / `staging` / `production` log tag   |
| `CHAT_RATE_LIMIT_PER_MINUTE`                                       | no       | Per-user chat rate limit (default 20)              |
| `SUPABASE_SECRET_KEY`                                              | Google   | Server-only: encrypted credential store            |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`             | Google   | OAuth client for Calendar/Tasks connections        |
| `ELISE_ENCRYPTION_KEY` (+ optional `_PREVIOUS`)                    | Google   | AES-256-GCM key for OAuth credentials at rest      |
| `TRIGGER_SECRET_KEY`                                               | not yet  | Reserved for background execution                  |

## Scripts

| Script                 | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | Dev server                                    |
| `npm run build`        | Production build                              |
| `npm run start`        | Serve production build                        |
| `npm run lint`         | ESLint (includes architecture boundary rules) |
| `npm run typecheck`    | Route type generation + `tsc --noEmit`        |
| `npm test`             | Vitest watch mode                             |
| `npm run test:run`     | Vitest single run (unit + RLS integration)    |
| `npm run format`       | Prettier write                                |
| `npm run format:check` | Prettier check                                |

The RLS tests run the real migrations inside PGlite (in-process Postgres), so no Docker or hosted
database is needed.

## What works today

- Sign up / sign in with email + password, magic link, and Google (once enabled in Supabase).
  Each new user gets a profile and a personal workspace automatically.
- Short onboarding (welcome → what to help with → tools).
- Chat-first Home with the animated ELISE Orb reflecting Elise's real state; streaming chat;
  conversation history.
- **Tasks end to end:** "Agregá revisar la propuesta para mañana" → the model proposes
  `tasks.create` → ELISE validates the input, resolves the ELISE Tasks binding, checks
  permission and policy → Supabase persists → the Tasks screen updates in realtime → Elise
  confirms from the actual result. The same path serves the Tasks UI.
- **Google Calendar + Google Tasks** through Connections: several Google accounts, each with an
  alias and context; Calendar and Tasks granted separately (progressive scopes); reconnect and
  disconnect. Elise reads across all calendars/task accounts (with the account shown), writes to
  the default or the account you name ("en mis tareas de Firbot"), and asks when it's ambiguous.
  Inviting people or deleting events waits for your approval.
- Deletions requested through chat wait for approval (inline card or Approvals page); approvals
  resolve once, verify the payload hash, and revalidate before executing.
- Actions, tool executions, AI runs and audit events are recorded; logs are structured and
  redacted.
- Dark / light / system theme; Spanish and English UI; responsive desktop + mobile navigation.

## Structure

- `docs/` — product, architecture and engineering docs (source of truth); ADRs in `docs/decisions/`.
- `src/core/` — ELISE domain: capabilities, providers + resolver, agent runtime, policy, tools. No SDKs.
- `src/application/` — use cases (chat, tasks, approvals) and wiring of Core ports to infrastructure.
- `src/infrastructure/` — Supabase, OpenAI, provider adapters (ELISE Native, Google), encryption, observability.
- `src/features/` — user-facing experiences (chat, tasks, auth, onboarding, settings, approvals).
- `src/components/` — UI primitives, shared layout pieces and ELISE identity (Orb, shell).
- `supabase/migrations/` — schema, RLS policies, provisioning triggers.
- `tests/` — unit tests, RLS integration tests (PGlite) and fixtures.
