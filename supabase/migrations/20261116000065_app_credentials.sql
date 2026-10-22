-- ADR-112: credentials of ELISE's own applications at external providers (not a user's
-- connection). Mercado Libre rotates its refresh token on every use, so the latest one must be
-- kept somewhere every server instance sees. Encrypted by the application (AES-256-GCM with the
-- provider as context); only the service role reads or writes it: RLS on, no policy for anyone.

create table public.app_credentials (
  provider text primary key check (provider ~ '^[a-z0-9_]{2,40}$'),
  secret_encrypted text not null check (char_length(secret_encrypted) <= 4000),
  updated_at timestamptz not null default now()
);

alter table public.app_credentials enable row level security;
revoke all on public.app_credentials from anon, authenticated;
