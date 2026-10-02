-- History organized by Knowledge (ADR-020): conversations and voice sessions linked to the
-- Spaces and Sections they are about. Sections no longer need a purpose for Study.
-- Additive: one new table, two replaced functions, a backfill from existing evidence.

-- ── 1. Links ─────────────────────────────────────────────────────────────────
-- The History thread is the canonical side (the same ThreadRef the app uses everywhere):
-- a conversation for typed chats, an interaction session for voice. The other side is a
-- knowledge_spaces row — a Space or a Section (a Section is a child Space), so renames show
-- everywhere and nothing stores names.
create table if not exists public.interaction_knowledge_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  session_id uuid references public.interaction_sessions (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  -- Who decided: ELISE from evidence, or the user. A manual removal stays as a tombstone
  -- (state = 'removed') so automatic tagging does not put it back.
  source text not null check (source in ('automatic', 'manual')),
  state text not null default 'linked' check (state in ('linked', 'removed')),
  -- Why ELISE linked it (active_context, study, meeting, knowledge, space_scope, backfill…).
  evidence text[] not null default '{}',
  confidence real check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((conversation_id is null) <> (session_id is null))
);

create unique index if not exists interaction_knowledge_links_conversation_idx
  on public.interaction_knowledge_links (conversation_id, space_id) where conversation_id is not null;
create unique index if not exists interaction_knowledge_links_session_idx
  on public.interaction_knowledge_links (session_id, space_id) where session_id is not null;
create index if not exists interaction_knowledge_links_space_idx
  on public.interaction_knowledge_links (workspace_id, user_id, space_id) where state = 'linked';

drop trigger if exists interaction_knowledge_links_updated_at on public.interaction_knowledge_links;
create trigger interaction_knowledge_links_updated_at before update on public.interaction_knowledge_links
  for each row execute function public.set_updated_at();

-- Never across workspaces or authors: the thread is the user's own, the Space is in the same
-- workspace. A link organizes data the user can already read; it grants nothing.
create or replace function public.check_interaction_knowledge_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.knowledge_spaces k
    where k.id = new.space_id and k.workspace_id = new.workspace_id
  ) then
    raise exception 'space must belong to the same workspace';
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

drop trigger if exists interaction_knowledge_links_check on public.interaction_knowledge_links;
create trigger interaction_knowledge_links_check
  before insert or update on public.interaction_knowledge_links
  for each row execute function public.check_interaction_knowledge_link();

alter table public.interaction_knowledge_links enable row level security;

drop policy if exists "Authors manage their history links" on public.interaction_knowledge_links;
create policy "Authors manage their history links" on public.interaction_knowledge_links
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

revoke all on public.interaction_knowledge_links from anon;

-- ── 2. Study on any Section ──────────────────────────────────────────────────
-- Sections are untyped: studying is an intent, not a context kind. Study data still has to
-- belong to a context of the same workspace.
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
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'study data must belong to a context of the same workspace';
  end if;
  return new;
end;
$$;

-- ── 3. Recall scoped by Space / Section ──────────────────────────────────────
drop function if exists public.search_recall_chunks(
  uuid, uuid, text, extensions.vector, text, timestamptz, timestamptz, uuid, integer, uuid
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
  p_context uuid default null,
  -- Only interactions linked to one of these Spaces/Sections (ADR-020). Scopes, never widens.
  p_spaces uuid[] default null
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
      and (p_spaces is null or exists (
        select 1 from public.interaction_knowledge_links l
        where l.user_id = p_user_id and l.state = 'linked' and l.space_id = any(p_spaces)
          and (l.session_id = s.id or (s.conversation_id is not null and l.conversation_id = s.conversation_id))
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

-- ── 4. Backfill (idempotent) ─────────────────────────────────────────────────
-- Only high-confidence evidence that already exists: a Section's context was activated,
-- studied or prepared for in that interaction. Everything else stays untagged.
insert into public.interaction_knowledge_links
  (workspace_id, user_id, conversation_id, session_id, space_id, source, evidence, confidence)
select a.workspace_id, a.user_id, a.conversation_id, a.session_id, p.knowledge_space_id,
       'automatic', array['backfill', a.source], 0.9
from public.context_interactions a
join public.context_profiles p on p.id = a.context_profile_id and p.knowledge_space_id is not null
on conflict do nothing;
