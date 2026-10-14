# ADR-058: Microsoft Outlook Mail as an Email provider

**Status:** Accepted (2026-10-14). Migration `20261026000045_microsoft_outlook.sql` (additive).

## Context

Email is a canonical capability (docs/architecture/07 §24). Until now Gmail was its only
provider. Many users work in Microsoft 365 or have personal Outlook.com / Hotmail mailboxes.

The goal is to add Outlook without a second email system:

- the model never sees provider tools;
- Gmail keeps working unchanged;
- one workspace can mix several Google and several Microsoft accounts.

## Decision

### Shape

```
Email capability (core/capabilities/email.ts, core/tools/email.ts)
├── GmailProvider     (infrastructure/providers/google/gmail.ts)
└── OutlookProvider   (infrastructure/providers/microsoft/outlook.ts, Microsoft Graph v1.0)
```

- **Microsoft is a provider family** (`provider_key = "microsoft"`). Today it implements only
  `email`. Calendar, OneDrive and To Do can be added later as more capabilities on the same
  connection.
- **No new tools:** the model keeps using `email.search`, `email.reply`, `email.sendDraft`, and so
  on. The resolver picks the provider. `outlook`, `hotmail`, `microsoft 365` and `office 365`
  count as provider names for "send it from Outlook".

### OAuth

- **Flow:** Microsoft identity platform v2, authorization code + PKCE (S256), confidential web
  client. The secret stays on the server.
- **Authority:** `common` by default, so work/school and personal accounts both work.
  `MICROSOFT_OAUTH_TENANT` can pin `organizations`, `consumers` or a tenant id.
- **Callback:** `/api/connections/microsoft/callback`.
- **State and PKCE:** the same machinery as Google. An `oauth_states` row is single-use,
  bound to the user, workspace and provider, and stores the PKCE verifier encrypted.
- **Scopes (delegated only):** `openid profile offline_access User.Read Mail.ReadWrite Mail.Send`.
- **Consent decision:** read/organize and send are requested together, in one consent.
  - Gmail works the same way: `gmail.modify` covers reading, drafts and sending in one scope.
  - The protection against unwanted sends is ELISE's deterministic approval policy, not the
    scope. Progressive `Mail.Send` would add a second consent step at the worst moment
    (right before sending) without changing what ELISE may do unapproved.
- **Not requested:**
  - application permissions;
  - `.default`;
  - `Mail.*.Shared`.
  Shared mailboxes are out of scope. The connection model (one account per connection,
  capabilities per connection) leaves room to add them later.
- **Identity:**
  - From Graph `/me`.
  - The key is the stable Graph user `id` (`external_account_id`), never the address.
  - The address shown is `mail`, falling back to `userPrincipalName`.
  - Reconnecting must pick the same account; another account is added as a new connection.

### Tokens

- **Storage:** the existing encrypted vault (`connection_secrets`, AES-GCM, AAD bound to
  workspace + connection).
- **Refresh:** reuses the Google token lifecycle class, which now takes an injectable `refresh`.
  - Microsoft rotates refresh tokens; the new one replaces the stored one.
  - The refresh asks again for exactly the scopes that were granted.

### Error taxonomy

Microsoft's refusals map to a stable `reason` (never the raw description, which can echo
identifiers):

| Microsoft says                                      | Reason                   | ELISE error             |
| --------------------------------------------------- | ------------------------ | ----------------------- |
| user cancelled / declined consent (`access_denied`, AADSTS65004) | `cancelled`   | PERMISSION_DENIED       |
| admin approval needed (AADSTS90094/90095/90099/900941/650052) | `admin_consent_required` | PERMISSION_DENIED |
| consent withdrawn (AADSTS65001, `consent_required`) | `consent_revoked`        | AUTH_EXPIRED            |
| Conditional Access / MFA (AADSTS53000-53003, 50076, 50079, 50158, `interaction_required`, `insufficient_claims`) | `conditional_access` | AUTH_EXPIRED |
| refresh token expired (AADSTS70008, 700082, 700084, 50173, 70043, 50133) | `expired` | AUTH_EXPIRED |
| other `invalid_grant`                               | `revoked`                | AUTH_EXPIRED            |
| bad/expired client secret (AADSTS7000215/7000222, 700016…) | `client_misconfigured` | SERVER_NOT_CONFIGURED |
| Graph 403                                           | —                        | PERMISSION_DENIED (reconnect) |
| mailbox not reachable (`MailboxNotEnabledForRESTAPI`) | —                      | CAPABILITY_UNAVAILABLE  |
| 429 / throttled                                     | —                        | RATE_LIMITED            |

- **What marks the connection:**
  - `AUTH_EXPIRED` marks it `needs_reauthorization`, with that reason in `last_error_code`.
    One notification and one audit event follow (same path as Google).
  - Throttling and outages never mark it, and are never shown as "disconnected".
- **Callback failures:** the callback adds `reason=` to the redirect, so Connections can say,
  for example, that an administrator has to approve ELISE.

### Graph usage

- **Ids:**
  - `Prefer: IdType="ImmutableId"` on every call, so archiving (a move) keeps the refs ELISE
    already showed.
  - Refs: `m` = message id, `t` = `conversationId` (the canonical thread), `d` = draft id.
- **Bodies:**
  - `Prefer: outlook.body-content-type="text"`: Graph converts HTML.
  - `uniqueBody` drops quoted history.
  - Any HTML that still arrives goes through the same `htmlToText` as Gmail.
  - Bodies stay untrusted data in the tool outputs, exactly as with Gmail.
- **Search:**
  - **Words** (text / from / to / subject) use KQL `$search`. Graph can't combine it with
    `$filter`/`$orderby`, so ELISE:
    - pads the date range to whole days;
    - fetches up to 3× the limit (max 100);
    - applies the exact bounds, unread and category afterwards.
  - **Structured filters only:** an indexed `$filter` + `$orderby receivedDateTime desc`.
  - **Folders:** inbox / sent use their folders. Drafts, Deleted Items and Junk are excluded,
    like Gmail's defaults.
  - **Focused ≈ Primary:** "Other" has no Gmail equivalent, so it gets no category.
- **Threads:** messages filtered by `conversationId`, sorted client-side, drafts excluded.
- **Drafts:**
  - A new email: `POST /me/messages`.
  - A reply: `createReply` on the original (found by Message-ID, else the conversation's
    latest message), so Outlook keeps its own threading. Then a PATCH sets the recipients,
    subject and text that ELISE computed.
  - `email.reply` with reply-all already computes the Cc, so `createReplyAll` is not needed.
  - Forward is not a canonical operation, so it is not implemented.
  - Every write on a `d` ref checks the item is still a draft first, so sending or deleting
    never touches a received message.
- **Send:** `POST /messages/{id}/send` (202). The sent copy gets a new id; ELISE looks it up in
  Sent Items by Message-ID (best effort).
- **Archive:** a move to the well-known `archive` folder, only for messages still in the
  inbox (like removing Gmail's INBOX label). Read state: PATCH `isRead`.
- **Attachments:** metadata only (name, type, size, non-inline). There is no canonical download
  operation yet.
- **Throttling:**
  - At most 4 requests in flight per mailbox (Graph's per-mailbox limit).
  - `Retry-After` is honoured, with exponential backoff when absent, at most 2 retries and 8 s.
  - A 429 is retried for writes too, because Graph didn't process it.
  - 5xx on a write is `UNKNOWN_OUTCOME`, never retried or claimed as done.
  - Folder ids come in one `$batch` and are cached per connection.

### Product

- **Connections:** Microsoft is live in the Hub.
  - Provider Detail lists each account with the same card as Google: alias, "use this account
    for", default star, reconnect, disconnect.
  - Microsoft has no token-revocation endpoint. Disconnect deletes the credentials and says so,
    and points to the Microsoft account settings to remove the app.
- **Provenance:** email cards show "Outlook · Firbot" / "Gmail · Personal", and "Open in Outlook".
- **Unchanged:**
  - draft-first;
  - send needs the approval pinned to the exact draft;
  - reads aggregate across every healthy account;
  - writes resolve the sender strictly and ask when ambiguous;
  - the Morning Brief and schedules resolve Email bindings at run time;
  - needs-reply / waiting-on stay canonical.
- **No mailbox replication:** nothing from Outlook is stored in ELISE.

## Consequences

- **New environment:** `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` and the
  optional `MICROSOFT_OAUTH_TENANT`, on Vercel and on Trigger.dev (for schedules). Setup steps
  are in `docs/engineering/24-microsoft-setup.md`.
- **Tenant consent:** organizations that block user consent need an administrator to approve
  ELISE once. ELISE explains this instead of failing vaguely.
- **Search limits:** `$search` is relevance-ranked and capped, so a word search is bounded.
  It feels like Gmail for recent mail, but very old matches beyond the cap aren't returned.
- **Client secret lifetime:** Entra client secrets expire (at most 24 months). An expired one
  surfaces as `SERVER_NOT_CONFIGURED`, never as the user's account being broken.
