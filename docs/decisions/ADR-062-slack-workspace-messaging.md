# ADR-062: Slack and the Team Messaging capability

**Status:** Accepted (2026-10-15). Migration `20261027000046_slack_team_messaging.sql` (additive).

## Context

People make decisions, share files and agree on next steps in Slack. ELISE should be able to
answer "¿qué dijeron hoy en Slack sobre Centro Larrea?", open the thread where a problem was
discussed, and send "en 10 minutos entro" to a teammate, from the normal conversation.

Constraints:

- **Capabilities, not providers:** the model must never see `slack.*` tools (docs/architecture/07).
- **No replication:** Slack stays the source of truth. ELISE must not sync, index or embed a
  workspace. It queries Slack live, takes only what the answer needs, and cites it.
- **Several workspaces from day one:** for example Firbot, Centro Larrea and a personal workspace.
- **Outbound messages are external communication:** they go through ELISE's deterministic
  approval policy, never through the model's judgment.

Verified against Slack's docs (docs.slack.dev, October 2026):

- **Real-time Search (`assistant.search.context`):**
  - The current search API. A user token needs no `action_token`.
  - Scopes: `search:read.public|private|im|mpim|files|users`.
  - About 10 requests per minute per user. Slack recommends fewer than 10 calls per inquiry.
  - Up to 20 results per page. Semantic retrieval applies only with `sort=score` on AI-Search
    plans; `sort=timestamp` is keyword retrieval.
  - Available only to internal and directory-published (Marketplace) apps. "No unlisted
    distributed apps."
  - Data retrieved with it must not be stored or copied.
- **Legacy search:** `search.messages` with `search:read` is legacy. Slack asks RTS apps not to
  use it.
- **Commercially distributed, non-Marketplace apps** (since May 2025, and for existing installs
  since March 2026): `conversations.history` and `conversations.replies` are Tier 1, about 1
  request per minute and at most 15 objects per call. Internal apps and Marketplace apps keep the
  normal tiers.
- **OAuth v2:**
  - Redirect URLs must be HTTPS.
  - `user_scope` can be requested without bot scopes.
  - Scopes accumulate across consents and can't be downgraded except by revoking.
- **Token rotation:**
  - Access tokens last 12 hours. Refresh tokens are single-use.
  - Once enabled for an app, rotation can't be turned off.

## Decision

### Shape

```
Team Messaging capability   core/capabilities/team-messaging.ts, core/tools/team-messaging.ts
└── SlackProvider           infrastructure/providers/slack/team-messaging.ts (Web API)
    (Microsoft Teams can be a second provider later)
```

- **Capability key:** `team_messaging`. It is separate from Email: channels, threads, people and
  reactions are not mail.
- **Tools:** the model sees `teamMessaging.*`, and nothing is Slack-specific:
  - Reads: `search`, `listChannels`, `findUser`, `getRecent`, `getThread`, `getMessage`.
  - Writes: `draftMessage`, `sendMessage`, `reply`, `addReaction`, `removeReaction`,
    `saveToKnowledge`.
  - `uploadFile` is not implemented. ELISE's chat attachments aren't an outbound file store yet.
    It can be added on the same provider.
- **Slack MCP:** the official Slack MCP server (`mcp.slack.com`) is not used.
  - Calling it from the model would bypass ELISE's executor: resolution, permissions, approvals
    and audit.
  - It has the same distribution rule as RTS: no unlisted apps.
  - It could later become a transport under `SlackProvider`, with a different client behind the
    same contract. The tools wouldn't change.

### Connections and OAuth

- **Flow:** OAuth v2, user-token scopes only (no bot user). ELISE acts as the user who connected.
  - Private channels and DMs are reachable only if that user allows them.
  - RTS needs no `action_token`.
- **Model:** the generic connections model is reused, so there is no Slack-specific account
  table.
  - One `provider_connections` row per user and workspace: `external_account_id =
    "<team id>:<user id>"`.
  - The same pair reconnecting updates that row. Another workspace, or another user of the same
    workspace, is a new connection.
  - A reconnect that returns a different workspace is refused, and the new token is revoked.
- **Metadata in `auth_metadata`:** team id, name, domain and icon; enterprise id and name; Slack
  user id, name and handle; whether token rotation is on. No message data.
- **Grant:** stored in `connection_capabilities` (`team_messaging`) with the exact granted scopes,
  merged across consents. Slack accumulates scopes.
- **Permissions the user chooses:** each maps to the user scopes ELISE actually uses.

  | Permission | Scopes |
  | --- | --- |
  | Public channels (always) | `search:read.public`, `search:read.users`, `channels:read`, `channels:history`, `users:read`, `team:read` |
  | Private channels | `search:read.private`, `groups:read`, `groups:history` |
  | Direct messages | `search:read.im`, `search:read.mpim`, `im:read`, `im:history`, `mpim:read`, `mpim:history` |
  | Files | `search:read.files` |
  | Send messages | `chat:write`, `im:write` (to open a DM before posting) |
  | Reactions | `reactions:write` |

- **What's not requested:**
  - `reactions:read`, `files:read` and `files:write`: unused today.
  - Bot scopes.
- **Shown as allowed:** a permission shows as allowed only when all of its scopes are in the
  grant.
- **Allowing another permission:** runs Slack's consent again for that connection, with a `team`
  hint. It is the same grant, so no duplicate connection is created.
- **State:** the same single-use, user- and workspace-bound `oauth_states` row as the other
  providers.
  - Slack's flow uses the client secret server-side, with no PKCE.
  - Callback: `/api/connections/slack/callback`.
- **Tokens:** stored in the existing encrypted vault (`connection_secrets`, AES-GCM, AAD bound to
  workspace and connection). They never reach the browser or logs.
- **Disconnect:** calls `auth.revoke` (best effort) and deletes the credentials.

### Token rotation

The credential model handles both kinds of token.

- **Long-lived tokens:** stored with a far expiry and never refreshed. `invalid_auth` or
  `token_revoked` marks the connection Needs Reconnect.
- **Rotating tokens:**
  - Refreshed before expiry, and once more on `token_expired`, retrying the call once.
  - Refresh tokens are single-use, so only one refresher runs at a time across instances and the
    worker. That one holds a 30-second lease (`connection_secrets.refresh_lease_until`, migration
    046).
  - Callers without the lease wait for the replacement it stores. The holder re-reads the vault
    first, in case someone refreshed just before.
  - A rejected refresh token marks the connection Needs Reconnect.
- **Turning rotation on:** don't enable it in the Slack app until this path has been validated
  against a real workspace. It can't be turned off again
  (docs/engineering/25-slack-setup.md).

### Retrieval: live, bounded, cited

- **Search first:**
  - `teamMessaging.search` is one RTS call with at most 20 results.
  - `channel_types` covers only what the grant allows.
  - Person and channel filters become `from:<@U…>` / `in:<#C…>`.
  - Time becomes exact `after`/`before` instants. ELISE resolves "hoy", "desde el lunes" and
    "antes de la reunión" deterministically in the user's timezone (`searchWindow`).
- **Expand only what matters:**
  - A thread (`conversations.replies`, one page) or one channel window
    (`conversations.history`, one page).
  - Pages hold at most 50 messages, or 15 on an unlisted app.
  - Never pagination through history. More is reported as "older messages exist".
- **Provenance on every result:** workspace, channel, author, time, permalink, and the thread when
  the message is a reply (from the permalink's `thread_ts`).
- **Not searched:** when private channels or DMs weren't searched because the grant doesn't allow
  them, results say so. That is never shown as "Slack is disconnected".
- **Documented fallback (only case):**
  - Applies to an unlisted distributed app, where Slack doesn't offer RTS.
  - Set `SLACK_LEGACY_SEARCH=true`. ELISE then requests `search:read` and searches with
    `search.messages`.
  - Results are filtered back to the kinds of conversation the user allowed. Date bounds are
    applied exactly afterwards.
  - It is also used when Slack refuses RTS for a workspace (`feature_not_enabled`…) and the
    legacy scope exists.
  - Once ELISE is Marketplace-listed, remove the flag.
- **No copies:**
  - Slack text reaches the model as `untrustedContent` for that turn only.
  - Before a turn is stored, Team Messaging results keep provenance (who, where, when, permalink)
    but not text (`teamDisplayForStorage`).
  - Turn notes carry refs, never text.
  - The live Canvas state holds the visible snippets: it is the current session's working state,
    expiring like any Surface.
  - Nothing goes to Knowledge, Memory or Recall unless the user asks.
- **Explicit save:**
  - "Guardá este thread en el Knowledge de Firbot" → `saveToKnowledge`.
  - The thread is read with `conversations.replies` and saved as a Markdown snapshot.
  - The snapshot has its provenance in the document and in `knowledge_items.metadata.snapshot`:
    workspace, channel, thread ref, authors, dates, permalinks.

### Which workspace

- **Reads and writes use one workspace** (`singleAccount`). The executor resolves it:
  1. the workspace the user named (`destination`: alias, team name, "slack");
  2. the conversation's Section/context matching the connection's alias or "Use this workspace
     for";
  3. the only connected one;
  4. otherwise ELISE asks (`clarification_required`).
- **All workspaces:** searched only when the user asks (`allWorkspaces`). Results are interleaved
  by rank with workspace provenance, and unreachable workspaces are listed, not hidden.
- **Existing items:** refs (`x:<connection>:m|t|c|u:…`) route to the workspace that holds them. A
  ref never reaches another workspace.
- **Scope of the context hint:** only tools that opt in (`singleAccount`). Email and other
  capabilities resolve exactly as before.

### Writes and approvals

| Operation | Kind | Default |
| --- | --- | --- |
| `draftMessage` | write (nothing leaves ELISE) | automatic |
| `sendMessage`, `reply` | external_communication, high | always asks |
| `addReaction`, `removeReaction` | write | automatic, audited |
| `saveToKnowledge` | write | automatic (only on request) |

- **Pinned before approval:** sending resolves the destination before approval.
  - "Rod" becomes exactly one person ref, "#sales" exactly one channel.
  - Two people called Martín fail with both candidates, so ELISE asks. No approval is created.
- **What the approval covers:** the pinned input (destination ref, exact text, connection), shown
  as a draft card ("Rod Díaz · Firbot").
- **After approval:** the stored payload hash is checked again. A changed text or destination is
  `CONFLICT` and nothing is sent.
- **The send itself:** Slack's confirmation (channel, `ts`) and permalink become the result. The
  audit event records provider, workspace, destination, message ref, time and permalink, never
  the text.
- **Reactions:** a reversible single emoji written as the user, so they run without asking and
  are audited. A user rule or a later ADR can tighten this.

### Errors

Slack's error strings map onto ELISE's existing taxonomy. The model and the UI receive the
product state, never Slack's raw text.

| State (product) | ELISE code | Slack says |
| --- | --- | --- |
| Needs reconnect | `AUTH_EXPIRED` | `invalid_auth`, `token_revoked`, `account_inactive`, refresh rejected |
| Permission missing | `PERMISSION_DENIED` + `reason: missing_scope` + `needed` | `missing_scope` (never marks the connection) |
| Not allowed there | `PERMISSION_DENIED` | `not_in_channel`, `restricted_action`, `access_denied`… |
| Not connected / search unavailable | `CAPABILITY_UNAVAILABLE` | no binding; `feature_not_enabled`, `assistant_search_context_disabled` |
| Server not configured | `SERVER_NOT_CONFIGURED` | missing `SLACK_CLIENT_*` (Vercel or worker), `bad_client_secret` |
| Rate limited | `RATE_LIMITED` | 429 / `ratelimited` beyond the bounded retry |
| Temporary failure | `PROVIDER_UNAVAILABLE` | 5xx on reads, timeouts |
| Unknown outcome | `UNKNOWN_OUTCOME` | 5xx or timeout on a write (never retried) |
| Not found | `NOT_FOUND` | `channel_not_found`, `thread_not_found`… |
| Ambiguous destination | `VALIDATION_ERROR` + `reason: ambiguous_destination` + candidates | — |

- **Rate limits:**
  - `Retry-After` is honoured with up to 20% jitter, at most 2 retries and 8 s. 429 is retried
    for writes too, because Slack didn't process it.
  - A longer wait is reported as `RATE_LIMITED` with Slack's `retryAfterSeconds`.
  - Every call logs method, connection, attempts, latency and rate-limit state, never arguments
    or content.

### Live Canvas

- **New Surface types:** `team_messages` and `team_thread`.
- **Fixed keys per interaction:**
  - A new search or channel read updates the one results Surface, even when it finds nothing, so
    an old answer never stays on screen.
  - "Mostrame ese thread" updates the one thread Surface.
  - A draft and its send update one draft card.
  - No window per message, and no five near-identical Slack windows.
- **Reactions:** a line in the conversation, not a Surface.
- **Approval card:** shows the exact message and destination.

### Schedules / Morning Brief

- **Opt-in block:** the `slack` block names one workspace, up to 5 channels, and a window: since
  the previous run (computed from the schedule's definition) or the last 24 h.
- **What runs:** one `teamMessaging.getRecent` per channel, sequentially, pinned to that
  connection.
  - Never RTS in the background, never a crawl.
  - On an unlisted app, Slack's 1-per-minute history limit makes more than one channel return
    `RATE_LIMITED` for the rest. Prefer one channel there.
- **What the brief keeps:** at most 5 messages per channel, clipped to 240 characters, as part of
  the brief the user configured. These come from conversation reads, never from RTS.
- **No Slack block:** no section and no warning.
- **Missing Slack settings on the worker:** that block's warning is `SERVER_NOT_CONFIGURED`
  (`server_config`), never "Slack disconnected".

## Consequences

- **New environment:** `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, on Vercel and on Trigger.dev;
  optional `SLACK_LEGACY_SEARCH`. No tokens in environment variables.
- **Distribution:**
  - RTS works in the workspace where the Slack app was created, as an internal app, and for any
    workspace once the app is Marketplace-listed.
  - Connecting other workspaces before that means a distributed, unlisted app: legacy search
    (`SLACK_LEGACY_SEARCH`) and Tier-1 history reads.
  - Marketplace listing is the path to full behavior everywhere.
- **Semantic search:** needs the workspace to have Slack AI Search (Business+ / Enterprise+).
  Otherwise RTS is keyword search.
- **Redirect URLs are HTTPS-only:** local development needs an HTTPS tunnel (or testing on a
  deployed preview).
- **Product:**
  - Slack is live in the Connections Hub, with one card per workspace (icon, name, connected user,
    health, alias, "Use this workspace for", permissions with progressive "Allow").
  - Email and the other capabilities are unchanged.
