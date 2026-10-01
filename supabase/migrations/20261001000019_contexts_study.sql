-- Context Profiles, Study Mode and Client / Work Intelligence (ADR-016).
-- Additive: new tables, two nullable columns on live_workspaces, and the Recall search RPC
-- recreated with an optional context filter. No existing data is changed.
--
-- A Context Profile is an organizational layer over existing data: links point to resources,
-- nothing is copied, and a context never grants access (every read still goes through the
-- executor, bindings, permissions and RLS).

insert into public.capability_definitions (key, display_name, status) values
  ('contexts', 'Contexts', 'available'),
  ('study', 'Study', 'available')
on conflict (key) do update set status = 'available';

-- ── Context Profiles ─────────────────────────────────────────────────────────
create table public.context_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('study', 'client', 'project', 'work', 'custom')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- Lowercase, accent-free name (computed by the application) for uniqueness and lookup.
  name_key text not null check (char_length(name_key) between 1 and 80),
  description text check (char_length(description) <= 1000),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  icon text check (icon ~ '^[a-z-]{1,30}$'),
  accent text check (accent ~ '^[a-z]{1,20}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Routing preferences ("prefer the Work Gmail account"), never rules or policy.
  instructions text check (char_length(instructions) <= 1000),
  -- Study profiles only (lightweight on purpose).
  study_target_date date,
  study_objective text check (char_length(study_objective) <= 500),
  study_level text check (char_length(study_level) <= 60),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index context_profiles_name_idx on public.context_profiles (workspace_id, name_key)
  where status = 'active';
create index context_profiles_workspace_idx on public.context_profiles (workspace_id, status);

create trigger context_profiles_updated_at before update on public.context_profiles
  for each row execute function public.set_updated_at();

-- ── People and organizations (lightweight entities, docs/architecture/11 §28-29) ─
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  entity_type text not null check (entity_type in ('person', 'organization')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  name_key text not null check (char_length(name_key) between 1 and 200),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  -- Lowercase. An email belongs to at most one active entity (trigger below).
  emails text[] not null default '{}' check (cardinality(emails) <= 10),
  domains text[] not null default '{}' check (cardinality(domains) <= 10),
  organization_id uuid references public.entities (id) on delete set null,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'system')),
  confirmed boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint entities_org_not_self check (organization_id is null or organization_id <> id)
);

create index entities_workspace_idx on public.entities (workspace_id, entity_type) where archived_at is null;
create index entities_emails_idx on public.entities using gin (emails);
create index entities_domains_idx on public.entities using gin (domains);

create trigger entities_updated_at before update on public.entities
  for each row execute function public.set_updated_at();

create or replace function public.check_entity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is not null and not exists (
    select 1 from public.entities o
    where o.id = new.organization_id and o.workspace_id = new.workspace_id and o.entity_type = 'organization'
  ) then
    raise exception 'organization must be an organization of the same workspace';
  end if;
  -- Deterministic identity: never two active people with the same email (no silent merges).
  if new.archived_at is null and cardinality(new.emails) > 0 and exists (
    select 1 from public.entities e
    where e.workspace_id = new.workspace_id and e.id <> new.id and e.archived_at is null
      and e.emails && new.emails
  ) then
    raise exception 'an email can belong to only one person or organization';
  end if;
  return new;
end;
$$;

create trigger entities_check before insert or update on public.entities
  for each row execute function public.check_entity();

-- ── Context links (where that part of the user's world lives) ────────────────
create table public.context_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  context_profile_id uuid not null references public.context_profiles (id) on delete cascade,
  link_type text not null check (link_type in (
    'knowledge_space', 'knowledge_item', 'structured_source', 'account', 'task_list',
    'native_list', 'note', 'person', 'organization',
    'email_domain', 'email_address', 'web_domain', 'calendar_keyword', 'keyword'
  )),
  -- Resource links carry the resource's id (ELISE UUIDs, or connection-scoped refs for
  -- external task lists); value links carry the value. Exactly one of them.
  resource_id text check (char_length(resource_id) <= 600),
  value text check (char_length(value) between 1 and 320),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  -- false: suggested by ELISE and not yet confirmed (never used for retrieval until confirmed).
  confirmed boolean not null default true,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((resource_id is null) <> (value is null))
);

create unique index context_links_unique_idx
  on public.context_links (context_profile_id, link_type, coalesce(resource_id, value));
create index context_links_profile_idx on public.context_links (workspace_id, context_profile_id);
create index context_links_resource_idx on public.context_links (workspace_id, link_type, resource_id)
  where resource_id is not null;

-- A link only points at a record of the same workspace; values have the right shape.
create or replace function public.check_context_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ok boolean;
  ref_connection text;
begin
  if not exists (
    select 1 from public.context_profiles p
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'context link must belong to a profile of the same workspace';
  end if;

  if new.link_type in ('email_domain', 'web_domain') then
    ok := new.value ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$';
  elsif new.link_type = 'email_address' then
    ok := new.value ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$';
  elsif new.link_type in ('calendar_keyword', 'keyword') then
    ok := new.value is not null and char_length(btrim(new.value)) between 2 and 80;
  elsif new.resource_id is null then
    ok := false;
  elsif new.link_type = 'task_list' and new.resource_id like 'x:%' then
    -- An external list: its connection-scoped ref names a connection of this workspace.
    ref_connection := split_part(new.resource_id, ':', 2);
    ok := ref_connection ~ '^[0-9a-f-]{36}$' and exists (
      select 1 from public.provider_connections c
      where c.id = ref_connection::uuid and c.workspace_id = new.workspace_id
    );
  elsif new.resource_id !~ '^[0-9a-f-]{36}$' then
    ok := false;
  else
    ok := case new.link_type
      when 'knowledge_space' then exists (select 1 from public.knowledge_spaces r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'knowledge_item' then exists (select 1 from public.knowledge_items r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'structured_source' then exists (select 1 from public.structured_sources r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'account' then exists (select 1 from public.provider_connections r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'task_list' then exists (select 1 from public.task_lists r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'native_list' then exists (select 1 from public.lists r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'note' then exists (select 1 from public.notes r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id)
      when 'person' then exists (select 1 from public.entities r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id and r.entity_type = 'person')
      when 'organization' then exists (select 1 from public.entities r where r.id = new.resource_id::uuid and r.workspace_id = new.workspace_id and r.entity_type = 'organization')
      else false
    end;
  end if;
  if not coalesce(ok, false) then
    raise exception 'invalid context link (%): it must reference a record of the same workspace or a valid value', new.link_type;
  end if;
  return new;
end;
$$;

create trigger context_links_check before insert or update on public.context_links
  for each row execute function public.check_context_link();

-- ── Interactions known to belong to a context (Recall association) ───────────
-- Only when it is known: the context was activated, a study session ran, or Meeting Prep
-- recognized it. Never retroactive inference.
create table public.context_interactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  context_profile_id uuid not null references public.context_profiles (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  session_id uuid references public.interaction_sessions (id) on delete cascade,
  source text not null check (source in ('activated', 'study', 'meeting', 'backfill')),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  check ((conversation_id is null) <> (session_id is null))
);

create unique index context_interactions_conversation_idx
  on public.context_interactions (context_profile_id, conversation_id) where conversation_id is not null;
create unique index context_interactions_session_idx
  on public.context_interactions (context_profile_id, session_id) where session_id is not null;
create index context_interactions_recent_idx
  on public.context_interactions (workspace_id, user_id, context_profile_id, last_at desc);

create or replace function public.check_context_interaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.context_profiles p
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'context must belong to the same workspace';
  end if;
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id
  ) then
    raise exception 'conversation must belong to the same workspace and user';
  end if;
  if new.session_id is not null and not exists (
    select 1 from public.interaction_sessions s
    where s.id = new.session_id and s.workspace_id = new.workspace_id and s.user_id = new.user_id
  ) then
    raise exception 'session must belong to the same workspace and user';
  end if;
  return new;
end;
$$;

create trigger context_interactions_check before insert or update on public.context_interactions
  for each row execute function public.check_context_interaction();

-- ── Study ────────────────────────────────────────────────────────────────────
create table public.study_concepts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  context_profile_id uuid not null references public.context_profiles (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  label_key text not null check (char_length(label_key) between 1 and 120),
  summary text check (char_length(summary) <= 600),
  -- References back to the material: [{itemId, chunkId, title, section}] (bounded).
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  status text not null default 'not_reviewed'
    check (status in ('not_reviewed', 'learning', 'understood', 'needs_review')),
  -- Deterministic mastery score (ADR-016 §13), small on purpose.
  score integer not null default 0 check (score between -3 and 5),
  attempts integer not null default 0 check (attempts >= 0),
  last_assessment text check (last_assessment in ('strong', 'partial', 'needs_review')),
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (context_profile_id, user_id, label_key)
);

create index study_concepts_profile_idx on public.study_concepts (workspace_id, user_id, context_profile_id, status);

create trigger study_concepts_updated_at before update on public.study_concepts
  for each row execute function public.set_updated_at();

create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  context_profile_id uuid not null references public.context_profiles (id) on delete cascade,
  -- The interaction it runs in (a conversation or a voice session).
  conversation_id uuid references public.conversations (id) on delete set null,
  session_id uuid references public.interaction_sessions (id) on delete set null,
  mode text not null check (mode in ('review', 'oral_exam', 'quiz')),
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  -- Resolved before the session starts: {label, spaceIds, itemIds, conceptIds, topics}.
  scope jsonb not null default '{}'::jsonb,
  -- This session only ("don't correct me until the end"): never permanent preferences.
  preferences jsonb not null default '{}'::jsonb,
  -- The question being asked, with its key points and hints: server-side until answered.
  current jsonb,
  question_count integer not null default 0 check (question_count >= 0),
  summary jsonb,
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  check (octet_length(coalesce(current::text, '')) <= 40000)
);

create index study_sessions_recent_idx on public.study_sessions (workspace_id, user_id, context_profile_id, last_activity_at desc);

create table public.study_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  study_session_id uuid not null references public.study_sessions (id) on delete cascade,
  concept_id uuid references public.study_concepts (id) on delete set null,
  concept_label text not null check (char_length(concept_label) between 1 and 120),
  question text not null check (char_length(question) <= 1000),
  answer text not null check (char_length(answer) <= 4000),
  assessment text not null check (assessment in ('strong', 'partial', 'needs_review')),
  -- {correct[], missing[], incorrect[], explanation} — understandable feedback, no scores.
  feedback jsonb not null default '{}'::jsonb,
  hints_used integer not null default 0 check (hints_used between 0 and 3),
  source_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index study_attempts_session_idx on public.study_attempts (study_session_id, created_at);

-- Study rows reference a study profile of the same workspace and their author's interaction.
create or replace function public.check_study_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'study_attempts' then
    if not exists (
      select 1 from public.study_sessions s
      where s.id = new.study_session_id and s.workspace_id = new.workspace_id and s.user_id = new.user_id
    ) then
      raise exception 'attempt must belong to the author''s session';
    end if;
    return new;
  end if;
  if not exists (
    select 1 from public.context_profiles p
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id and p.kind = 'study'
  ) then
    raise exception 'study data must belong to a study context of the same workspace';
  end if;
  return new;
end;
$$;

create trigger study_concepts_check before insert or update on public.study_concepts
  for each row execute function public.check_study_row();
create trigger study_sessions_check before insert or update on public.study_sessions
  for each row execute function public.check_study_row();
create trigger study_attempts_check before insert on public.study_attempts
  for each row execute function public.check_study_row();

-- ── Live Workspace: the interaction's active context ─────────────────────────
alter table public.live_workspaces
  add column context_profile_id uuid references public.context_profiles (id) on delete set null,
  add column context_turn integer not null default 0 check (context_turn >= 0);

create or replace function public.check_live_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id
  ) then
    raise exception 'conversation must belong to the same workspace and user';
  end if;
  if new.session_id is not null and not exists (
    select 1 from public.interaction_sessions s
    where s.id = new.session_id and s.workspace_id = new.workspace_id and s.user_id = new.user_id
      and s.status = 'active'
  ) then
    raise exception 'session must belong to the same workspace and user';
  end if;
  if new.context_profile_id is not null and not exists (
    select 1 from public.context_profiles p
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'context must belong to the same workspace';
  end if;
  return new;
end;
$$;

-- ── Recall: optional context scope ───────────────────────────────────────────
drop function public.search_recall_chunks(
  uuid, uuid, text, extensions.vector, text, timestamptz, timestamptz, uuid, integer
);

create or replace function public.search_recall_chunks(
  p_workspace_id uuid,
  p_user_id uuid,
  p_keywords text,
  p_embedding extensions.vector(1536),
  p_embedding_model text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_exclude_session uuid default null,
  p_limit integer default 16,
  -- Only interactions known to belong to this context (ADR-016 §8).
  p_context uuid default null
)
returns table (
  chunk_id uuid,
  session_id uuid,
  chunk_index integer,
  content text,
  started_at timestamptz,
  ended_at timestamptz,
  source_ids uuid[],
  similarity double precision,
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
    from public.recall_chunks c
    join public.interaction_sessions s on s.id = c.session_id and s.status = 'active'
    where c.workspace_id = p_workspace_id
      and c.user_id = p_user_id
      and (p_from is null or c.ended_at >= p_from)
      and (p_to is null or c.started_at < p_to)
      and (p_exclude_session is null or c.session_id <> p_exclude_session)
      and (p_context is null or exists (
        select 1 from public.context_interactions a
        where a.context_profile_id = p_context and a.user_id = p_user_id
          and (a.session_id = s.id or (s.conversation_id is not null and a.conversation_id = s.conversation_id))
      ))
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
  select c.id, c.session_id, c.chunk_index, c.content, c.started_at, c.ended_at, c.source_ids,
         sem.similarity,
         kw.rnk,
         coalesce(1.0 / (60 + sem.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0)
  from semantic sem
  full outer join keyword kw on kw.id = sem.id
  join scoped c on c.id = coalesce(sem.id, kw.id)
  order by 10 desc
  limit greatest(p_limit, 1);
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.context_profiles enable row level security;
alter table public.context_links enable row level security;
alter table public.entities enable row level security;
alter table public.context_interactions enable row level security;
alter table public.study_concepts enable row level security;
alter table public.study_sessions enable row level security;
alter table public.study_attempts enable row level security;

-- Profiles, links and people are workspace organization data (like native modules).
create policy "Members read context profiles" on public.context_profiles
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add context profiles" on public.context_profiles
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change context profiles" on public.context_profiles
  for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members delete context profiles" on public.context_profiles
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "Members manage context links" on public.context_links
  for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members manage entities" on public.entities
  for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

-- Interaction associations and study progress are private to their author (like Recall).
create policy "Authors manage their context interactions" on public.context_interactions
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors manage their study concepts" on public.study_concepts
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors manage their study sessions" on public.study_sessions
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors manage their study attempts" on public.study_attempts
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
