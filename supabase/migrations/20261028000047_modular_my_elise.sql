-- Mi ELISE modular (ADR-064): which native modules each person uses. Module metadata lives in
-- code (src/core/modules/registry.ts); this table only stores each user's choice per workspace.
-- Turning a module off never deletes or changes its data. Additive only.

create table if not exists public.user_module_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- A registry key; validated against the registry server-side (the shape is checked here).
  module_key text not null check (module_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, module_key)
);

create index if not exists user_module_preferences_owner_idx
  on public.user_module_preferences (workspace_id, user_id);

drop trigger if exists user_module_preferences_updated_at on public.user_module_preferences;
create trigger user_module_preferences_updated_at before update on public.user_module_preferences
  for each row execute function public.set_updated_at();

alter table public.user_module_preferences enable row level security;

-- Each person reads and changes only their own choices, in a workspace they belong to.
drop policy if exists "Users read their module choices" on public.user_module_preferences;
create policy "Users read their module choices" on public.user_module_preferences
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "Users save their module choices" on public.user_module_preferences;
create policy "Users save their module choices" on public.user_module_preferences
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

drop policy if exists "Users change their module choices" on public.user_module_preferences;
create policy "Users change their module choices" on public.user_module_preferences
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Nobody loses anything with this update: everyone who already uses ELISE keeps the six modules
-- Mi ELISE had. Explicit rows also mark them as existing users, so modules added later follow
-- their own default for existing users. Idempotent: running it again changes nothing.
insert into public.user_module_preferences (workspace_id, user_id, module_key, enabled)
select m.workspace_id, m.user_id, k.module_key, true
from public.workspace_members m
cross join (values ('tasks'), ('habits'), ('lists'), ('goals'), ('notes'), ('finance')) as k (module_key)
where m.status = 'active'
on conflict (workspace_id, user_id, module_key) do nothing;
