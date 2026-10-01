-- Web Search + Research (ADR-015). The public web is server-provided (no user connection);
-- usage is counted per workspace per day for cost control. Nothing here stores page content:
-- web evidence lives in the interaction (and Recall), and in Knowledge only when saved.

update public.capability_definitions set status = 'available' where key = 'web_search';

create table public.web_usage (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  searches integer not null default 0 check (searches >= 0),
  fetches integer not null default 0 check (fetches >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, day)
);

alter table public.web_usage enable row level security;

create policy "Members read their workspace's web usage" on public.web_usage
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke insert, update, delete on public.web_usage from authenticated;
revoke all on public.web_usage from anon;

-- Atomic increment; returns today's totals (the server enforces the limits).
create or replace function public.record_web_usage(p_workspace_id uuid, p_searches integer, p_fetches integer)
returns table (searches integer, fetches integer)
language sql
security invoker
set search_path = ''
as $$
  insert into public.web_usage as u (workspace_id, day, searches, fetches)
  values (p_workspace_id, (now() at time zone 'utc')::date, greatest(p_searches, 0), greatest(p_fetches, 0))
  on conflict (workspace_id, day) do update
    set searches = u.searches + excluded.searches,
        fetches = u.fetches + excluded.fetches,
        updated_at = now()
  returning u.searches, u.fetches;
$$;

revoke execute on function public.record_web_usage(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.record_web_usage(uuid, integer, integer) to service_role;
