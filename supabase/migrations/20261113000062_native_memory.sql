-- Native continuous memory (ADR-107). Memory facts move from one JSON array per person
-- (user_preferences "memory.facts", ADR-068) to rows, so that each fact can carry provenance,
-- certainty and evidence, writes are race-safe, and forgetting can reach every derived copy.
--
-- Additive: new tables, one column on interaction_sessions, two functions. The JSON facts are
-- copied with honest provenance and then removed from user_preferences, so nothing forgotten
-- later survives in an old copy. Everything stays private to its author (RLS).

-- ── Facts ────────────────────────────────────────────────────────────────────
create table public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 60),
  value text not null check (char_length(value) between 1 and 300),
  category text not null default 'fact' check (category in (
    'preference', 'fact', 'project', 'relationship', 'routine', 'goal', 'constraint', 'decision'
  )),
  -- Who it comes from. 'unknown' only for rows whose origin can't be derived honestly.
  provenance text not null check (provenance in (
    'user_explicit', 'user_settings', 'tool_verified', 'inferred', 'unknown'
  )),
  certainty real not null default 1 check (certainty >= 0 and certainty <= 1),
  status text not null default 'active' check (status in ('active', 'superseded')),
  -- Interactions (conversation or voice session ids) that support it: ids only, never text.
  sources uuid[] not null default '{}',
  corroborations integer not null default 1 check (corroborations >= 1),
  observed_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  -- Learned in the background: which extractor (model@prompt version) and run.
  extractor text check (char_length(extractor) <= 120),
  extraction_ref text check (char_length(extraction_ref) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One current value per key and person: concurrent writes can't create two "truths".
create unique index memory_facts_active_key_idx
  on public.memory_facts (workspace_id, user_id, key) where status = 'active';
create index memory_facts_owner_idx
  on public.memory_facts (workspace_id, user_id, status, last_confirmed_at desc);

create trigger memory_facts_updated_at before update on public.memory_facts
  for each row execute function public.set_updated_at();

-- ── Do-not-relearn fingerprints ──────────────────────────────────────────────
-- A forgotten fact leaves keyed hashes (of its key, its value and its words), never its text:
-- enough to stop the extractor from learning it again, not enough to read it back.
create table public.memory_suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  key_hash text not null check (char_length(key_hash) between 16 and 128),
  value_hash text not null check (char_length(value_hash) between 16 and 128),
  word_hashes text[] not null default '{}' check (cardinality(word_hashes) <= 64),
  print_version smallint not null default 1,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, key_hash, value_hash)
);

-- ── Profile: a short, regenerable summary of the facts, each line citing them ─
create table public.memory_profiles (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null default 1,
  -- [{"text": "...", "facts": ["<fact id>", ...]}]
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  extractor text check (char_length(extractor) <= 120),
  generated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ── Spend ledger for background memory work (hard monthly caps) ─────────────
create table public.memory_spend (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('extract', 'consolidate')),
  job_ref text not null check (char_length(job_ref) between 1 and 200),
  month date not null,
  estimated_usd numeric(12, 6) not null check (estimated_usd >= 0),
  actual_usd numeric(12, 6) check (actual_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, kind, job_ref)
);

create index memory_spend_month_idx on public.memory_spend (workspace_id, month, user_id);

-- ── Learning progress per interaction ────────────────────────────────────────
alter table public.interaction_sessions
  add column memory_learned_through timestamptz,
  -- A run in progress (claimed): a second job for the same interaction waits its turn.
  add column memory_learning_at timestamptz;

-- ── Reserve budget before a paid call (atomic per workspace) ────────────────
-- Returns the reservation id, or null when it would pass a cap or the job was already done.
-- A retried job with a pending reservation gets the same one back (never counted twice).
create or replace function public.memory_reserve_spend(
  p_workspace_id uuid,
  p_user_id uuid,
  p_kind text,
  p_job_ref text,
  p_estimate numeric,
  p_user_cap numeric,
  p_workspace_cap numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now() at time zone 'utc')::date;
  v_existing public.memory_spend;
  v_user_spent numeric;
  v_workspace_spent numeric;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('memory_spend:' || p_workspace_id::text, 0));
  select * into v_existing from public.memory_spend
    where user_id = p_user_id and kind = p_kind and job_ref = p_job_ref;
  if found then
    return case when v_existing.status = 'reserved' then v_existing.id else null end;
  end if;
  select coalesce(sum(coalesce(actual_usd, estimated_usd)), 0) into v_user_spent
    from public.memory_spend
    where workspace_id = p_workspace_id and user_id = p_user_id and month = v_month
      and status <> 'released';
  if v_user_spent + p_estimate > p_user_cap then
    return null;
  end if;
  if p_workspace_cap is not null then
    select coalesce(sum(coalesce(actual_usd, estimated_usd)), 0) into v_workspace_spent
      from public.memory_spend
      where workspace_id = p_workspace_id and month = v_month and status <> 'released';
    if v_workspace_spent + p_estimate > p_workspace_cap then
      return null;
    end if;
  end if;
  insert into public.memory_spend (workspace_id, user_id, kind, job_ref, month, estimated_usd)
    values (p_workspace_id, p_user_id, p_kind, p_job_ref, v_month, p_estimate)
    returning id into v_id;
  return v_id;
end;
$$;

-- Records what a reserved call actually cost (or releases it when nothing was spent).
create or replace function public.memory_settle_spend(p_id uuid, p_actual numeric)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.memory_spend
    set actual_usd = p_actual,
        status = case when p_actual is null then 'released' else 'settled' end,
        settled_at = now()
    where id = p_id and status = 'reserved';
$$;

-- ── RLS: private to the person, inside a workspace they belong to ───────────
alter table public.memory_facts enable row level security;
alter table public.memory_suppressions enable row level security;
alter table public.memory_profiles enable row level security;
alter table public.memory_spend enable row level security;

create policy "People manage their own memory" on public.memory_facts
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "People keep their own forget list" on public.memory_suppressions
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "People manage their own profile" on public.memory_profiles
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "People read their own memory spend" on public.memory_spend
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on public.memory_facts, public.memory_suppressions, public.memory_profiles,
  public.memory_spend from anon;
-- The ledger and its functions are the server's (service role) only.
revoke insert, update, delete on public.memory_spend from authenticated;
revoke execute on function public.memory_reserve_spend(uuid, uuid, text, text, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke execute on function public.memory_settle_spend(uuid, numeric) from public, anon, authenticated;

-- ── Facts kept until now (ADR-068 JSON) → rows, with honest provenance ─────
-- "stated" with a source conversation was said in that conversation; "stated" without one was
-- written in Settings; "inferred" stays an inference. Ids are kept (they're already uuids).
insert into public.memory_facts (
  id, workspace_id, user_id, key, value, provenance, certainty, status, sources,
  observed_at, last_confirmed_at, created_at, updated_at
)
select
  case when f->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (f->>'id')::uuid else gen_random_uuid() end,
  p.workspace_id,
  p.user_id,
  left(f->>'key', 60),
  left(f->>'value', 300),
  case
    when f->>'confidence' = 'inferred' then 'inferred'
    when jsonb_typeof(f->'sources') = 'array' and jsonb_array_length(f->'sources') > 0
      then 'user_explicit'
    when f->>'confidence' = 'stated' then 'user_settings'
    else 'unknown'
  end,
  case when f->>'confidence' = 'inferred' then 0.6 else 1 end,
  case when f->>'status' = 'superseded' then 'superseded' else 'active' end,
  coalesce(
    (
      select array_agg(s::uuid)
      from jsonb_array_elements_text(
        case when jsonb_typeof(f->'sources') = 'array' then f->'sources' else '[]'::jsonb end
      ) s
      where s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    '{}'
  ),
  coalesce((f->>'createdAt')::timestamptz, now()),
  coalesce((f->>'lastConfirmedAt')::timestamptz, now()),
  coalesce((f->>'createdAt')::timestamptz, now()),
  coalesce((f->>'updatedAt')::timestamptz, now())
from public.user_preferences p,
  jsonb_array_elements(case when jsonb_typeof(p.value_json) = 'array' then p.value_json else '[]'::jsonb end) f
where p.key = 'memory.facts'
  and coalesce(f->>'key', '') <> ''
  and coalesce(f->>'value', '') <> ''
on conflict do nothing;

delete from public.user_preferences where key = 'memory.facts';
