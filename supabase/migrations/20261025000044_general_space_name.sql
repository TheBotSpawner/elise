-- The system Space is called "General" (was "General Knowledge"). Its identity stays `kind`
-- (ADR-047): only the default name changes, and users still can't rename it.

-- The guard refuses renaming the general Space; it is suspended for this one update only.
alter table public.knowledge_spaces disable trigger knowledge_spaces_general_protected;
update public.knowledge_spaces
set name = 'General'
where kind = 'general' and name = 'General Knowledge';
alter table public.knowledge_spaces enable trigger knowledge_spaces_general_protected;

-- New workspaces get theirs with the new name.
create or replace function public.create_general_knowledge_space()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.knowledge_spaces (workspace_id, name, description, kind, icon, color, created_by_user_id)
  values (
    new.id,
    'General',
    'Contexto y formas de trabajar que ELISE usa en todos tus espacios.',
    'general',
    'sparkles',
    'cyan',
    new.owner_user_id
  )
  on conflict do nothing;
  return new;
end;
$$;
