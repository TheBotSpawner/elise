# ADR-005 — Gmail as the first Email provider

**Status:** Accepted (2026-09-29)

## Context

Email is the next MVP capability. It must reuse the Google connection foundation (ADR-004):
progressive scopes on the same connection, encrypted credentials, the resolver, provenance and
the existing approval system. Sending email reaches people outside ELISE, and email bodies are
written by third parties (prompt-injection surface).

## Decisions

1. **One scope: `gmail.modify`.** It is the narrowest single Gmail scope that covers search,
   reading threads, drafts, sending, archiving and read state, and it cannot permanently delete
   mail. `gmail.readonly` + `gmail.compose` would still leave archive/read state uncovered, and
   `gmail.metadata` cannot search. It is a Google _restricted_ scope (see Consequences).
2. **Incremental on existing Google connections.** "Enable" on a connected account requests
   identity + `gmail.modify` only, with `include_granted_scopes`. `planCapabilityGrants` keeps
   Calendar/Tasks as they were; Gmail is enabled only if its scope was actually granted.
   Gmail is opt-in (unticked) when adding a new Google account.
3. **Canonical model and tools.** Core defines `EmailMessage`, `EmailThread`, `EmailDraft`,
   `EmailAddress` and the `EmailProvider` port. Model-facing tools are `email.*` (search,
   listRecent, getMessage, getThread, findFollowUps, createDraft, reply, updateDraft, sendDraft,
   discardDraft, archive, markRead, markUnread). No `gmail.*` tool exists.
4. **Drafts first, send separately.** `email.reply` and `email.createDraft` only save drafts
   (automatic). `email.sendDraft` is external communication with `always_ask`. `email.reply`
   computes recipients deterministically (Reply-To/From, never the account itself; reply-all
   only when asked and reported as such) and threads via the original's thread + Message-ID.
5. **Approval pins the exact email.** Tools may `pin` their input before it is hashed:
   `sendDraft` pins a fingerprint of the draft (from, to, cc, bcc, subject, body, thread). If any
   of these change after approval, the send fails with `CONFLICT` and needs a new approval. The
   approval payload carries a `preview` (the email as the user will review it). Clicking Send on
   a draft card (origin `user_ui`) is the approval of the version shown on that card.
6. **New outbound mail asks for the account.** Tools can declare `strictDestination`: with
   several email accounts and no account named (destination/context), the resolver asks instead
   of using the global default. Replies and existing drafts always use the account they live in.
7. **No blind retries.** A timeout or 5xx on any Google write is `UNKNOWN_OUTCOME`. Gmail deletes
   a draft when it is sent, so a repeated send of the same draft fails with `NOT_FOUND` instead of
   sending twice.
8. **Bulk mailbox changes need approval.** archive/markRead/markUnread over more than 5 items
   escalate to an approval (`bulk_change`) with count, account and a sample. Nothing is deleted.
9. **Email content is data.** Bodies reach the model only under `untrustedContent`, clipped
   (thread: last 3 messages ≤4000 chars, older ≤800, max 12 messages; quoted history stripped).
   Policy, approvals and tool availability never depend on email content.
10. **Follow-ups are explainable heuristics.** `findFollowUps` uses thread direction, timing,
    questions and bulk/automated signals, returning reasons and a confidence. AI
    classifications are suggestions and never trigger mailbox changes on their own.

## Consequences

- `gmail.modify` is restricted: publishing beyond Testing mode needs Google verification and a
  security assessment. Testing mode works for listed test users.
- Search results carry metadata only; attachment metadata (name, type, size) appears when a
  message or thread is read. Attachment download is not implemented; `GmailProvider` is the
  place to add it.
- No local email storage: Gmail stays the source of truth; history keeps only compact ids.
