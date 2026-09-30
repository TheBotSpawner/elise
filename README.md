# ELISE

One persistent intelligence that coordinates your digital world through chat, capabilities and
replaceable providers.

**Status:** pre-MVP — Slice 1 (Foundation), Slice 2 (Google Calendar + Tasks), Gmail + Email Copilot, Schedules + Morning Brief (Trigger.dev), Knowledge (uploads, Google Drive, Notion), My Elise Native (Habits, Goals, Lists, Notes, Tasks with lists) and Finance (native, imports, Google Sheets) implemented. See [What works today](#what-works-today).

## Stack

Next.js 16 (App Router, `src/`) · React 19 · TypeScript strict · Tailwind CSS 4 · Supabase (Auth,
Postgres + RLS, Realtime) · OpenAI (behind ELISE's `AIProvider` port) · Zod · Motion · Vitest +
Testing Library + PGlite · Trigger.dev (background execution).

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

### Google Calendar, Google Tasks and Gmail (optional)

Connections to Google are separate from signing in to ELISE. To enable them:

1. **Google Cloud Console** → create (or pick) a project.
2. **APIs & Services → Library:** enable **Google Calendar API**, **Google Tasks API**,
   **Gmail API**, **Google Drive API** and **Google Sheets API**.
3. **Google Auth Platform → Branding / Audience:** app name, support email; User type
   _External_; while in _Testing_, add your Google accounts as **test users**.
4. **Data Access (scopes):** add `openid`, `…/auth/userinfo.email`, `…/auth/userinfo.profile`,
   `https://www.googleapis.com/auth/calendar.events`,
   `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/tasks`,
   `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/drive.readonly`,
   `https://www.googleapis.com/auth/spreadsheets.readonly`.
5. **Clients → Create client → Web application:**
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:3000/api/connections/google/callback`
6. Put the client ID/secret in `.env.local` (`GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`), plus `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_APP_URL` and an
   encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → ELISE_ENCRYPTION_KEY
```

Calendar and Tasks are _sensitive_ scopes and `gmail.modify` is a _restricted_ scope: publishing
the app for other users requires Google's verification (and a security assessment for Gmail).
Testing mode works for the listed test users.

Gmail is enabled per account and incrementally: on `/connections`, press **Enable** on the
Gmail row of an already connected Google account. Calendar and Tasks keep working; no reconnect
is needed. See [ADR-005](docs/decisions/ADR-005-gmail-email-capability.md).

### Knowledge (uploads, Google Drive, Notion)

Knowledge is stored in Supabase (Postgres + pgvector, private Storage bucket
`knowledge-originals`, both created by migration `20260929000009`) and processed by the
Trigger.dev tasks in `src/trigger/knowledge.ts`. See
[ADR-007](docs/decisions/ADR-007-knowledge-system.md).

- **Uploads:** PDF, DOCX, TXT, Markdown, CSV · up to 25 MB each, 20 per batch.
- **Google Drive:** on `/connections`, press **Enable** on the Google Drive row of a Google
  account (scope `drive.readonly`, incremental — Calendar/Tasks/Gmail keep working). Then in a
  Space: **Add from Google Drive** → pick folders/files.
- **Notion:** create a _public_ integration at notion.so/profile/integrations (capabilities:
  Read content, plus Update/Insert content for Structured databases), set the redirect URI `{NEXT_PUBLIC_APP_URL}/api/connections/notion/callback`, and
  put `NOTION_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_SECRET` in `.env.local` (and in the
  Trigger.dev environment). Then **Connect Notion** on `/connections` (choose pages in Notion)
  and, in a Space, **Add from Notion**.
- Embeddings use `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`).
- Internal reindex (after changing the embedding model or chunking): trigger the
  `knowledge-reindex` task from the Trigger.dev dashboard with `{}` or `{ "workspaceId": "…" }`.

### Structured Notion (databases)

The same Notion connection also powers **Structured Data**: Notion databases that ELISE
understands field by field. They are read and written live in Notion; ELISE keeps only the
mapping (migration `20260930000014_structured_notion.sql`). See
[ADR-011](docs/decisions/ADR-011-structured-notion.md). Notion API version: `2026-03-11`
(databases → data sources), set once in `src/infrastructure/providers/notion/http.ts`.

1. In the Notion integration settings enable **Read content**, **Update content** and
   **Insert content**. Leave comments off; user information without email is enough.
   Existing connections keep working: re-authorize (**Connect Notion** again) only if you
   changed the integration's capabilities.
2. In Notion, share each database with the integration (database → ••• → Connections).
3. On `/connections` → **Databases** → **Connect a Notion database**: choose the database, review
   ELISE's interpretation of each field, choose what ELISE may change, check the preview,
   confirm.
4. Ask in chat: "What projects are still in progress?", "What's due this week?", "Mark ELISE
   Website as completed", "Create a project called Website Redesign for Firbot".

Bulk changes over 25 records run on Trigger.dev (`structured-bulk`); schemas are re-checked
hourly (`structured-schema-check`) and at most every 10 minutes when used.

### Finance (ELISE Finance, imports, Google Sheets)

Finance tables, the private `finance-imports` bucket and the Finance capability for every
workspace are created by migration `20260930000013_finance.sql`. See
[ADR-010](docs/decisions/ADR-010-finance.md).

- **ELISE Finance:** My Elise → Finance, or chat ("Registrá USD 25 de OpenAI en Software").
  Amounts are exact decimals; totals are always per currency (nothing is converted).
- **Imports (CSV / .xlsx, up to 20 MB):** Finance → Sources → Import. Columns are mapped (rules
  plus an AI suggestion), every row is validated and previewed, probable duplicates are skipped
  unless you include them, and one import can be undone. Imports over 500 rows run on
  Trigger.dev (`finance-import` task).
- **Google Sheets:** on `/connections`, press **Allow** on the Google Sheets row of a Google
  account (scope `spreadsheets.readonly`, incremental: other capabilities keep working, no
  reconnect). Then Finance → Sources → **Connect Google Sheet** (the sheet stays the source of
  truth; ELISE syncs hourly on Trigger.dev and on **Sync now**) or **Import from Google Sheets**
  (rows become ELISE Finance transactions). Recent spreadsheets are listed when Drive is also
  allowed; otherwise paste the spreadsheet link.

### Schedules and Morning Brief (Trigger.dev)

Background work (Schedules, Morning Brief) runs on Trigger.dev. The project ref is in
`trigger.config.ts`; tasks live in `src/trigger/`. See
[ADR-006](docs/decisions/ADR-006-schedules-background-runtime.md).

1. `npx trigger.dev@latest login` (opens a browser).
2. Dashboard → project → **API keys**: copy the **development** secret key into `.env.local` as
   `TRIGGER_SECRET_KEY`.
3. Dashboard → **Environment variables** (Development, later Production): add what the tasks
   need — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SECRET_KEY`, `ELISE_ENCRYPTION_KEY`, `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `OPENAI_API_KEY` (+ `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`), and
   `NOTION_OAUTH_CLIENT_ID`/`_SECRET` if you use Notion. In development the CLI also
   loads your local `.env` files.
4. Run the worker next to the app: `npm run trigger:dev`. The `schedules-dispatch` task runs
   every minute and starts due Schedules; **Run now** starts one immediately.
5. Production: `npx trigger.dev@latest deploy`, and set the production `TRIGGER_SECRET_KEY` on
   the web app host.

Then:

```bash
npm run dev                         # http://localhost:3000
```

Without Supabase variables the app still builds and starts; `/login` explains what is missing.
Without `OPENAI_API_KEY`, everything works except chat, which reports that AI is not configured.

## Environment variables

| Variable                                                           | Required  | Purpose                                                 |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes       | Auth + data (browser-safe; RLS enforces access)         |
| `OPENAI_API_KEY`                                                   | for chat  | Server-only AI provider key                             |
| `OPENAI_MODEL`, `OPENAI_MODEL_FAST`                                | no        | Model names (defaults `gpt-5-mini` / `gpt-5-nano`)      |
| `NEXT_PUBLIC_APP_URL`                                              | prod      | Base URL for auth redirects                             |
| `ELISE_ENV`                                                        | no        | `development` / `staging` / `production` log tag        |
| `CHAT_RATE_LIMIT_PER_MINUTE`                                       | no        | Per-user chat rate limit (default 20)                   |
| `SUPABASE_SECRET_KEY`                                              | Google    | Server-only: encrypted credential store                 |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`             | Google    | OAuth client for Calendar/Tasks/Gmail connections       |
| `ELISE_ENCRYPTION_KEY` (+ optional `_PREVIOUS`)                    | Google    | AES-256-GCM key for OAuth credentials at rest           |
| `TRIGGER_SECRET_KEY`                                               | Schedules | Trigger.dev secret key (one per environment)            |
| `TRIGGER_PROJECT_REF`                                              | no        | Overrides the project ref in `trigger.config.ts`        |
| `OPENAI_EMBEDDING_MODEL`                                           | no        | Knowledge embeddings (default `text-embedding-3-small`) |
| `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`             | Notion    | Notion public integration for Knowledge                 |

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
- **Gmail + Email Copilot:** search and read across Gmail accounts with the account shown;
  thread summaries; "needs reply" / "waiting on" with reasons; replies drafted in the same
  thread and account; new emails ask which account when unclear. Drafting is automatic; sending
  waits for your approval of that exact email (editing it afterwards needs a new approval).
  Bulk archive/mark-read shows count and examples and asks first. Email content is treated as
  untrusted data, never as instructions.
- Deletions requested through chat wait for approval (inline card or Approvals page); approvals
  resolve once, verify the payload hash, and revalidate before executing.
- Actions, tool executions, AI runs and audit events are recorded; logs are structured and
  redacted.
- **My Elise — Habits, Goals, Lists, Notes:** the same data from the UI and from Chat ("create
  a habit to run 3 times a week", "mark gym done", "link my running habit to the half marathon
  goal", "add eggs and coffee to the shopping list", "save this as a note in Firbot"). Habit
  progress, streaks and goal percentages are computed by ELISE (never by the model); habits
  support quantities (2 liters/day, 20 km/week). Notes filed in a Knowledge Space are indexed
  and citable, re-indexed on every edit. CSV import with mapping preview for Habits, Goals and
  Lists. Morning Brief can include Habits and Goals. See
  [ADR-008](docs/decisions/ADR-008-my-elise-native.md).
- **Knowledge:** Spaces (nested: Work › Firbot › RSFA) fed by uploads, Google Drive folders/files
  and Notion pages. Background reading → structure-aware chunks → embeddings → hybrid search
  (vector + full-text, scoped to the Space first). Answers cite their sources `[n]` with a
  Sources card that opens the cited passage, version and original; ELISE says when the Space
  doesn't contain enough evidence. Versions are kept (unchanged content is never re-indexed),
  "what changed" and "compare" use version history, external sources sync hourly and on
  **Sync now**, removed items leave search. "Ask ELISE" from a Space scopes the conversation.
- **Schedules (Programados) + Morning Brief:** create from the Schedules screen or from chat
  ("Every weekday at 7:30 prepare my Morning Brief" → confirmation card). Runs in the background
  on Trigger.dev at the schedule's local time (DST-aware), gathers today's calendar, important
  email, follow-ups and tasks, writes a short brief and stores it. Home shows a quiet
  "Morning Brief ready"; old briefs stay available; history per schedule; Run now, pause,
  resume, edit, delete. Partial failures complete with a warning; late briefs are skipped
  instead of arriving in the afternoon. Optional browser notification (asked in context, no
  content in the preview).
- **Finance:** income and expenses in ELISE Finance, from the UI or chat ("Anotá 48.000 pesos de
  supermercado con Visa", "¿Cuánto gasté en software este mes?", "compará este mes con el
  anterior"). Every total, comparison and insight is computed by ELISE per currency, and USD and
  ARS are never added together. When the currency isn't clear, ELISE asks. You can
  import CSV/XLSX with a mapping, preview and undo, or connect Google Sheets read-only; results
  keep their source (ELISE Finance / each sheet), and a sheet that was also imported isn't counted
  twice. The Morning Brief can include an optional Finance block (off by default; notifications
  never show amounts).
- **Structured Notion:** map Notion databases (field meanings proposed by ELISE, confirmed by
  you) and ask about or change their records from chat. Filters run in Notion (status groups,
  date windows like "this week" or overdue, options); writes are validated against the mapping,
  read-only and calculated fields are never written, several matching records make ELISE ask,
  archiving asks first and bulk changes always need approval with count and examples. Renamed
  fields are followed; removed or retyped fields mark the database as needing attention. Record
  content is treated as data. Document questions still go to Knowledge.
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
