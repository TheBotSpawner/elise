# Slack setup (ADR-062)

ELISE connects Slack through **one Slack app** with **user-token scopes only**. Each person
connects their own Slack user in each workspace. ELISE acts as that user, and never as a bot.
Per-workspace tokens are stored encrypted in the database, never in environment variables.

## 1. Create the app from the manifest

1. Open <https://api.slack.com/apps> › **Create New App** › **From a manifest**.
2. Pick the workspace the app is created in (for example Firbot).
3. Paste the manifest below, replacing `https://your-domain` with `NEXT_PUBLIC_APP_URL`.

```yaml
display_information:
  name: ELISE
  description: Your personal assistant. Searches Slack live, cites what it finds, and sends only what you approve.
  background_color: "#111111"
oauth_config:
  redirect_urls:
    - https://your-domain/api/connections/slack/callback
  scopes:
    # User scopes only: ELISE acts as the person who connects, never as a bot.
    user:
      - search:read.public
      - search:read.private
      - search:read.im
      - search:read.mpim
      - search:read.files
      - search:read.users
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - im:read
      - im:history
      - mpim:read
      - mpim:history
      - users:read
      - team:read
      - chat:write
      - im:write
      - reactions:write
      # Only for an unlisted distributed app (see "Distribution"); remove otherwise.
      # - search:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  # Keep false until rotation has been validated on a real workspace: it can't be turned off.
  token_rotation_enabled: false
```

- **Requested at connect:** ELISE asks only for the scopes the user chooses. Public channels are
  always included; private channels, DMs, files, sending and reactions are each opt-in.
- **Manifest scopes are a ceiling:** a scope must be listed here before ELISE can request it.
- **Not used:** no bot scopes, events, slash commands, interactivity or `SLACK_SIGNING_SECRET`.
  ELISE doesn't receive inbound events.

## 2. Credentials

**Basic Information › App Credentials:** copy the **Client ID** and **Client Secret**. Server
only, never `NEXT_PUBLIC_*`. Set them in `.env.local`, on Vercel (Production and Preview) and on
Trigger.dev:

```env
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
# Only for an unlisted distributed app (see Distribution):
# SLACK_LEGACY_SEARCH=true
```

`ELISE_ENCRYPTION_KEY` and `SUPABASE_SECRET_KEY` must already be set: the tokens are stored
encrypted.

**Trigger.dev:** the Morning Brief reads Slack from the worker. Its environment needs the same
values as Vercel:

- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ELISE_ENCRYPTION_KEY`
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
- `SLACK_LEGACY_SEARCH`, if used

If they are missing there, a brief with a Slack block shows Slack as a setup problem
(`SERVER_NOT_CONFIGURED`), never as "not connected". The rest of the brief still runs.

## 3. Redirect URL

Slack requires **HTTPS**, matching exactly:

```text
{NEXT_PUBLIC_APP_URL}/api/connections/slack/callback
```

`http://localhost` is rejected. For local work, use an HTTPS tunnel and add its URL as a second
redirect URL, or test on a deployed preview.

## 4. Database

Apply `supabase/migrations/20261027000046_slack_team_messaging.sql`. It is additive:

- registers the `slack` provider and the `team_messaging` capability;
- adds `connection_secrets.refresh_lease_until`, used for rotating tokens.

## 5. Connect

**Connections › Slack › Conectar:** choose permissions, then Slack asks for consent. Repeat with
**+ Conectar otro workspace** for each workspace.

On each workspace card:

- **Alias:** e.g. "Firbot".
- **"Usar este workspace para":** e.g. "Firbot Solutions, chatbots". ELISE uses it to pick the
  workspace a request is about.
- **Allow:** grants a missing permission. It runs Slack's consent again for that same workspace
  and never creates a duplicate.

## Distribution: what works where

Slack restricts two things by how the app is distributed (Slack docs, October 2026):

| App | Real-time Search | `conversations.history` / `.replies` |
| --- | --- | --- |
| Internal (installed only in its own workspace) | ✅ | normal tiers |
| Marketplace-listed | ✅ | normal tiers |
| Distributed but **unlisted** | ❌ not allowed | ~1 request/min, 15 messages per call |

- **Second workspace:** connecting one (for example Centro Larrea) needs **Manage Distribution ›
  Activate Public Distribution**, which makes the app distributed. Until it is Marketplace-listed:
  1. Add `search:read` to the manifest's user scopes.
  2. Set `SLACK_LEGACY_SEARCH=true` (Vercel and Trigger.dev).
  3. Reconnect each workspace so the grant includes `search:read`.

  ELISE then searches with `search.messages`, filtered back to the conversations each user
  allowed, and reads 15 messages per call.
- **Thread and history limits:** reading threads and channel windows works but is throttled. A
  second read within a minute reports "Slack is limiting requests, try again shortly". A Morning
  Brief there should name **one** channel.
- **Semantic search:** needs Slack AI Search (Business+ / Enterprise+). Otherwise RTS is keyword
  search. Both work.
- **Removing the fallback:** after Marketplace approval, remove `SLACK_LEGACY_SEARCH` and
  `search:read`.

## Token rotation

ELISE supports Slack token rotation:

- 12-hour access tokens and single-use refresh tokens.
- A per-connection refresh lease, so concurrent requests never redeem a refresh token twice.
- One retry after a refresh.
- Needs Reconnect when Slack rejects the refresh token.

**Slack can't turn rotation off once it is on.** Enable it only after validating, on a test
workspace, that:

1. a token refreshes after 12 hours;
2. two concurrent requests refresh once;
3. a revoked app shows "Needs reconnecting".

Turning it on applies to new installations. Existing long-lived tokens keep working until
exchanged.

## Disconnecting

- **What happens:** Connections › Slack › the workspace › **Disconnect** revokes the user's token
  in Slack (`auth.revoke`), deletes ELISE's credentials and cancels pending approvals for that
  workspace.
- **What stays:** nothing is deleted in Slack. Threads the user explicitly saved to Knowledge stay
  there.

## Troubleshooting

- **Logs:**
  - `slack.oauth.start` reports `configured`, missing setting *names* and `unlisted`, never
    values.
  - `connection.slack_callback_failed` includes the reference shown to the user.
  - Each Slack call logs `slack.api` with method, attempts, latency and `rate_limited`, never
    arguments or content.
- **"Slack isn't configured on this server":** `SLACK_CLIENT_*` are missing in that environment.
- **"This needs the latest ELISE database update":** migration 046 isn't applied.
- **"Slack search isn't available for this workspace":** Slack refused Real-time Search for this
  app. See Distribution.
- **Needs reconnecting:** the user removed the app, was deactivated, or a rotating token's refresh
  was rejected. Reconnect from the workspace card.
