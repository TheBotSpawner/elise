-- Alarms (ADR-100): a fixed local time, once or on weekdays, in the user's IANA timezone,
-- ringing on the destinations the user chose (a registered browser, an ELISE Desktop). Additive:
-- timers (ADR-045) are untouched. The server decides when an alarm is due (`next_fire_at`, a
-- delayed run keyed by `version`); every firing is an occurrence with per-device receipts, so
-- "sent" is never confused with "it rang".

create table public.alarms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text check (label is null or char_length(btrim(label)) between 1 and 80),
  local_time text not null check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  local_date date,
  weekdays smallint[] not null default '{}'
    check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[] and cardinality(weekdays) <= 7),
  timezone text not null check (char_length(timezone) between 1 and 64),
  enabled boolean not null default true,
  sound text check (sound is null or char_length(sound) <= 60),
  snooze_minutes smallint not null default 9 check (snooze_minutes between 1 and 60),
  destinations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(destinations) = 'array' and jsonb_array_length(destinations) <= 10),
  state text not null default 'scheduled'
    check (state in ('scheduled', 'ringing', 'snoozed', 'done', 'off')),
  next_fire_at timestamptz,
  snoozed_until timestamptz,
  version integer not null default 1 check (version >= 1),
  created_from_conversation_id uuid,
  created_from_session_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A one-off alarm has a date; a repeating one has weekdays. Never both, never neither.
  check ((local_date is null) <> (cardinality(weekdays) = 0))
);

create index alarms_owner_idx on public.alarms (user_id, workspace_id);
create index alarms_due_idx on public.alarms (next_fire_at) where enabled and next_fire_at is not null;

create trigger alarms_updated_at before update on public.alarms
  for each row execute function public.set_updated_at();

create or replace function public.alarms_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id then
    raise exception 'an alarm cannot change owner';
  end if;
  return new;
end;
$$;
create trigger alarms_before_update before update on public.alarms
  for each row execute function public.alarms_before_update();

alter table public.alarms enable row level security;

-- Alarms are personal: only their owner, in a workspace they belong to (never shared).
create policy "Users read their alarms" on public.alarms for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users add their alarms" on public.alarms for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users change their alarms" on public.alarms for update to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users delete their alarms" on public.alarms for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- Each time an alarm fires. One row per alarm and fire time: a second dispatcher (a retried
-- run, a read that settled it first) can't make it ring twice.
create table public.alarm_occurrences (
  id uuid primary key default gen_random_uuid(),
  alarm_id uuid not null references public.alarms (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  fire_at timestamptz not null,
  status text not null check (status in ('ringing', 'snoozed', 'dismissed', 'missed', 'expired')),
  -- When it (last) started ringing: a snooze re-rings from here, the failsafe counts from it.
  ringing_since timestamptz,
  snoozed_until timestamptz,
  rings smallint not null default 0 check (rings between 0 and 100),
  ended_at timestamptz,
  -- What each device reported: received, sound playing, blocked by the browser, stopped.
  receipts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(receipts) = 'object' and octet_length(receipts::text) <= 8000),
  label text,
  sound text,
  destinations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alarm_id, fire_at)
);
create index alarm_occurrences_live_idx on public.alarm_occurrences (user_id, status, ringing_since)
  where status in ('ringing', 'snoozed');
create trigger alarm_occurrences_updated_at before update on public.alarm_occurrences
  for each row execute function public.set_updated_at();

alter table public.alarm_occurrences enable row level security;
create policy "Users read their alarm occurrences" on public.alarm_occurrences for select
  to authenticated using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users change their alarm occurrences" on public.alarm_occurrences for update
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
-- Inserted only by ELISE (the dispatcher), never by a client.
grant select, update on public.alarm_occurrences to authenticated;

-- A browser the user chose to ring alarms in (not every tab: an id the browser keeps). The id is
-- random, not a fingerprint, and not a credential.
create table public.browser_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  endpoint_id uuid not null,
  name text not null default 'Navegador' check (char_length(btrim(name)) between 1 and 80),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, endpoint_id)
);
create trigger browser_endpoints_updated_at before update on public.browser_endpoints
  for each row execute function public.set_updated_at();
alter table public.browser_endpoints enable row level security;
create policy "browser_endpoints_select_own" on public.browser_endpoints for select
  to authenticated using (user_id = (select auth.uid()));
create policy "browser_endpoints_insert_own" on public.browser_endpoints for insert
  to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "browser_endpoints_update_own" on public.browser_endpoints for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
grant select, insert, update on public.browser_endpoints to authenticated;

-- The user's own alarm sounds. The file lives in the private `alarm-sounds` bucket (ELISE reads
-- and writes it on the server; devices get short-lived signed URLs after an ownership check).
create table public.alarm_sounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  storage_path text not null unique check (char_length(storage_path) <= 300),
  mime_type text not null check (mime_type in ('audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4')),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  duration_ms integer check (duration_ms is null or duration_ms between 1 and 120000),
  created_at timestamptz not null default now()
);
create index alarm_sounds_owner_idx on public.alarm_sounds (user_id, workspace_id);
alter table public.alarm_sounds enable row level security;
create policy "Users read their alarm sounds" on public.alarm_sounds for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users add their alarm sounds" on public.alarm_sounds for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users delete their alarm sounds" on public.alarm_sounds for delete to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'alarm-sounds',
  'alarm-sounds',
  false,
  2097152,
  array['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4']
)
on conflict (id) do nothing;

-- One "ringing" notification per occurrence, whoever dispatched it first.
create unique index notifications_alarm_once on public.notifications (source_id, notification_type)
  where source_type = 'alarm_occurrence';

-- Every device follows state changes (an alarm set, ringing, snoozed, stopped).
alter publication supabase_realtime add table public.alarms;
alter publication supabase_realtime add table public.alarm_occurrences;
