-- ADR-046: connected is not mirrored. Drive and Notion sources are read live from the provider
-- when a question needs them; ELISE keeps only a metadata catalog of what they contain.
-- Uploads and notes are ELISE's own copy and stay fully indexed.

-- The source mode, derived from what the source is: it can never drift from its type.
-- (An "imported copy" of an external document is an upload, so it is native_indexed.)
alter table public.knowledge_sources
  add column access_mode text generated always as (
    case when source_type in ('upload', 'note') then 'native_indexed' else 'external_live' end
  ) stored;

-- Retrieval reads only ELISE-managed content. Chunks that were ingested from Drive/Notion
-- before ADR-046 are legacy copies: they stay in place (citations and history keep resolving)
-- but are never searched again, so a stale copy can't be cited as if it were the source.
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

-- Items of a live source are catalog entries (what exists, where, when it changed). Per-page
-- ingestion problems no longer mean anything: health is the source's own.
update public.knowledge_items i
set status = 'ready', status_detail = null, error_code = null
from public.knowledge_sources s
where s.id = i.source_id
  and s.access_mode = 'external_live'
  and i.status in ('queued', 'processing', 'needs_attention', 'failed');

-- Ingestion that was still waiting for a live source's page will never run.
update public.knowledge_versions v
set status = 'superseded'
from public.knowledge_items i
join public.knowledge_sources s on s.id = i.source_id
where v.knowledge_item_id = i.id
  and s.access_mode = 'external_live'
  and v.status in ('pending', 'processing');
