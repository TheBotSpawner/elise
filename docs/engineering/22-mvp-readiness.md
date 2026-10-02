# ELISE — MVP readiness

**Document:** `22-mvp-readiness.md` · **Status:** Living · **Decision:** ADR-019

What a new environment needs, how the MVP is verified, and what is knowingly left for later.
Architecture lives in docs 06–21; this is the operational checklist.

---

## 1. Productization audit (2026-10-03)

| Area | Finding before | Now |
| --- | --- | --- |
| Onboarding | 3 steps; "connect" was a "coming soon" placeholder; no profile or first Space | 5 steps with real OAuth, first Space, resume, Home landing with first prompts |
| Existing accounts | Every account still `pending` would be forced through | Migration 22 marks them onboarded; replay from Settings |
| Connections | Binary health; Finance toggle failed validation ("Unexpected error"); "Web: coming soon" though Web is built in | 5 health states with remedies, plain permission lines, disconnect consequences dialog, empty-state intro |
| Errors | ~18 places showed the server's English message ahead of the localized one; env var names in user copy | One `errorText()` mapping; no internals in copy |
| Voice | Long answers cut at 420 chars; STT could hang ("finalizing" forever) | Spoken vs display response; STT/TTS timeouts |
| Chat | Draft lost on failure; double submit = two turns; no offline state; Realtime never reconciled | Draft restored, duplicates dropped, "Reconnecting…", reconcile on reconnect/visibility/online |
| Env | One malformed optional value broke every request | Per-key tolerance; health lists invalid names |
| Security headers | None | CSP, frame, referrer, nosniff, Permissions-Policy (mic self), HSTS in prod |
| Observability | Tokens recorded for chat only | `usage_events` for model, embeddings, STT, TTS, web; `/admin/usage` |
| Accounts | Deleting a user failed (workspace owner FK) | Personal workspace deleted with the account |
| CI / E2E | None | GitHub Actions + Playwright (public checks, golden journeys, screen sweep) |
| Copy | "Elise"/"ELISE" mixed; "por defecto"/"predeterminada" mixed | ELISE everywhere (nav keeps "Mi Elise"); one term |
| Navigation | Shortcuts unreachable from the nav | Under Mi Elise; Contexts not in navigation (standalone profiles reachable by URL only, ADR-018) |

## 2. Golden journeys (manual QA + E2E reference)

| # | Journey | Automated (e2e/) | Manual |
| --- | --- | --- | --- |
| 1 | Daily life: signup → Google connect → "¿Qué tengo hoy?" → plan day → task → Morning Brief | signup, onboarding, task creation | Google consent, real calendar answer, Morning Brief run (needs Trigger.dev) |
| 2 | Student: Space University → Section Administración → upload → "Tomame oral" → progress | Space, Section, upload state | Study session with real model and indexed material |
| 3 | Business: Space Acme → Section Client A → link sources → Work brief → Meeting Prep → draft email | Space/Section flow, approval rendering (mocked turn) | Work brief / Meeting Prep with a real Calendar + Gmail account |
| 4 | Voice: start → multi-turn → interrupt → Shortcut → approval | Shortcut creation; voice state machine in unit tests | Real microphone/speakers (see §6) |
| 5 | Research: current question → Web → sources → save to Knowledge | — | Real web provider |

`npm run test:e2e` runs `public.spec.ts` always; `journeys.spec.ts` and `audit.spec.ts` need a
Supabase project (and `E2E_CHANNEL=chrome` for the audit sweep). They create a throwaway user
and delete it (files, workspace, user) afterwards. The model is mocked at `/api/chat`.

## 3. QA matrix (what was actually exercised, 2026-10-03)

| Dimension | Covered by | Result |
| --- | --- | --- |
| Desktop / Mobile (Pixel 7) | Playwright projects, both | journeys 9/9 each; sweep 15 screens each |
| Light / Dark | Audit sweep, both schemes | no sideways scroll, no technical text, themed backgrounds, no page errors |
| Spanish | All E2E (es-AR) | pass |
| English | Unit tests of dictionaries/type parity only | not swept in a browser |
| No providers | All E2E accounts | pass (Connections intro, onboarding skip) |
| Google only / Notion only / multiple | Unit tests (health derivation, progressive scopes) | not exercised with real consent |
| Voice supported / unsupported | Real Chrome 154: wake check "downloadable"; Edge 154: "unavailable" (row hidden) | no real-microphone test |
| Fresh / migrated account | Fresh: E2E. Migrated: DB test of migration 22 backfill | pass |
| Network failure | Unit/E2E: failed turn keeps the draft; offline banner is UI-only | real network drop not simulated |

## 4. Deployment checklist

1. **Supabase**: `npx supabase link --project-ref <ref>` then `npx supabase db push`. Migrations
   are ordered by timestamp prefix and run once each; all are additive (no `drop table`, no data
   deletes outside triggers). Confirm `knowledge-originals` and `finance-imports` buckets are
   private.
2. **Vercel env** (Production): the three Supabase values (required), `NEXT_PUBLIC_APP_URL`
   (https, no trailing slash), `ELISE_ENV=production`, `OPENAI_API_KEY`, `ELISE_ENCRYPTION_KEY`
   (32 random bytes, base64 — never rotate without `_PREVIOUS`), `SUPABASE_SECRET_KEY`, Google
   and Notion OAuth pairs, `TRIGGER_SECRET_KEY` (`tr_prod_…`), optional `TAVILY_API_KEY`,
   optional `GOOGLE_MAPS_SERVER_API_KEY` + `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` +
   `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (Location, ADR-023: separate restricted keys),
   `ELISE_ADMIN_EMAILS`. `NEXT_PUBLIC_*` are inlined at build: redeploy after changing them.
3. **Trigger.dev**: `npx trigger.dev deploy` with the production key; check the cron tasks
   (schedules every minute, knowledge sync 10 min, finance 15 min, recall sweep 15 min).
4. **Google OAuth**: authorized redirect URI `https://<domain>/api/connections/google/callback`;
   consent screen published; scopes calendar.events, calendar.readonly, tasks, gmail.modify,
   drive.readonly, spreadsheets.readonly.
5. **Notion**: redirect URI `https://<domain>/api/connections/notion/callback`; capabilities
   read/update/insert content.
6. **Supabase Auth**: Site URL = the domain; redirect allow-list includes
   `https://<domain>/auth/callback`; Google sign-in provider configured if offered.
7. **Domain / HTTPS**: HSTS is sent in production; serve only over HTTPS.
8. **Monitor**: `GET /api/health` → 200 (503 means database/auth down). `invalidConfig` lists
   malformed variable names.
9. **Smoke**: sign up, finish onboarding, connect Google, ask "¿Qué tengo hoy?", upload a PDF
   (it must reach Ready — that proves Trigger.dev), run a Morning Brief now.

## 5. Browser support

- Core ELISE: current Chrome, Edge, Safari and Firefox. Feature detection, never user agents.
- Voice: needs `getUserMedia` + `MediaRecorder` + Web Audio; unavailable voice hides its
  controls and text works.
- Wake phrase: only where `SpeechRecognition.available({ processLocally: true })` reports
  on-device support (Chrome today; Edge reports unavailable). Never in background tabs, closed
  browsers or mobile background. A desktop companion stays a documented future option.

## 6. Live validation not performed in this milestone

- **Voice on real hardware** (headphones, laptop speakers, barge-in, self-echo, sleep/wake):
  not run — this environment has no microphone. The state machine, timeouts and the
  spoken/display split are unit-tested; latency marks (`voice.turn_timing`) are logged per turn
  for the measurement (speech end → transcript, transcript → first token, first token → audio).
- **Meeting Prep** with a real Calendar account and **Morning Brief** through Trigger.dev:
  not run (no test Google account; `TRIGGER_SECRET_KEY` not set locally).
- **English** UI sweep, **Google/Notion consent** round-trips.

These are MVP blockers to run manually before calling the MVP ready.

## 7. Backup and recovery

Supabase daily backups (and PITR on paid plans) cover the database. Hard to reconstruct if lost:
encrypted provider credentials (users must reconnect), `ELISE_ENCRYPTION_KEY` (without it every
stored credential is unreadable — keep it in a secret manager), uploaded originals in Storage
(not in database backups), Study progress, Recall summaries (re-indexable from conversations),
audit history. Deleting an account removes its database rows; its Storage originals are not
removed by the cascade (post-MVP cleanup job).

## 8. Data export (gaps)

ELISE-native data (tasks, lists, notes, habits, goals, finance, Spaces/Sections metadata,
conversations, shortcuts, schedules) is workspace-scoped and RLS-readable by its owner, so a
JSON export is a straightforward read service. Not built: no export endpoint, no Storage
originals bundle, no account-deletion UI.

## 9. Success metrics (from `product.event` logs and `usage_events`)

- Activation: `first_successful_turn` within the first session; `onboarding_completed` rate.
- Retention: users with a completed turn on ≥ 3 distinct days in 14.
- Adoption: `connection_added`, `space_created`/`section_created`, `voice_used`,
  `study_started`, `work_brief_run`, `shortcut_run`.
- Reliability: share of `ai_runs` completed; failed `usage_events`; failed schedule/sync runs.
- Latency: median `ai_run.finished.latency_ms` (text) and voice first-audio from turn timings.

## 10. TODO / placeholder sweep

The only marker in code was the Notion OAuth state row's "encrypted placeholder" (Notion has no
PKCE; intentional). No TODO/FIXME/HACK markers. UI "placeholder" attributes are form hints.

## 11. Post-MVP (documented, not built)

Shared rate-limit store; CSP nonces; error-monitoring vendor (logger is the integration point);
analytics provider; JSON export and account deletion UI; Storage cleanup on deletion; per-user
approval rules (`ruleMode` exists in policy, no UI); demo/seed data command (E2E creates its own
throwaway data instead); global search; desktop companion for wake phrase.
