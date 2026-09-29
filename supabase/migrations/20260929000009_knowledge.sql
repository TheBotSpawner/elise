-- Knowledge (docs/architecture/09, 16 §34-41): Spaces, Sources, Items, Versions, Chunks and
-- Sync runs, with pgvector + full-text for hybrid retrieval. Every row carries workspace_id and
-- every query is scoped by it; RLS is the second line of defense.

create extension if not exists vector with schema extensions;

update public.capability_definitions set status = 'available' where key = 'knowledge';
update public.provider_definitions set status = 'available' where key = 'notion';

-- ── Spaces ───────────────────────────────────────────────────────────────────
create table public.knowledge_spaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  parent_space_id uuid references public.knowledge_spaces (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index knowledge_spaces_workspace_idx on public.knowledge_spaces (workspace_id, parent_space_id);

-- A parent must be in the same workspace, and a Space can never be its own ancestor.
create or replace function public.check_knowledge_space_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cursor_id uuid := new.parent_space_id;
  depth integer := 0;
begin
  if new.parent_space_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.knowledge_spaces p
    where p.id = new.parent_space_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'parent space must belong to the same workspace';
  end if;
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'a space cannot be moved under itself';
    end if;
    depth := depth + 1;
    if depth > 12 then
      raise exception 'spaces can be nested at most 12 levels';
    end if;
    select p.parent_space_id into cursor_id from public.knowledge_spaces p where p.id = cursor_id;
  end loop;
  return new;
end;
$$;

create trigger knowledge_spaces_parent before insert or update of parent_space_id, workspace_id
  on public.knowledge_spaces for each row execute function public.check_knowledge_space_parent();
create trigger knowledge_spaces_updated_at before update on public.knowledge_spaces
  for each row execute function public.set_updated_at();

-- ── Sources ──────────────────────────────────────────────────────────────────
-- What feeds a Space: uploads, a Drive selection, a Notion page tree, later ELISE Notes.
create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  provider_key text not null references public.provider_definitions (key),
  connection_id uuid references public.provider_connections (id) on delete set null,
  source_type text not null check (source_type in ('upload', 'google_drive', 'notion', 'note')),
  display_name text not null check (char_length(display_name) between 1 and 200),
  source_url text,
  -- Selected roots (folders, files, pages) — never "the whole account" implicitly.
  configuration jsonb not null default '{}'::jsonb,
  status text not null default 'idle' check (status in (
    'idle', 'syncing', 'ready', 'needs_attention', 'disconnected', 'archived'
  )),
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_error_code text,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint knowledge_sources_connection check (
    (source_type in ('upload', 'note')) or connection_id is not null or status in ('disconnected', 'archived')
  )
);

create index knowledge_sources_space_idx on public.knowledge_sources (workspace_id, space_id);
create index knowledge_sources_due_idx on public.knowledge_sources (next_sync_at)
  where status in ('idle', 'ready', 'needs_attention') and archived_at is null and source_type in ('google_drive', 'notion');
-- One uploads source per Space.
create unique index knowledge_sources_one_upload on public.knowledge_sources (space_id)
  where source_type = 'upload' and archived_at is null;

create trigger knowledge_sources_updated_at before update on public.knowledge_sources
  for each row execute function public.set_updated_at();

-- ── Items and versions ───────────────────────────────────────────────────────
create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  item_type text not null check (item_type in (
    'file', 'drive_file', 'google_doc', 'google_sheet', 'google_slides',
    'notion_page', 'notion_database_page', 'note'
  )),
  -- Provider id (Drive file id, Notion page id); for uploads, a stable id of the upload.
  external_id text not null,
  title text not null check (char_length(title) between 1 and 500),
  source_url text,
  mime_type text,
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'ready', 'needs_attention', 'failed', 'removed', 'archived'
  )),
  status_detail text,
  error_code text,
  current_version_id uuid,
  external_modified_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (source_id, external_id)
);

create index knowledge_items_space_idx on public.knowledge_items (workspace_id, space_id, status);
create index knowledge_items_recent_idx on public.knowledge_items (workspace_id, updated_at desc);

create trigger knowledge_items_updated_at before update on public.knowledge_items
  for each row execute function public.set_updated_at();

create table public.knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  knowledge_item_id uuid not null references public.knowledge_items (id) on delete cascade,
  version_number integer not null check (version_number > 0),
  -- Provider revision / modified time, when the provider has one.
  source_revision text,
  -- SHA-256 of the extracted text: unchanged content is never re-embedded.
  content_hash text,
  -- Original file in Storage (uploads) — never public.
  storage_path text,
  size_bytes bigint,
  mime_type text,
  extracted_text text,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'ready', 'failed', 'unchanged', 'superseded'
  )),
  parser_version text,
  chunking_version text,
  embedding_model text,
  chunk_count integer not null default 0,
  is_current boolean not null default false,
  runtime_job_id text,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (knowledge_item_id, version_number)
);

create unique index knowledge_versions_one_current on public.knowledge_versions (knowledge_item_id)
  where is_current;
create index knowledge_versions_recent_idx on public.knowledge_versions (workspace_id, created_at desc);

alter table public.knowledge_items
  add constraint knowledge_items_current_version_fk foreign key (current_version_id)
  references public.knowledge_versions (id) on delete set null;

-- ── Chunks ───────────────────────────────────────────────────────────────────
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  knowledge_item_id uuid not null references public.knowledge_items (id) on delete cascade,
  version_id uuid not null references public.knowledge_versions (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  heading_path text[] not null default '{}',
  page_number integer,
  token_count integer not null default 0,
  embedding extensions.vector(1536),
  embedding_model text,
  fts tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (version_id, chunk_index)
);

create index knowledge_chunks_scope_idx on public.knowledge_chunks (workspace_id, space_id);
create index knowledge_chunks_item_idx on public.knowledge_chunks (knowledge_item_id);
create index knowledge_chunks_fts_idx on public.knowledge_chunks using gin (fts);
create index knowledge_chunks_embedding_idx on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ── Sync runs ────────────────────────────────────────────────────────────────
create table public.knowledge_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  trigger text not null check (trigger in ('scheduled', 'manual', 'initial')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'completed', 'completed_with_warning', 'failed', 'cancelled'
  )),
  runtime_job_id text,
  started_at timestamptz,
  completed_at timestamptz,
  items_discovered integer not null default 0,
  items_created integer not null default 0,
  items_updated integer not null default 0,
  items_removed integer not null default 0,
  items_failed integer not null default 0,
  error_code text,
  created_at timestamptz not null default now()
);

-- One sync at a time per source.
create unique index knowledge_sync_runs_one_active on public.knowledge_sync_runs (source_id)
  where status in ('queued', 'running');
create index knowledge_sync_runs_source_idx on public.knowledge_sync_runs (source_id, created_at desc);

-- ── Hybrid retrieval ─────────────────────────────────────────────────────────
-- Scope first (workspace, spaces, items; current versions of ready items only), then combine
-- semantic and keyword candidates with reciprocal rank fusion. SECURITY INVOKER: RLS applies
-- to the caller on top of the explicit workspace filter.
create or replace function public.search_knowledge_chunks(
  p_workspace_id uuid,
  p_keywords text,
  p_embedding extensions.vector(1536),
  p_embedding_model text,
  p_space_ids uuid[] default null,
  p_item_ids uuid[] default null,
  p_limit integer default 12
)
returns table (
  chunk_id uuid,
  knowledge_item_id uuid,
  version_id uuid,
  space_id uuid,
  chunk_index integer,
  content text,
  heading_path text[],
  page_number integer,
  similarity double precision,
  semantic_rank bigint,
  keyword_rank bigint,
  score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with scoped as (
    select c.*
    from public.knowledge_chunks c
    join public.knowledge_items i
      on i.id = c.knowledge_item_id and i.current_version_id = c.version_id
    where c.workspace_id = p_workspace_id
      and i.workspace_id = p_workspace_id
      and i.status = 'ready'
      and i.archived_at is null
      and (p_space_ids is null or c.space_id = any (p_space_ids))
      and (p_item_ids is null or c.knowledge_item_id = any (p_item_ids))
  ),
  semantic as (
    select s.id,
           1 - (s.embedding operator(extensions.<=>) p_embedding) as similarity,
           row_number() over (order by s.embedding operator(extensions.<=>) p_embedding) as rnk
    from scoped s
    where p_embedding is not null and s.embedding is not null and s.embedding_model = p_embedding_model
    order by s.embedding operator(extensions.<=>) p_embedding
    limit greatest(p_limit, 1) * 4
  ),
  keyword as (
    select s.id,
           row_number() over (order by ts_rank_cd(s.fts, q) desc) as rnk
    from scoped s, to_tsquery('simple'::regconfig, p_keywords) q
    where coalesce(p_keywords, '') <> '' and s.fts @@ q
    order by ts_rank_cd(s.fts, q) desc
    limit greatest(p_limit, 1) * 4
  )
  select c.id, c.knowledge_item_id, c.version_id, c.space_id, c.chunk_index, c.content,
         c.heading_path, c.page_number,
         sem.similarity,
         sem.rnk,
         kw.rnk,
         coalesce(1.0 / (60 + sem.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0)
  from semantic sem
  full outer join keyword kw on kw.id = sem.id
  join scoped c on c.id = coalesce(sem.id, kw.id)
  order by 12 desc
  limit greatest(p_limit, 1);
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.knowledge_spaces enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.knowledge_versions enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_sync_runs enable row level security;

create policy "Members read spaces" on public.knowledge_spaces
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members create spaces" on public.knowledge_spaces
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by_user_id = auth.uid());
create policy "Members change spaces" on public.knowledge_spaces
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members read sources" on public.knowledge_sources
  for select to authenticated using (public.is_workspace_member(workspace_id));
-- A source may only use a connection of the same workspace, in a Space of the same workspace.
create policy "Members add sources" on public.knowledge_sources
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.knowledge_spaces s
      where s.id = space_id and s.workspace_id = knowledge_sources.workspace_id
    )
    and (
      connection_id is null or exists (
        select 1 from public.provider_connections c
        where c.id = connection_id and c.workspace_id = knowledge_sources.workspace_id
      )
    )
  );

create policy "Members read items" on public.knowledge_items
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members read versions" on public.knowledge_versions
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members read chunks" on public.knowledge_chunks
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members read sync runs" on public.knowledge_sync_runs
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- Ingestion writes items, versions, chunks and runs server-side (service role) after checking
-- ownership. Source changes after creation (status, sync state) are server-side as well.
revoke insert, update, delete on public.knowledge_items, public.knowledge_versions,
  public.knowledge_chunks, public.knowledge_sync_runs from anon, authenticated;
revoke update, delete on public.knowledge_sources from anon, authenticated;
revoke delete on public.knowledge_spaces from anon, authenticated;
revoke all on public.knowledge_spaces, public.knowledge_sources from anon;

alter publication supabase_realtime add table
  public.knowledge_spaces, public.knowledge_sources, public.knowledge_items, public.knowledge_sync_runs;

-- ── Storage: originals of uploaded files ─────────────────────────────────────
-- Private bucket; paths are workspace/{workspace_id}/knowledge/{item_id}/{version_id}/{file}.
-- No policies for API users: uploads use short-lived signed upload URLs issued by the server
-- after checking ownership, and downloads use short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge-originals',
  'knowledge-originals',
  false,
  26214400,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/octet-stream'
  ]
)
on conflict (id) do nothing;
