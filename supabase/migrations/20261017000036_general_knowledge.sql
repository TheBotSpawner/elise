-- ADR-047: General Knowledge. Every workspace has exactly one system Knowledge Space for
-- cross-domain context, sources and Methods. Its identity is `kind`, never its name: an existing
-- user Space called "General" or "General Knowledge" stays an ordinary Space.

alter table public.knowledge_spaces
  add column kind text not null default 'standard' check (kind in ('standard', 'general'));

-- Exactly one per workspace (archived or not: it can't be archived anyway).
create unique index knowledge_spaces_one_general on public.knowledge_spaces (workspace_id)
  where kind = 'general';

-- Its invariants hold for every writer (UI, chat tools, service role): it is top-level, always
-- active, keeps its name, and no Space becomes (or stops being) General.
create or replace function public.protect_general_knowledge()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.kind = 'general' and new.parent_space_id is not null then
      raise exception 'general_knowledge_protected: General Knowledge is a top-level Space';
    end if;
    return new;
  end if;
  if new.kind is distinct from old.kind then
    raise exception 'general_knowledge_protected: a Space cannot become or stop being General Knowledge';
  end if;
  if old.kind = 'general' then
    if new.name is distinct from old.name then
      raise exception 'general_knowledge_protected: General Knowledge cannot be renamed';
    end if;
    if new.status <> 'active' or new.archived_at is not null then
      raise exception 'general_knowledge_protected: General Knowledge cannot be archived or deleted';
    end if;
    if new.parent_space_id is not null then
      raise exception 'general_knowledge_protected: General Knowledge cannot be moved';
    end if;
  end if;
  return new;
end;
$$;

create trigger knowledge_spaces_general_protected
  before insert or update on public.knowledge_spaces
  for each row execute function public.protect_general_knowledge();

-- New workspaces get theirs at creation (like their ELISE connections).
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
    'General Knowledge',
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

create trigger workspaces_general_knowledge
  after insert on public.workspaces
  for each row execute function public.create_general_knowledge_space();

-- General Knowledge's Methods are the workspace-wide ones (ADR-040 "global", space_id null):
-- globally eligible, least specific. A Method saved "in General Knowledge" by any writer is
-- stored that way. Runs before methods_before_write (trigger names fire alphabetically).
create or replace function public.methods_general_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.space_id is not null and exists (
    select 1 from public.knowledge_spaces s where s.id = new.space_id and s.kind = 'general'
  ) then
    new.space_id := null;
  end if;
  return new;
end;
$$;

create trigger methods_aa_general_scope
  before insert or update of space_id on public.methods
  for each row execute function public.methods_general_scope();

-- Existing workspaces: one each, idempotently (re-running adds nothing).
insert into public.knowledge_spaces (workspace_id, name, description, kind, icon, color, created_by_user_id)
select w.id,
       'General Knowledge',
       'Contexto y formas de trabajar que ELISE usa en todos tus espacios.',
       'general',
       'sparkles',
       'cyan',
       w.owner_user_id
from public.workspaces w
where not exists (
  select 1 from public.knowledge_spaces s where s.workspace_id = w.id and s.kind = 'general'
);
