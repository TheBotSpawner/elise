-- Methods (ADR-040): procedural memory — how the user wants a recurring kind of work done.
-- Internally the "skills" domain. A Method is text the user owns; it never grants anything.
-- Scope is where it lives: no space = the whole workspace (global), a top-level Space, or a
-- Section (a Space with a parent). Every content change is a numbered version (trigger), so
-- ELISE's edits are reversible and carry their provenance.

insert into public.capability_definitions (key, display_name, status) values
  ('methods', 'Methods', 'available')
on conflict (key) do update set status = 'available';

-- ── Methods ──────────────────────────────────────────────────────────────────
create table public.methods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- null = global; otherwise the Space or Section it belongs to.
  space_id uuid references public.knowledge_spaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- One line for the lightweight index (progressive disclosure): what it's for.
  description text not null check (char_length(btrim(description)) between 1 and 300),
  -- The procedure itself, as readable text (markdown). Never code.
  instructions text not null check (char_length(btrim(instructions)) between 1 and 12000),
  -- Activation hints: words that point to it ("propuesta", "proposal").
  hints text[] not null default '{}' check (cardinality(hints) <= 12),
  -- Where it can run: a desktop-only Method waits for the Desktop Companion.
  platforms text[] not null default '{web}' check (
    cardinality(platforms) between 1 and 3 and platforms <@ array['web', 'desktop', 'mobile']
  ),
  status text not null default 'active' check (status in ('active', 'archived')),
  version integer not null default 1 check (version >= 1),
  -- Provenance of the current version (copied into method_versions by the trigger).
  change_summary text not null default 'Created' check (char_length(change_summary) <= 200),
  change_source text not null default 'user_ui' check (
    change_source in ('user_ui', 'ai_explicit', 'ai_correction', 'ai_suggestion', 'import', 'restore')
  ),
  change_ref jsonb not null default '{}' check (octet_length(change_ref::text) <= 2000),
  created_by_user_id uuid references auth.users (id) on delete set null,
  updated_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index methods_index_idx on public.methods (workspace_id, space_id) where status = 'active';

create trigger methods_updated_at before update on public.methods
  for each row execute function public.set_updated_at();

-- A Method's Space must be in its workspace; content changes bump the version.
create or replace function public.methods_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.space_id is not null and not exists (
    select 1 from public.knowledge_spaces s
    where s.id = new.space_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'method space must belong to the same workspace';
  end if;
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id or new.id <> old.id then
      raise exception 'a method cannot change workspace';
    end if;
    -- Versions are counted here only: a client can't skip or rewrite one.
    new.version := old.version;
    if (new.name, new.description, new.instructions, new.hints, new.platforms, new.space_id)
       is distinct from
       (old.name, old.description, old.instructions, old.hints, old.platforms, old.space_id) then
      new.version := old.version + 1;
      if new.change_summary is not distinct from old.change_summary
         and new.change_source is not distinct from old.change_source then
        new.change_summary := 'Edited';
      end if;
    end if;
    new.archived_at := case when new.status = 'archived' then coalesce(old.archived_at, now()) end;
  else
    new.version := 1;
  end if;
  return new;
end;
$$;

create trigger methods_before_write before insert or update on public.methods
  for each row execute function public.methods_before_write();

-- ── Versions: an append-only history written only by the trigger ────────────
create table public.method_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  method_id uuid not null references public.methods (id) on delete cascade,
  version integer not null,
  name text not null,
  description text not null,
  instructions text not null,
  hints text[] not null,
  platforms text[] not null,
  space_id uuid,
  change_summary text not null,
  change_source text not null,
  change_ref jsonb not null,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (method_id, version)
);

create or replace function public.methods_record_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.version <> old.version then
    insert into public.method_versions (
      workspace_id, method_id, version, name, description, instructions, hints, platforms,
      space_id, change_summary, change_source, change_ref, created_by_user_id
    ) values (
      new.workspace_id, new.id, new.version, new.name, new.description, new.instructions,
      new.hints, new.platforms, new.space_id, new.change_summary, new.change_source,
      new.change_ref, coalesce(new.updated_by_user_id, new.created_by_user_id)
    );
  end if;
  return null;
end;
$$;

create trigger methods_record_version after insert or update on public.methods
  for each row execute function public.methods_record_version();

-- ── References, examples and templates (supporting material, never code) ────
create table public.method_references (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  method_id uuid not null references public.methods (id) on delete cascade,
  kind text not null check (kind in ('reference', 'example', 'template')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- The text ELISE reads (extracted once). A Knowledge document is read live instead.
  content text check (content is null or char_length(content) <= 40000),
  mime_type text,
  -- Provenance: where it came from.
  source_type text not null check (source_type in ('chat_attachment', 'knowledge_item', 'text')),
  attachment_id uuid references public.chat_attachments (id) on delete set null,
  knowledge_item_id uuid references public.knowledge_items (id) on delete cascade,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (source_type <> 'knowledge_item' or knowledge_item_id is not null),
  check (source_type = 'knowledge_item' or content is not null)
);

create index method_references_method_idx on public.method_references (method_id);

create or replace function public.check_method_reference()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.methods m where m.id = new.method_id and m.workspace_id = new.workspace_id
  ) then
    raise exception 'reference must belong to a method of the same workspace';
  end if;
  if new.knowledge_item_id is not null and not exists (
    select 1 from public.knowledge_items i
    where i.id = new.knowledge_item_id and i.workspace_id = new.workspace_id
  ) then
    raise exception 'document must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger method_references_check before insert or update on public.method_references
  for each row execute function public.check_method_reference();

-- ── Uses: which Method a run followed (debugging, never shown by default) ───
create table public.method_uses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  method_id uuid not null references public.methods (id) on delete cascade,
  method_version integer not null,
  scope text not null check (scope in ('global', 'space', 'section')),
  origin text not null check (origin in ('chat', 'voice', 'schedule')),
  -- How it was chosen: 'matched' (clear match), 'model' (loaded from the index), 'schedule'.
  reason text not null check (char_length(reason) <= 300),
  ai_run_id uuid references public.ai_runs (id) on delete set null,
  schedule_id uuid references public.schedules (id) on delete set null,
  tools text[] not null default '{}',
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create index method_uses_method_idx on public.method_uses (method_id, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Methods are shared by the workspace, like its Knowledge. Versions are append-only (trigger).
alter table public.methods enable row level security;
alter table public.method_versions enable row level security;
alter table public.method_references enable row level security;
alter table public.method_uses enable row level security;

create policy "Members read methods" on public.methods
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members create methods" on public.methods
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by_user_id = auth.uid());
create policy "Members change methods" on public.methods
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members read method versions" on public.method_versions
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "Members read method references" on public.method_references
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add method references" on public.method_references
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by_user_id = auth.uid());
create policy "Members remove method references" on public.method_references
  for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy "Authors read their method uses" on public.method_uses
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Authors record their method uses" on public.method_uses
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Archive instead of delete; history is never edited by API users.
revoke delete on public.methods from anon, authenticated;
revoke insert, update, delete on public.method_versions from anon, authenticated;
revoke update on public.method_references, public.method_uses from anon, authenticated;
revoke all on public.methods, public.method_versions, public.method_references,
  public.method_uses from anon;
