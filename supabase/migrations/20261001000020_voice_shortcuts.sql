-- Continuous voice, wake phrase and ELISE Shortcuts (ADR-017). Additive.

insert into public.capability_definitions (key, display_name, status) values
  ('shortcuts', 'Shortcuts', 'available')
on conflict (key) do update set status = 'available';

-- ── Voice preferences (allowlisted, like the others) ─────────────────────────
alter table public.user_profiles
  -- After ELISE answers, keep listening (off: one turn at a time).
  add column voice_continuous boolean not null default true,
  -- Speaking over ELISE interrupts her (off: only the stop control does).
  add column voice_barge_in boolean not null default true,
  -- A sleeping session wakes on the wake phrase (only where detection runs on the device).
  add column voice_wake_enabled boolean not null default false,
  add column voice_wake_phrase text not null default 'elise'
    check (voice_wake_phrase in ('elise', 'hey_elise', 'oye_elise', 'liz'));

-- ── Shortcuts: typed triggers for existing workflows ─────────────────────────
create table public.shortcuts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 300),
  enabled boolean not null default true,
  -- What the user says, as typed, and its normalized form (for matching and uniqueness).
  trigger_phrases text[] not null check (cardinality(trigger_phrases) between 1 and 5),
  phrase_keys text[] not null check (cardinality(phrase_keys) = cardinality(trigger_phrases)),
  language text check (language in ('es', 'en')),
  -- 1–4 allowlisted steps ({type, config}); validated by the application's registry, and
  -- here only as a shape: never code, URLs or prompts with authority.
  steps jsonb not null check (
    jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 4
    and octet_length(steps::text) <= 4000
  ),
  context_profile_id uuid references public.context_profiles (id) on delete set null,
  requires_confirmation boolean not null default false,
  last_run_at timestamptz,
  run_count integer not null default 0 check (run_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shortcuts_owner_idx on public.shortcuts (workspace_id, user_id) where enabled;

create trigger shortcuts_updated_at before update on public.shortcuts
  for each row execute function public.set_updated_at();

create or replace function public.check_shortcut()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  step jsonb;
begin
  for step in select * from jsonb_array_elements(new.steps) loop
    if jsonb_typeof(step) <> 'object' or jsonb_typeof(step -> 'type') <> 'string'
       or (step ->> 'type') !~ '^[a-z_]+\.[a-z_]+$' then
      raise exception 'invalid shortcut step';
    end if;
  end loop;
  if new.context_profile_id is not null and not exists (
    select 1 from public.context_profiles p
    where p.id = new.context_profile_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'context must belong to the same workspace';
  end if;
  -- One enabled shortcut per phrase and user: a phrase never means two things.
  if new.enabled and exists (
    select 1 from public.shortcuts s
    where s.workspace_id = new.workspace_id and s.user_id = new.user_id and s.id <> new.id
      and s.enabled and s.phrase_keys && new.phrase_keys
  ) then
    raise exception 'another shortcut already uses that phrase';
  end if;
  return new;
end;
$$;

create trigger shortcuts_check before insert or update on public.shortcuts
  for each row execute function public.check_shortcut();

alter table public.shortcuts enable row level security;

create policy "Authors manage their shortcuts" on public.shortcuts
  for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
