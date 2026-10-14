# Microsoft (Outlook Mail) setup (ADR-058)

ELISE connects Outlook through one **Microsoft Entra app registration** with delegated
permissions. Users sign in with their own Microsoft account. ELISE never uses application
permissions and never reads shared mailboxes.

## 1. Register the app

1. Open <https://entra.microsoft.com> › **Identity › Applications › App registrations › New
   registration**.
2. **Name:** `ELISE`.
3. **Supported account types:** _Accounts in any organizational directory and personal
   Microsoft accounts_ (multitenant + personal). This matches the `common` authority.
4. **Redirect URI:** platform **Web**:
   - Production: `https://your-domain/api/connections/microsoft/callback`.
   - Local: `http://localhost:3000/api/connections/microsoft/callback`.

   Add both (**Authentication › Add URI**). They must equal
   `{NEXT_PUBLIC_APP_URL}/api/connections/microsoft/callback` exactly.

5. **Register.** Copy the **Application (client) ID**.

## 2. Client secret

**Certificates & secrets › New client secret.** Copy the **Value** (shown once) and note its
expiry date. Put a reminder before it expires: an expired secret shows as "Microsoft isn't
configured on this server" until it is replaced.

## 3. API permissions (delegated)

**API permissions › Add a permission › Microsoft Graph › Delegated permissions:**

- `openid`, `profile`, `offline_access`
- `User.Read`
- `Mail.ReadWrite`
- `Mail.Send`

Do **not** add Application permissions or `Mail.*.Shared`.

**Admin consent:**

- Optional for your own tenant: **Grant admin consent** skips the consent screen for its users.
- Organizations that block user consent need one of their administrators to approve ELISE. Until
  then, ELISE shows "your organization requires an administrator to approve ELISE".

## 4. Branding (recommended)

- **Branding & properties:** logo, home page, terms and privacy URLs.
- **Publisher verification** (Microsoft Partner Network): removes the "unverified" warning that
  users from other organizations see on the consent screen.

## 5. Environment

Server only (never `NEXT_PUBLIC_*`), in `.env.local`, Vercel (Production and Preview) and
Trigger.dev:

```env
MICROSOFT_OAUTH_CLIENT_ID=...
MICROSOFT_OAUTH_CLIENT_SECRET=...
# Optional: common (default) | organizations | consumers | <tenant id>
MICROSOFT_OAUTH_TENANT=common
```

`ELISE_ENCRYPTION_KEY` and `SUPABASE_SECRET_KEY` must already be set (credentials are stored
encrypted).

**Trigger.dev:** schedules and the Morning Brief read Outlook from the worker. Its environment
needs these, with the same values as Vercel:

- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ELISE_ENCRYPTION_KEY`
- `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`
- `OPENAI_API_KEY`

If they are missing there, scheduled runs report Outlook as a setup problem, never as "not
connected".

## 6. Database

Apply `supabase/migrations/20261026000045_microsoft_outlook.sql`. It is additive: it registers
the `microsoft` provider and its `email` capability.

## 7. Connect

**Connections › Microsoft › Conectar**: Microsoft asks to pick an account, then for consent.
Connect several accounts by repeating this. Each one gets a name, a "use this account for"
context and, when several can send, a default.

## What to expect

- **Sending** always waits for your approval of the exact draft.
- **Disconnecting** deletes ELISE's credentials. Microsoft has no revoke endpoint for this, so to
  remove ELISE completely also remove it at <https://myapps.microsoft.com> (work/school) or
  <https://account.live.com/consent/Manage> (personal).
- **Reconnecting:** password changes, revoked consent and Conditional Access policies mark the
  account "Needs reconnecting", with a notification.
- **Throttling:** busy periods are reported as "try again shortly", never as disconnected.
