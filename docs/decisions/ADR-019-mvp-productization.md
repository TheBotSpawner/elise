# ADR-019: MVP productization — onboarding, health, usage and reliability

**Status:** Accepted (2026-10-03). No new product areas: this makes ADR-001…018 work as one
product. Operational details live in `docs/engineering/22-mvp-readiness.md`.

## Context

Every MVP capability existed, but a new user met a three-step onboarding whose "connect" step
was a "coming soon" placeholder, Connections showed only "connected / needs attention", voice
cut long answers at 420 characters, usage was recorded for chat only, a malformed optional
environment variable broke every request, there were no security headers, no CI and no E2E
layer, and an account could not be deleted (the workspace's owner foreign key blocked it).

## Decision

1. **First-run onboarding** (`/onboarding`, `features/onboarding`): five short steps —
   Welcome ("ELISE connects your tools, knowledge and routines so you can ask once and act
   everywhere"; Get started / Explore first), Profile (name, language, time zone), Connect
   (Google with per-product choice, Notion; "You choose what ELISE can access"), first Space
   (Work / University / Personal / My business / custom, with the Section hint for each), Ready.
   It ends on Home (`/?welcome=1`) with up to three first prompts chosen from what was set up
   and a microphone hint when voice is available. Progress is stored per step in
   `user_preferences` (`onboarding.progress`); the OAuth flows return to `/onboarding` through
   an allow-listed `return_path` and the flow resumes at Connect. Accounts that existed before
   migration 22 are marked onboarded; anyone can replay it from Settings › Privacy.
2. **Connection health** (`core/providers/health.ts`): `connected`, `permission_missing`,
   `expired`, `needs_attention`, `unavailable`, derived from the stored status, enabled
   capabilities, granted scopes, the last error and server configuration. Each has one plain
   remedy (Allow access asks only for the missing products; Reconnect keeps name, context and
   bindings). Each product row says in plain words what ELISE can do with it. Disconnect opens a
   dialog listing what stops, what is removed, what stays.
3. **Spoken vs display response**: on voice turns the model writes the spoken synthesis inside
   `<spoken>…</spoken>` and the screen answer after it. `SpokenSplitter` separates them while
   streaming; the server sends `spoken` events (never shown) and `text` events (shown, stored).
   The client speaks only the spoken part; a reply without it falls back to speaking the text
   with the existing sentence cap. If only the spoken part exists, it is also shown on screen.
4. **Usage observability**: `usage_events` (server-written, member-readable, metadata only)
   filled by the adapters themselves (model turns with input/cached/output/reasoning tokens,
   embeddings, transcription, speech, web search) inside an `AsyncLocalStorage` scope opened by
   each entry point (chat/voice turn, voice I/O, every Trigger task). Costs are estimates from
   `config/pricing.ts`. `/admin/usage` shows aggregates to `ELISE_ADMIN_EMAILS` only.
5. **Health and configuration**: `infrastructure/health.ts` is the internal health model;
   `/api/health` answers 200/503 on database+auth readiness and lists optional domains as
   states. `serverEnv()` drops a malformed optional value with a warning instead of failing.
6. **Flags and entitlements**: `config/flags.ts` (per-environment defaults, `ELISE_FLAGS`
   overrides incl. per-workspace), used for research and the wake phrase. `core/entitlements.ts`
   is the future-plan seam (one MVP entitlement set); no billing.
7. **Reliability**: chat drops duplicate submits of the same text while a turn is in flight,
   aborts a stream silent for 90 s, keeps a failed typed message in the composer, shows
   "Reconnecting…" offline and does not send until back; Realtime re-reads server state after
   a dropped channel, a long-hidden tab or a network return; voice transcription is bounded on
   both client (25 s) and server (20 s), speech synthesis at 15 s.
8. **Security**: CSP and security headers (microphone only for ELISE's origin); redaction of
   Google/Notion/Tavily token formats; IPv6 tunnel ranges blocked for web fetches, with redirect
   and DNS-rebinding tests; Knowledge parsing checks content against the declared type; per-user
   limits on uploads and OAuth starts; browsers can no longer delete connection capabilities or
   bindings; deleting an account deletes its personal workspace (trigger on `auth.users`).
9. **Product events** (`infrastructure/observability/analytics.ts`): a fixed, content-free set
   (onboarding, connections, first successful turn, Spaces, Sections, Study, Work brief, voice,
   Shortcuts) written to the structured log; a provider plugs in behind `setAnalyticsSink`.
10. **Model policy** (`core/agents/model-policy.ts`): tier and reasoning effort per task in one
    table.

## Consequences

- One additive migration (`20261003000022_productization.sql`); nothing is dropped.
- The CSP keeps `'unsafe-inline'` for scripts (no per-request nonces): framing, plugins, base
  and form targets are locked down, script injection relies on React's escaping.
- In-memory rate limits are per server instance (documented ceiling).
- Storage originals are not removed by the database cascade when an account is deleted.
- Playwright's bundled Chromium crashes on `SpeechRecognition.available()`; E2E runs on real
  Chrome (`E2E_CHANNEL=chrome`).
