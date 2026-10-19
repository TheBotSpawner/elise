-- ADR-088: tags for Notes. A workspace's own named, colored labels; a note can carry several.
-- Colors are a fixed palette (theme-aware on screen), never arbitrary values. Deleting a tag
-- only removes the label: every note stays.

create table public.note_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  color text not null default 'gray'
    check (color in ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index note_tags_name_idx on public.note_tags (workspace_id, lower(btrim(name)));

create table public.note_tag_links (
  note_id uuid not null references public.notes (id) on delete cascade,
  tag_id uuid not null references public.note_tags (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (note_id, tag_id)
);

create index note_tag_links_tag_idx on public.note_tag_links (workspace_id, tag_id);

create trigger note_tags_updated_at before update on public.note_tags
  for each row execute function public.set_updated_at();

-- Both ends of a link belong to the link's workspace.
create or replace function public.check_note_tag_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.notes n where n.id = new.note_id and n.workspace_id = new.workspace_id
  ) or not exists (
    select 1 from public.note_tags t where t.id = new.tag_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'note and tag must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger note_tag_links_check before insert or update on public.note_tag_links
  for each row execute function public.check_note_tag_link();

alter table public.note_tags enable row level security;
alter table public.note_tag_links enable row level security;

create policy "Members manage note tags" on public.note_tags for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members manage note tag links" on public.note_tag_links for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
revoke all on public.note_tags, public.note_tag_links from anon;

alter publication supabase_realtime add table public.note_tags, public.note_tag_links;
