# ADR-092: Every screen in ELISE Desktop

**Status:** Accepted (2026-10-19). Amends ADR-081 (the "todavía se abre en el navegador" stopgap).

## Context

ADR-081 shipped Desktop with three routed screens (Inicio, Hogar, Settings). The other ~44
routes, and onboarding, said "Esta sección todavía se abre en el navegador" and opened the web.
The reason was structural: each web `page.tsx` was a Server Component that loaded its data and
rendered its view in one function. Desktop's local renderer can run the view, but not the server
half. Porting screens one by one would have meant a second copy of each screen.

## Decision

1. **Every route is split once, for both platforms.**
   - `load.ts`: the server loader, `(auth, { params, search }) => props`. It may call
     `redirect`, `notFound` or `after`, exactly as the page did.
   - `view.tsx`: `"use client"`, `export function View(props)`, with no server imports.
   - `page.tsx` is thin: auth, then `<View {...await load(auth, …)} />`.
   - Screens with no data are view-only. A route with only a redirect has only a loader.
2. **One typed route list.** `src/core/platform/app-routes.ts` (`APP_ROUTES`, `matchAppRoute`)
   is shared by:
   - the cloud registry `src/app/(app)/route-loaders.ts`;
   - the renderer registry `desktop/src/renderer/route-views.ts`.

   Static segments win over dynamic ones. Malformed or oversized parameters don't match.
3. **Desktop renders the same view.**
   - `GET /api/desktop/page?path=` runs the route's loader with the person's own session. RLS
     applies as on the web.
   - It returns `{props}`. A loader `redirect` comes back as `{redirect}`, which Desktop follows
     in place; `notFound` comes back as NOT_FOUND, shown as an in-app "No hay nada acá".
   - Writes go through the same Server Actions as RPC (ADR-081).
4. **Navigation stays in the window.**
   - A link to ELISE Cloud's own origin that matches an app route opens in the app: in the
     renderer router and in the main process (`will-navigate`, `window.open`).
   - Anything else goes to the system browser, after the existing URL validation.
   - On return from the browser (window focus after more than 5 s), the current screen refreshes,
     so OAuth connections show up without a reload.
5. **Onboarding runs in the window** (full screen, outside the shell) through the same loader
   and view.
6. **Real platform limits stay explicit.**
   - Google sign-in and provider OAuth consent still happen in the system browser (ADR-084):
     Desktop can't host a third-party consent page.
   - `signOut` ends Desktop's own session.
7. **Module overrides match every import form.** Vite applies the `@` alias before plugins,
   and shared code also imports relatively, so overrides keyed by the raw specifier silently
   never applied (Hogar's local control, sign-out). `desktop/override-key.ts` normalizes every
   form to one `@/…` key.

## Consequences

- A new screen is a `load.ts` plus a `view.tsx` and works on both platforms. The route
  inventory test fails if a page isn't in `APP_ROUTES`, or if a registry, loader or view is
  missing or has a server import.
- Desktop needs the matching cloud deploy: a view and its loader version together. With an old
  cloud, a new Desktop shows its in-app error or not-found screen for routes the cloud doesn't
  know yet. It never opens the browser or shows a blank window.
- Remaining special cases:
  - Inicio and Hogar, which keep their offline cache and local control;
  - Desktop's own Settings section (`/settings/desktop`).
