# ADR-004 — Google as an external provider (Calendar + Tasks)

**Status:** Accepted (2026-09-29)

## Context

Calendar and Google Tasks are the first external providers. The docs require: connections
separate from ELISE sign-in, multiple accounts per provider, progressive scopes, credentials
server-side only and encrypted, provenance, deterministic write destinations, and the same
capability tools for native and external providers (`07`, `08`, `15`, `17`).

## Decisions

1. **Connections are their own OAuth flow.** Signing in to ELISE with Google (Supabase Auth)
   never authorizes Calendar/Tasks. `/connections` starts authorization code + PKCE with
   `access_type=offline` and `include_granted_scopes=true`; the callback is
   `/api/connections/google/callback`.
2. **Progressive scopes.** Only identity (`openid email profile`) plus the scopes of the
   capabilities the user picked (Calendar: `calendar.events` + `calendar.readonly`; Tasks:
   `tasks`). Grants are stored per capability in `connection_capabilities`; a capability is
   enabled only if all of its scopes were granted. Gmail/Drive later extend `CAPABILITY_SCOPES`
   and are requested incrementally on the same connection.
3. **One connection per Google account per workspace** (`external_account_id` = Google `sub`).
   Reconnecting must use the same account (mismatch is rejected); connecting the same account
   again updates it. Users alias connections ("Personal", "Acme") and add a context label.
4. **Single-use OAuth state.** A random state (only its SHA-256 is stored) in `oauth_states`,
   bound to user + workspace + provider, 10-minute expiry, consumed with `delete … returning`.
   The PKCE verifier is stored encrypted.
5. **Credentials at rest.** `connection_secrets` holds AES-256-GCM ciphertext
   (`ELISE_ENCRYPTION_KEY`, optional `…_PREVIOUS` for rotation), with the workspace and
   connection bound as AAD. RLS is enabled with no policies and API roles have no privileges;
   only the server-side vault (Supabase secret key) reads it, always filtered by workspace and
   connection. Tokens never reach the browser, the model, or logs.
6. **No Google SDK.** OAuth and the Calendar/Tasks REST APIs are called with `fetch` inside
   `src/infrastructure/providers/google/`. Small surface, fully mockable, no large dependency.
7. **Same tools, resolver decides.** The model keeps calling `tasks.*` and `calendar.*`. It may
   pass an optional `destination` in the user's words; the resolver maps it to a connection
   deterministically (alias, account, context or provider name; most specific match wins),
   asks when a write is ambiguous, and aggregates safe reads across accounts with provenance.
8. **Existing items name their account.** External ids are connection-scoped references
   (`x:{connectionId}:…`). Follow-up writes route to that exact connection, which must exist
   in the workspace's bindings — a forged id fails closed.
9. **Content-aware risk.** Creating/updating events with other people escalates to external
   communication (always ask); deleting events always asks. Tools can only escalate risk.
10. **Revocation.** `invalid_grant` marks the connection `needs_reauthorization`, notifies the
    user, and the resolver stops using it. Disconnect revokes at Google (best effort), deletes
    credentials, disables bindings and cancels pending approvals for that connection. Writes
    never fall back to another account.

## Consequences

- `SUPABASE_SECRET_KEY` and `ELISE_ENCRYPTION_KEY` are now required for Google connections.
- Google Tasks cannot store priority, categories, "in progress" or "cancelled"; the adapter
  rejects those explicitly instead of dropping them.
- Calendar event creation is idempotent per action (deterministic Google event id); Google
  Tasks has no idempotency key, so duplicate protection relies on the action log.
