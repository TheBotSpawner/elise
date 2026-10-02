-- Structured Data (ADR-011): mapped external databases (Notion data sources) queried and
-- edited through canonical fields. The external database stays authoritative: ELISE stores
-- only the mapping (which property means what, what ELISE may change), never the records.

insert into public.capability_definitions (key, display_name, status)
values ('structured', 'Structured Data', 'available')
on conflict (key) do update set status = 'available';

insert into public.provider_capabilities (provider_key, capability_key)
values ('notion', 'structured')
on conflict do nothing;

create table public.structured_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid references public.provider_connections (id) on delete set null,
  provider_key text not null default 'notion' check (provider_key in ('notion')),
  -- Notion: the database (container) and the data source inside it that holds the records.
  database_id text not null check (char_length(database_id) between 1 and 100),
  data_source_id text not null check (char_length(data_source_id) between 1 and 100),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- Words that point at this source in chat ("projects, development, Acme").
  context text check (char_length(context) <= 200),
  -- generic today; declared types (e.g. habits) let a canonical capability use it later.
  semantic_type text not null default 'generic' check (semantic_type in ('generic', 'habits')),
  schema_fingerprint text not null,
  schema_snapshot jsonb not null default '[]'::jsonb,
  field_mappings jsonb not null default '[]'::jsonb,
  allow_read boolean not null default true,
  allow_create boolean not null default false,
  allow_update boolean not null default false,
  allow_archive boolean not null default false,
  status text not null default 'active' check (status in ('active', 'needs_attention', 'paused', 'archived')),
  -- What changed at the source since mapping (renamed / removed / retyped fields).
  schema_issues jsonb not null default '{}'::jsonb,
  schema_checked_at timestamptz,
  url text,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index structured_sources_data_source_idx
  on public.structured_sources (workspace_id, connection_id, data_source_id) where archived_at is null;
create unique index structured_sources_name_idx
  on public.structured_sources (workspace_id, lower(name)) where archived_at is null;
create index structured_sources_check_idx on public.structured_sources (schema_checked_at) where archived_at is null;

create or replace function public.check_structured_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.connection_id is not null and not exists (
    select 1 from public.provider_connections c
    where c.id = new.connection_id and c.workspace_id = new.workspace_id and c.provider_key = new.provider_key
  ) then
    raise exception 'connection must belong to the same workspace and provider';
  end if;
  return new;
end;
$$;

create trigger structured_sources_connection before insert or update on public.structured_sources
  for each row execute function public.check_structured_source();
create trigger structured_sources_updated_at before update on public.structured_sources
  for each row execute function public.set_updated_at();

alter table public.structured_sources enable row level security;
create policy "Members read structured sources" on public.structured_sources
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add structured sources" on public.structured_sources
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change structured sources" on public.structured_sources
  for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
revoke delete on public.structured_sources from anon, authenticated;
revoke all on public.structured_sources from anon;

alter publication supabase_realtime add table public.structured_sources;

-- Existing Notion connections gain Structured Data without reconnecting. Whether ELISE can
-- insert/update is decided by the integration's capabilities in Notion and per source here.
insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level, authorized_scopes)
select c.workspace_id, c.id, 'structured', 'write', array['notion:read_content', 'notion:update_content', 'notion:insert_content']
from public.provider_connections c
where c.provider_key = 'notion' and c.status <> 'disconnected'
on conflict (connection_id, capability_key) do nothing;

insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
select c.workspace_id, 'structured', c.id,
  -- The oldest Notion workspace is the default; the source named in a request decides otherwise.
  c.id = (
    select c2.id from public.provider_connections c2
    where c2.workspace_id = c.workspace_id and c2.provider_key = 'notion' and c2.status <> 'disconnected'
    order by c2.created_at, c2.id limit 1
  )
from public.provider_connections c
where c.provider_key = 'notion' and c.status <> 'disconnected'
  and not exists (
    select 1 from public.capability_bindings b
    where b.connection_id = c.id and b.capability_key = 'structured'
  );

-- Bulk structured changes run in the background after approval. The job row carries the
-- approved change (exact record ids); the runtime payload carries only the job id.
alter table public.background_jobs drop constraint if exists background_jobs_job_type_check;
alter table public.background_jobs add constraint background_jobs_job_type_check
  check (job_type in ('schedule.run', 'structured.bulk'));
alter table public.background_jobs add column if not exists input jsonb;
