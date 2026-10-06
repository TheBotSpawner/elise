# ADR-043: Connections Hub — providers, then accounts, then capabilities

**Status:** Accepted (2026-10-05). UX and information architecture only. OAuth flows, token
encryption, bindings, multi-account support and canonical capabilities are unchanged.

## Context

`/connections` rendered every account of every provider, with all of its capability controls,
on one long page. With three Google accounts, Notion and the Music providers it was already
heavy. ELISE is expected to reach dozens of providers and many accounts per provider.

## Decision

1. **Three levels, three places:**
   - **Hub** (`/connections`): providers only.
   - **Provider Detail** (`/connections/[provider]`, deep-linkable): that provider's accounts.
   - **Account** (expanded inside the detail): capabilities, default marks, alias,
     "use this account for", allow or reconnect, and disconnect.
2. **One catalog** (`core/providers/catalog.ts`). Each provider has an id, name, category,
   canonical capabilities, search keywords, whether it supports multiple accounts,
   availability (live or planned), and whether it is built in.
   - Descriptions and intros are i18n.
   - The Hub and the detail render from the catalog. Authentication and capability logic stay
     in the adapters.
   - Planned providers (Microsoft 365, Slack, GitHub, Dropbox, Deezer) are listed so people
     find them, and are not connectable yet.
3. **Search first.** Client-side, immediate, case- and accent-insensitive; every word must
   match. It covers the provider name, its description, its capabilities in the user's language,
   everyday aliases ("gmail", "correo", "música", "drive") and connected account names ("UTN"
   finds Google). Filters: All, Connected, Available.
4. **Hub content.** A compact strip of connected providers (an account count, or a dot for
   single-account providers, and a warning mark when one needs attention). Then the catalog,
   grouped by category when not searching. Each card shows the icon, name, a short
   description, and one status line:
   - "3 cuentas conectadas · Calendar · Gmail…" when connected;
   - "⚠ 1 necesita atención" when an account needs the user;
   - "Conectar" when not connected;
   - "Próximamente" when planned.
   ELISE's built-in data sits apart, marked "Integrado", with no Connect button.
5. **Aggregated status** (`summarize`): connected, partially connected, needs attention,
   reconnect required, not connected, or unavailable — derived from the accounts' existing
   health. The Hub never shows provider errors. In the detail, accounts that need the user open
   on their own, showing the exact capability, the reason and its action (Allow, Reconnect).
6. **Same actions.** Connect, connect another account, allow, reconnect, toggle, default,
   rename, context and disconnect call the same server actions. OAuth callbacks still land on
   `/connections` (an allowlisted return path); the Hub then shows the result and opens the
   provider's detail with the new account expanded (`?opened=`).
7. **Notion's mapped databases** moved from the Hub to Notion's detail.

## Consequences

- The Hub uses only persisted connection metadata (one `listConnections`), so nothing is
  called at the provider to draw it.
- Account panels render only inside their provider's page.
- A new provider is a catalog entry plus its adapter and connect action. Its brand mark is
  optional (a monogram tile is used otherwise).
- Expanded and collapsed account state is still remembered per browser
  (`elise.connections.expanded`).
