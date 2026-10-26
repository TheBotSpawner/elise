-- Document descriptions and title-aware Knowledge search (ADR-122).
--
-- The user can say what a document is ("las 100 preguntas exactas del EPI", "cronograma de
-- clases, dice qué días son virtuales"). Search then finds a document by its name or
-- description even when its passages never repeat those words ("el cronograma").

alter table public.knowledge_items
  add column if not exists description text
    check (description is null or char_length(description) <= 1000);

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
  ),
  -- Documents whose name or description shares the question's key terms.
  titled_items as (
    select i.id,
           ts_rank_cd(
             to_tsvector('simple'::regconfig, i.title || ' ' || coalesce(i.description, '')), q
           ) as rank
    from public.knowledge_items i, to_tsquery('simple'::regconfig, p_keywords) q
    where coalesce(p_keywords, '') <> ''
      and i.workspace_id = p_workspace_id
      and i.id in (select s.knowledge_item_id from scoped s)
      and to_tsvector('simple'::regconfig, i.title || ' ' || coalesce(i.description, '')) @@ q
  ),
  -- Their passages closest to the question (or the opening ones without embeddings).
  titled as (
    select s.id,
           row_number() over (
             order by t.rank desc,
                      case when p_embedding is not null and s.embedding_model = p_embedding_model
                           then s.embedding operator(extensions.<=>) p_embedding end nulls last,
                      s.chunk_index
           ) as rnk
    from scoped s
    join titled_items t on t.id = s.knowledge_item_id
    order by 2
    limit greatest(p_limit, 1)
  ),
  candidates as (
    select id from semantic union select id from keyword union select id from titled
  )
  select c.id, c.knowledge_item_id, c.version_id, c.space_id, c.chunk_index, c.content,
         c.heading_path, c.page_number,
         sem.similarity,
         sem.rnk,
         -- A named/described document counts as a keyword match: it is evidence.
         coalesce(kw.rnk, ti.rnk),
         coalesce(1.0 / (60 + sem.rnk), 0) + coalesce(1.0 / (60 + kw.rnk), 0)
           + coalesce(1.0 / (60 + ti.rnk), 0)
  from candidates x
  join scoped c on c.id = x.id
  left join semantic sem on sem.id = x.id
  left join keyword kw on kw.id = x.id
  left join titled ti on ti.id = x.id
  order by 12 desc
  limit greatest(p_limit, 1);
$$;
