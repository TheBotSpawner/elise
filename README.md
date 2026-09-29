# ELISE

**Status:** early foundation / pre-MVP. No product features are implemented yet.

## Stack

Next.js (App Router, `src/`) · React · TypeScript (strict) · Tailwind CSS · Supabase (`@supabase/ssr`) · Zod · OpenAI Agents SDK (isolated in `src/infrastructure/ai`) · Trigger.dev (not yet connected) · Vitest + Testing Library · ESLint · Prettier

## Requirements

- Node.js 24 LTS or newer
- npm

## Setup

```bash
npm install
cp .env.example .env.local   # optional for now: the app builds and runs without credentials
npm run dev                  # http://localhost:3000
```

## Scripts

| Script                 | Purpose                     |
| ---------------------- | --------------------------- |
| `npm run dev`          | Dev server                  |
| `npm run build`        | Production build            |
| `npm run start`        | Serve production build      |
| `npm run lint`         | ESLint                      |
| `npm run typecheck`    | TypeScript (`tsc --noEmit`) |
| `npm test`             | Vitest in watch mode        |
| `npm run test:run`     | Vitest, single run          |
| `npm run format`       | Prettier write              |
| `npm run format:check` | Prettier check              |

## Structure

- `docs/`: product, architecture and engineering docs (source of truth). Start at [docs/README.md](docs/README.md).
- `src/core/`: ELISE domain concepts, with no external SDKs.
- `src/infrastructure/`: adapters to external services (Supabase, AI, background runtime, providers).
- `src/features/`: user-facing experiences.
- `src/components/`: UI (`ui/` primitives, `shared/`, `elise/`).
- `supabase/migrations/`: database migrations (none yet).
- `tests/`: unit, integration and fixtures.
