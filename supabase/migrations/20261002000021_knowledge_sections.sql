-- Knowledge Sections (ADR-018): a first-level child of a Knowledge Space is a Section, and a
-- Section carries its contextual intelligence through a 1:1 Context Profile. Spaces keep their
-- existing hierarchy (parent_space_id); profiles keep their links, study progress, people and
-- interaction associations. Nothing is copied or deleted.

alter table public.context_profiles
  add column knowledge_space_id uuid references public.knowledge_spaces (id) on delete set null;

-- One profile per Section.
create unique index context_profiles_section_idx on public.context_profiles (knowledge_space_id)
  where knowledge_space_id is not null;

-- Names stay unique among standalone profiles; a Section's identity includes its parent Space
-- ("UTN › Administración" and "Posgrado › Administración" can coexist).
drop index public.context_profiles_name_idx;
create unique index context_profiles_name_idx on public.context_profiles (workspace_id, name_key)
  where status = 'active' and knowledge_space_id is null;

-- A profile can only belong to a Section of its own workspace.
create or replace function public.check_context_profile_section()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.knowledge_space_id is not null and not exists (
    select 1 from public.knowledge_spaces s
    where s.id = new.knowledge_space_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'invalid section for context profile';
  end if;
  return new;
end;
$$;

create trigger context_profiles_section before insert or update of knowledge_space_id, workspace_id
  on public.context_profiles for each row execute function public.check_context_profile_section();

-- Transitional mapping: a standalone profile whose only confirmed Knowledge Space link points at
-- a Section with the same name becomes that Section's profile. Anything less certain stays a
-- standalone profile (still resolved by name, still working) — never guessed.
with candidates as (
  select p.id as profile_id, min(l.resource_id::text)::uuid as space_id
  from public.context_profiles p
  join public.context_links l
    on l.context_profile_id = p.id and l.link_type = 'knowledge_space' and l.confirmed
  join public.knowledge_spaces s
    on s.id = l.resource_id::uuid and s.workspace_id = p.workspace_id
  where p.knowledge_space_id is null
    and s.parent_space_id is not null
    and s.status = 'active'
    and lower(s.name) = p.name_key
  group by p.id
  having count(*) = 1
),
unique_spaces as (
  select space_id from candidates group by space_id having count(*) = 1
)
update public.context_profiles p
set knowledge_space_id = c.space_id
from candidates c
where p.id = c.profile_id
  and c.space_id in (select space_id from unique_spaces);
