-- ADR-056 Notes v2: one note in many Knowledge Spaces, indexed once.
-- Additive and reversible: notes.space_id stays (it mirrors the note's first Space), so code
-- that predates this migration keeps working. Note content (Markdown) needs no change.

-- ── Note ↔ Space membership (the user's choice; canonical) ──────────────────────
create table public.note_knowledge_spaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (note_id, space_id)
);

create index note_knowledge_spaces_space_idx on public.note_knowledge_spaces (workspace_id, space_id);

-- ── Knowledge item ↔ Space membership (retrieval scope) ─────────────────────────
-- A note in three Spaces is ONE knowledge item with ONE set of chunks (in its first Space);
-- this table says which other Spaces may retrieve it. Nothing is copied or re-embedded.
create table public.knowledge_item_spaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  knowledge_item_id uuid not null references public.knowledge_items (id) on delete cascade,
  space_id uuid not null references public.knowledge_spaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (knowledge_item_id, space_id)
);

create index knowledge_item_spaces_space_idx on public.knowledge_item_spaces (workspace_id, space_id);

-- Both sides of a membership must belong to the row's workspace.
create or replace function public.check_space_membership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.knowledge_spaces s where s.id = new.space_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'space must belong to the same workspace';
  end if;
  if tg_table_name = 'note_knowledge_spaces' then
    if not exists (select 1 from public.notes n where n.id = new.note_id and n.workspace_id = new.workspace_id) then
      raise exception 'note must belong to the same workspace';
    end if;
  elsif not exists (
    select 1 from public.knowledge_items i where i.id = new.knowledge_item_id and i.workspace_id = new.workspace_id
  ) then
    raise exception 'knowledge item must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger note_knowledge_spaces_check before insert or update on public.note_knowledge_spaces
  for each row execute function public.check_space_membership();
create trigger knowledge_item_spaces_check before insert or update on public.knowledge_item_spaces
  for each row execute function public.check_space_membership();

alter table public.note_knowledge_spaces enable row level security;
alter table public.knowledge_item_spaces enable row level security;

create policy "Members manage note spaces" on public.note_knowledge_spaces for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
-- Like knowledge_items: members read; ELISE's indexing writes (service role).
create policy "Members read item spaces" on public.knowledge_item_spaces for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke insert, update, delete on public.knowledge_item_spaces from anon, authenticated;
revoke all on public.note_knowledge_spaces, public.knowledge_item_spaces from anon;

-- ── Backfill: every note keeps its one Space, every note item its Space ─────────
insert into public.note_knowledge_spaces (workspace_id, note_id, space_id)
select n.workspace_id, n.id, n.space_id
from public.notes n
where n.space_id is not null
on conflict (note_id, space_id) do nothing;

insert into public.knowledge_item_spaces (workspace_id, knowledge_item_id, space_id)
select i.workspace_id, i.id, i.space_id
from public.knowledge_items i
join public.knowledge_sources s on s.id = i.source_id
where s.source_type = 'note' and i.archived_at is null
on conflict (knowledge_item_id, space_id) do nothing;

-- ── Retrieval: a chunk is in scope through its own Space OR an item membership ──
-- Each chunk exists once, so a note in several Spaces in scope is returned once.
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
    join public.knowledge_sources src
      on src.id = c.source_id and src.access_mode = 'native_indexed'
    where c.workspace_id = p_workspace_id
      and i.workspace_id = p_workspace_id
      and i.status = 'ready'
      and i.archived_at is null
      and (
        p_space_ids is null
        or c.space_id = any (p_space_ids)
        or exists (
          select 1 from public.knowledge_item_spaces m
          where m.knowledge_item_id = c.knowledge_item_id and m.space_id = any (p_space_ids)
        )
      )
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

alter publication supabase_realtime add table public.note_knowledge_spaces;
