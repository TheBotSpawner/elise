# infrastructure/supabase

- `client.ts`: browser client (Client Components). Publishable key only.
- `server.ts`: server client (Server Components, Server Actions, Route Handlers). `server-only`.

Credentials are read lazily, so the app builds without them. A client throws only when used without env vars.

Not yet implemented (added with Auth): the session-refresh `proxy.ts` (Next.js 16 replacement for `middleware.ts`), and an admin client using `SUPABASE_SECRET_KEY`, which must be `server-only` and never imported from the browser.

Pending manual setup: create the Supabase project and fill `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local`. Migrations live in `/supabase/migrations`.
