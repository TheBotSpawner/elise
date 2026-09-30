-- Universal Recall + ELISE Self-Control (ADR-012).
--
-- Recall indexes the user's past interactions with ELISE — separate from Knowledge (external
-- documents) and from Memory (learned facts). An interaction session is the unit: a text
-- conversation today (its messages stay in `messages`, never duplicated), a voice or live
-- session later (its turns in `interaction_turns`, with no History thread). Recall chunks are
-- excerpts of consecutive turns with an embedding + full-text vector, private to their author.

insert into public.capability_definitions (key, display_name, status) values
  ('history', 'Recall', 'available'),
  ('settings', 'ELISE Settings', 'available')
on conflict (key) do update set status = 'available';

-- ── Interaction sessions ─────────────────────────────────────────────────────
create table public.interaction_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  modality text not null default 'text' check (modality in ('text', 'voice', 'proactive', 'live')),
  -- Text sessions are conversations (1:1); voice/live sessions have no History thread.
  conversation_id uuid unique references public.conversations (id) on delete cascade,
  title text check (char_length(title) <= 200),
  summary text check (char_length(summary) <= 2000),
  topics text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'archived')),
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  -- What the index covers: the newest turn included, and how many turns the summary saw.
  indexed_through timestamptz,
  summarized_turns integer not null default 0,
  index_version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index interaction_sessions_recent_idx
  on public.interaction_sessions (workspace_id, user_id, last_activity_at desc) where status = 'active';

-- Turns of sessions that aren't chat threads (voice, live). Text turns stay in `messages`.
create table public.interaction_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  session_id uuid not null references public.interaction_sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'surface')),
  modality text not null default 'voice' check (modality in ('text', 'voice')),
  content text not null check (char_length(content) <= 32000),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index interaction_turns_session_idx on public.interaction_turns (session_id, occurred_at);

-- ── Recall index ─────────────────────────────────────────────────────────────
create table public.recall_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references public.interaction_sessions (id) on delete cascade,
  chunk_index integer not null,
  -- The message/turn ids this excerpt covers (provenance for "view interaction").
  source_ids uuid[] not null default '{}',
  started_at timestamptz not null,
  ended_at timestamptz not null,
  modality text not null default 'text',
  content text not null,
  content_hash text not null,
  topics text[] not null default '{}',
  embedding extensions.vector(1536),
  embedding_model text,
  fts tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  created_at timestamptz not null default now(),
  unique (session_id, chunk_index)
);

create index recall_chunks_scope_idx on public.recall_chunks (workspace_id, user_id, started_at desc);
create index recall_chunks_fts_idx on public.recall_chunks using gin (fts);
create index recall_chunks_embedding_idx on public.recall_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create trigger interaction_sessions_updated_at before update on public.interaction_sessions
  for each row execute function public.set_updated_at();

-- Same-workspace, same-user guard for sessions tied to a conversation.
create or replace function public.check_interaction_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id
  ) then
    raise exception 'conversation must belong to the same workspace and user';
  end if;
  return new;
end;
$$;

create trigger interaction_sessions_check before insert or update on public.interaction_sessions
  for each row execute function public.check_interaction_session();

-- Archiving (deleting) a conversation removes it from Recall at once: no orphan excerpts.
create or replace function public.forget_archived_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    delete from public.recall_chunks
      where session_id in (select s.id from public.interaction_sessions s where s.conversation_id = new.id);
    update public.interaction_sessions
      set status = 'archived', summary = null, topics = '{}', indexed_through = null
      where conversation_id = new.id;
  end if;
  return new;
end;
$$;

create trigger conversations_forget_on_archive after update of archived_at on public.conversations
  for each row execute function public.forget_archived_conversation();

-- ── Hybrid recall search (semantic + full-text, RRF), private to the caller ──
create or replace function public.search_recall_chunks(
  p_workspace_id uuid,
  p_user_id uuid,
  p_keywords text,
  p_embedding extensions.vector(1536),
  p_embedding_model text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_exclude_session uuid default null,
  p_limit integer default 16
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

-- ── RLS: Recall is private to its author (like conversations) ───────────────
alter table public.interaction_sessions enable row level security;
alter table public.interaction_turns enable row level security;
alter table public.recall_chunks enable row level security;

create policy "Authors read their interaction sessions" on public.interaction_sessions
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Authors read their interaction turns" on public.interaction_turns
  for select to authenticated using (
    public.is_workspace_member(workspace_id)
    and exists (select 1 from public.interaction_sessions s where s.id = session_id and s.user_id = auth.uid())
  );
create policy "Authors read their recall index" on public.recall_chunks
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Only ELISE's server (service role) writes the index.
revoke insert, update, delete on public.interaction_sessions, public.interaction_turns, public.recall_chunks
  from anon, authenticated;
revoke all on public.interaction_sessions, public.interaction_turns, public.recall_chunks from anon;

-- ── Self-control: appearance persisted on the profile (not just a browser cookie) ──
alter table public.user_profiles
  add column theme text not null default 'system' check (theme in ('system', 'dark', 'light')),
  add column accent text not null default 'cyan' check (accent in ('cyan', 'blue', 'violet', 'green', 'amber'));
