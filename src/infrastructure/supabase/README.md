# infrastructure/supabase

- `client.ts` — browser client (publishable key + session; RLS applies). Used for Realtime.
- `server.ts` — server client for Server Components, Actions and Route Handlers (`server-only`).
- `proxy.ts` — session refresh + optimistic auth redirect, used by `src/proxy.ts`.
- `database.types.ts` — hand-written types matching `supabase/migrations`. Once the project is
  linked, regenerate: `npx supabase gen types typescript --linked > src/infrastructure/supabase/database.types.ts`.
- `repositories/` — persistence for bindings and the action log (actions, approvals, traces, audit).

All clients act as the signed-in user; RLS is the second line of defense and every repository also
filters by `workspace_id`. No service-role client exists yet; when background jobs need one it
must be `server-only` and apply explicit ownership checks.
