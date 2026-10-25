# ADR-121: OCR without keys — Workload Identity Federation on Vercel, a token broker for jobs

**Status:** Accepted (2026-10-24). Changes how ADR-035's OCR authenticates; OCR itself is the same.

## Context

ADR-035 authenticated Google Document AI with a service account's JSON key. The organization's
policy `iam.disableServiceAccountKeyCreation` blocks creating keys for `elise-document-ocr`, and
it should stay on: a permanent key is the credential most likely to leak.

OCR runs in two places:
- **Vercel** — chat attachments (`attachments-service`).
- **Trigger.dev Cloud** — Knowledge ingestion (`knowledge-background`).

**What was checked (2026-10-24):**
- **Vercel** issues an OIDC token per deployment (`@vercel/oidc`, issuer
  `https://oidc.vercel.com/[TEAM_SLUG]`, subject
  `owner:[TEAM]:project:[PROJECT]:environment:[ENV]`). Google Workload Identity Federation
  accepts it and exchanges it for a service account's token of at most one hour. This is
  Vercel's documented GCP integration.
- **Trigger.dev Cloud** has no workload identity to federate: no OIDC token per run. Its docs
  only show JSON keys for Google. Vercel's token doesn't exist on its workers.

## Decision

1. **On Vercel: Workload Identity Federation.**
   - Vercel's OIDC token goes to Google STS, which returns a federated token.
   - The federated token calls `iamcredentials generateAccessToken` for
     `elise-document-ocr`, which returns a one-hour token.
   - No key exists anywhere. Configured by four identifiers, none of them secret:
     `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`,
     `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`, `GCP_SERVICE_ACCOUNT_EMAIL`.
   - Implemented with `fetch` against Google's two REST endpoints, not `google-auth-library`.
     `@vercel/oidc` only reads Vercel's token, and is loaded lazily.
2. **In Trigger.dev jobs: a token broker on Vercel.**
   - The job asks `POST /api/internal/ocr-token` (`OCR_TOKEN_BROKER_URL`, HTTPS only) for the
     one-hour token.
   - The request is HMAC-signed with **`OCR_BROKER_SECRET`** and valid for 60 s. The signing
     key is derived for this one purpose and compared in constant time. The same random value
     (≥ 32 characters) goes in Vercel and Trigger.dev.
   - Vercel answers through federation (1). It reuses its token while 10 minutes remain; jobs
     cache theirs until a minute before it expires.
   - **Why a secret of its own, not `SUPABASE_SECRET_KEY`** (reviewed 2026-10-24): Supabase
     allows several named secret keys, so Vercel and Trigger.dev may hold different ones and
     the broker would fail silently. Rotating the database key would also break OCR. And the
     database key shouldn't be spread to more uses than it needs. The broker secret only lets
     its holder obtain a Document AI token for an hour.
3. **The OCR account keeps a single role:** `roles/documentai.apiUser`. A brokered token can do
   nothing else.
4. **Unchanged:** the Document AI calls (`:process`, page selection, limits, usage records).
   The JSON-key path stays available for organizations that allow keys.
5. **Order of use:**
   - a JSON key;
   - otherwise federation;
   - otherwise the broker;
   - otherwise no OCR — scanned pages are reported as unreadable (ADR-035).

## Consequences

- Google trusts only the Vercel project and environment named in the pool's principal. A token
  leaked from either side expires within the hour.
- Rotating `OCR_BROKER_SECRET` means changing it in Vercel and Trigger.dev together; nothing
  else is affected.
- `/api/health` reports `ocr: ready | not_configured` (no values).
- Background OCR depends on the Vercel deployment being reachable. If the broker fails, the
  document is marked "needs attention" and can be retried, as with any OCR failure.
- If Trigger.dev Cloud ever offers OIDC identities per run, (2) can federate directly too.
