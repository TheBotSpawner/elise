-- Cost accounting and budgets (ADR-138). Additive: nothing is dropped, no history is rewritten.
-- usage_events stays the one ledger; the budget tables only hold what limiting needs. Every table
-- here is server-only: browsers never see a cost, a balance or a plan, and can't write any of them.
-- Amounts are integer micro-USD (1 USD = 1,000,000): never floats.

-- 1. The ledger. Rows before this migration keep cost_status null: their costs aren't restated.
alter table public.usage_events
  add column source text check (source in ('web', 'desktop', 'job')),
  add column modality text check (modality in ('chat', 'voice', 'background')),
  add column cache_write_tokens integer check (cache_write_tokens >= 0),
  add column idempotency_key text unique check (char_length(idempotency_key) <= 200),
  add column provider_request_id text check (char_length(provider_request_id) <= 200),
  -- actual: the provider's reported usage at a verified price. estimated: ELISE's own measure
  -- (a cut stream). unknown: no verified price; never part of a margin conclusion.
  add column cost_status text check (cost_status in ('actual', 'estimated', 'unknown')),
  add column price_version text check (char_length(price_version) <= 40),
  -- What budgets count: the cost, or a conservative stand-in when it's unknown. Negative only on
  -- adjustments.
  add column budget_micro bigint not null default 0,
  add column reservation_id uuid,
  add column adjusts_event_id uuid references public.usage_events (id) on delete set null;

alter table public.usage_events drop constraint if exists usage_events_status_check;
alter table public.usage_events add constraint usage_events_status_check
  check (status in ('succeeded', 'failed', 'cancelled'));
alter table public.usage_events drop constraint if exists usage_events_operation_check;
alter table public.usage_events add constraint usage_events_operation_check check (
  operation in (
    'llm', 'embedding', 'transcription', 'speech', 'web_search', 'web_fetch', 'maps', 'ocr',
    'adjustment'
  )
);

-- Immutable for every API role, the server's included: a correction is a new 'adjustment' row.
-- Account deletion still works: foreign key actions run as the table's owner.
revoke update, delete, truncate on public.usage_events from authenticated, anon, service_role;

-- 2. Plans: limits are data, editable without a deploy. Figures are hypotheses for review (see
-- docs/engineering/38-cost-accounting.md) and every commercial plan starts inactive.
create table public.budget_pools (
  key text primary key check (char_length(key) between 1 and 40),
  limit_micro bigint not null check (limit_micro >= 0),
  seats integer check (seats >= 0),
  updated_at timestamptz not null default now()
);

create table public.budget_plans (
  key text primary key check (char_length(key) between 1 and 40),
  active boolean not null default false,
  pool_key text references public.budget_pools (key),
  trial_days integer check (trial_days > 0),
  -- Any of: total_micro, month_micro, day_micro, chat_day_micro, voice_day_micro,
  -- background_day_micro, workspace_month_micro. Absent: no limit of that kind.
  limits jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.budget_pools (key, limit_micro, seats) values ('beta', 90000000, 30);

insert into public.budget_plans (key, active, pool_key, trial_days, limits) values
  ('internal', true, null, null, '{}'),
  ('beta_90d', false, 'beta', 90, '{
    "total_micro": 3000000, "month_micro": 1500000, "day_micro": 200000,
    "voice_day_micro": 150000, "chat_day_micro": 150000, "background_day_micro": 30000
  }'),
  ('personal', false, null, null, '{
    "month_micro": 3000000, "day_micro": 400000,
    "voice_day_micro": 300000, "chat_day_micro": 300000, "background_day_micro": 60000
  }'),
  ('plus', false, null, null, '{
    "month_micro": 6000000, "day_micro": 800000,
    "voice_day_micro": 600000, "chat_day_micro": 600000, "background_day_micro": 120000
  }');

-- One plan per person. No row means no plan: enforcement refuses, it never means "unlimited".
create table public.account_plans (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_key text not null references public.budget_plans (key),
  started_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

-- Invitations store hashes only. A redeemed one outlives the account (redeemed_by goes null, the
-- identity hash stays), so deleting an account doesn't buy a second trial.
create table public.beta_invitations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (char_length(code_hash) between 32 and 128),
  expires_at timestamptz,
  identity_hash text check (char_length(identity_hash) between 32 and 128),
  redeemed_by uuid references auth.users (id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index beta_invitations_identity_idx on public.beta_invitations (identity_hash)
  where identity_hash is not null;

-- 3. Counters: subject ('user:<id>', 'workspace:<id>', 'pool:<key>'), period ('total',
-- 'month:YYYY-MM', 'day:YYYY-MM-DD', UTC), modality ('all' or one of them).
create table public.budget_counters (
  subject text not null,
  period text not null,
  modality text not null default 'all',
  spent_micro bigint not null default 0,
  reserved_micro bigint not null default 0 check (reserved_micro >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject, period, modality)
);

create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  user_id uuid references auth.users (id) on delete set null,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  modality text not null check (modality in ('chat', 'voice', 'background')),
  amount_micro bigint not null check (amount_micro >= 0),
  -- reserved → released | expired. denied: refused. shadow: evaluated only, nothing held.
  status text not null check (status in ('reserved', 'released', 'expired', 'denied', 'shadow')),
  allowed boolean not null,
  -- Why it was (or, in shadow, would have been) refused; null when it passes.
  reason text,
  counters jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index budget_reservations_open_idx on public.budget_reservations (expires_at)
  where status = 'reserved';
create index budget_reservations_created_idx on public.budget_reservations (created_at desc);

-- 4. What a provider really charged, kept apart from the assigned costs: reconciling never
-- rewrites an event. Credits included in a subscription or promotional credits go in credits_micro.
create table public.provider_invoices (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (char_length(provider) between 1 and 40),
  month date not null,
  amount_micro bigint not null check (amount_micro >= 0),
  credits_micro bigint not null default 0 check (credits_micro >= 0),
  created_at timestamptz not null default now(),
  unique (provider, month)
);

-- Server-only, including reads: RLS on with no policies, and no grants.
do $$
declare t text;
begin
  foreach t in array array[
    'budget_pools', 'budget_plans', 'account_plans', 'beta_invitations', 'budget_counters',
    'budget_reservations', 'provider_invoices'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from authenticated, anon', t);
  end loop;
end $$;

-- Only these functions change balances.
revoke insert, update, delete, truncate on public.budget_counters from service_role;
revoke insert, update, delete, truncate on public.budget_reservations from service_role;

-- 5. Balances.
create function public.budget_bump(
  p_subject text, p_period text, p_modality text, p_spent bigint, p_reserved bigint
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.budget_counters as c (subject, period, modality, spent_micro, reserved_micro)
  values (p_subject, p_period, p_modality, p_spent, greatest(p_reserved, 0))
  on conflict (subject, period, modality) do update set
    spent_micro = c.spent_micro + p_spent,
    reserved_micro = greatest(c.reserved_micro + p_reserved, 0),
    updated_at = now();
$$;

-- Every recorded cost reaches the counters here, whatever wrote it. Counters are touched in the
-- same sorted order as reserve_budget, so the two can't deadlock. A job has no person: it counts
-- for the workspace's owner.
create function public.usage_event_to_budget() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := new.user_id;
  v_pool text;
  v_day text := 'day:' || to_char(new.created_at at time zone 'utc', 'YYYY-MM-DD');
  v_month text := 'month:' || to_char(new.created_at at time zone 'utc', 'YYYY-MM');
begin
  if new.budget_micro = 0 then return new; end if;
  if v_user is null then
    select owner_user_id into v_user from public.workspaces where id = new.workspace_id;
  end if;
  select p.pool_key into v_pool
    from public.account_plans a join public.budget_plans p on p.key = a.plan_key
    where a.user_id = v_user;
  if v_pool is not null then
    perform public.budget_bump('pool:' || v_pool, 'total', 'all', new.budget_micro, 0);
  end if;
  if v_user is not null then
    perform public.budget_bump('user:' || v_user, v_day, 'all', new.budget_micro, 0);
    if new.modality is not null then
      perform public.budget_bump('user:' || v_user, v_day, new.modality, new.budget_micro, 0);
    end if;
    perform public.budget_bump('user:' || v_user, v_month, 'all', new.budget_micro, 0);
    perform public.budget_bump('user:' || v_user, 'total', 'all', new.budget_micro, 0);
  end if;
  perform public.budget_bump('workspace:' || new.workspace_id, v_month, 'all', new.budget_micro, 0);
  return new;
end;
$$;

create trigger usage_events_to_budget after insert on public.usage_events
  for each row execute function public.usage_event_to_budget();

create function public.release_budget(p_reservation uuid, p_status text default 'released')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.budget_reservations;
  v_c record;
begin
  update public.budget_reservations
    set status = p_status, released_at = now()
    where id = p_reservation and status = 'reserved'
    returning * into v_row;
  if not found then return; end if;
  for v_c in
    select * from jsonb_to_recordset(v_row.counters) as x(subject text, period text, modality text)
  loop
    perform public.budget_bump(v_c.subject, v_c.period, v_c.modality, 0, -v_row.amount_micro);
  end loop;
end;
$$;

-- Reservations a crash left behind give their amount back.
create function public.expire_budget_reservations(p_limit integer default 200) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  for v_id in
    select id from public.budget_reservations
    where status = 'reserved' and expires_at <= now()
    order by expires_at limit p_limit
  loop
    perform public.release_budget(v_id, 'expired');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- The gate. One atomic decision before anything is spent: the same key always gets the same
-- answer (a retry reserves once), and rows locked in sorted order make concurrent requests from
-- tabs, Desktop and workers queue up instead of both passing. p_enforce false evaluates and
-- records without holding anything (shadow). p_user null: a job, which answers to the owner.
create function public.reserve_budget(
  p_key text,
  p_user uuid,
  p_workspace uuid,
  p_modality text,
  p_amount bigint,
  p_enforce boolean,
  p_ttl_seconds integer default 600
) returns table (reservation_id uuid, allowed boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seen public.budget_reservations;
  v_now timestamptz := now();
  v_user uuid := p_user;
  v_plan public.budget_plans;
  v_ends timestamptz;
  v_limit bigint;
  v_day text := 'day:' || to_char(v_now at time zone 'utc', 'YYYY-MM-DD');
  v_month text := 'month:' || to_char(v_now at time zone 'utc', 'YYYY-MM');
  v_checks jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
  v_reason text;
  v_used bigint;
  v_c record;
  v_id uuid;
begin
  select * into v_seen from public.budget_reservations where idempotency_key = p_key;
  if found then
    -- A retry of a request in flight. Once closed, a key approves nothing again.
    if v_seen.status in ('released', 'expired') then
      return query select v_seen.id, false, 'key_used'::text;
    else
      return query select v_seen.id, v_seen.allowed, v_seen.reason;
    end if;
    return;
  end if;

  if v_user is null then
    select owner_user_id into v_user from public.workspaces where id = p_workspace;
  end if;
  -- Whoever the server says this is, they must really belong to that workspace.
  if v_user is null or not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace and m.user_id = v_user and m.status = 'active'
  ) then
    v_reason := 'not_a_member';
  else
    select p.*, a.ends_at into v_plan.key, v_plan.active, v_plan.pool_key, v_plan.trial_days,
        v_plan.limits, v_plan.updated_at, v_ends
      from public.account_plans a join public.budget_plans p on p.key = a.plan_key
      where a.user_id = v_user;
    if not found then v_reason := 'no_plan';
    elsif not v_plan.active then v_reason := 'plan_inactive';
    elsif v_ends is not null and v_ends <= v_now then v_reason := 'trial_expired';
    end if;
  end if;

  if v_reason is null then
    if v_plan.pool_key is not null then
      select limit_micro into v_limit from public.budget_pools where key = v_plan.pool_key;
      v_checks := v_checks || jsonb_build_object('subject', 'pool:' || v_plan.pool_key,
        'period', 'total', 'modality', 'all', 'lim', coalesce(v_limit, 0), 'why', 'pool_exhausted');
    end if;
    v_checks := v_checks
      || jsonb_build_object('subject', 'user:' || v_user, 'period', v_day, 'modality', 'all',
           'lim', v_plan.limits->'day_micro', 'why', 'day_limit')
      || jsonb_build_object('subject', 'user:' || v_user, 'period', v_day, 'modality', p_modality,
           'lim', v_plan.limits->(p_modality || '_day_micro'), 'why', p_modality || '_day_limit')
      || jsonb_build_object('subject', 'user:' || v_user, 'period', v_month, 'modality', 'all',
           'lim', v_plan.limits->'month_micro', 'why', 'month_limit')
      || jsonb_build_object('subject', 'user:' || v_user, 'period', 'total', 'modality', 'all',
           'lim', v_plan.limits->'total_micro', 'why', 'total_limit')
      || jsonb_build_object('subject', 'workspace:' || p_workspace, 'period', v_month,
           'modality', 'all', 'lim', v_plan.limits->'workspace_month_micro',
           'why', 'workspace_month_limit');

    for v_c in
      select * from jsonb_to_recordset(v_checks)
        as x(subject text, period text, modality text, lim bigint, why text)
      where x.lim is not null
      order by x.subject, x.period, x.modality
    loop
      insert into public.budget_counters (subject, period, modality)
        values (v_c.subject, v_c.period, v_c.modality)
        on conflict (subject, period, modality) do nothing;
      select spent_micro + reserved_micro into v_used from public.budget_counters c
        where c.subject = v_c.subject and c.period = v_c.period and c.modality = v_c.modality
        for update;
      if v_used + p_amount > v_c.lim and v_reason is null then v_reason := v_c.why; end if;
      v_held := v_held || jsonb_build_object(
        'subject', v_c.subject, 'period', v_c.period, 'modality', v_c.modality);
    end loop;
  end if;

  if p_enforce and v_reason is null then
    for v_c in
      select * from jsonb_to_recordset(v_held) as x(subject text, period text, modality text)
    loop
      perform public.budget_bump(v_c.subject, v_c.period, v_c.modality, 0, p_amount);
    end loop;
  end if;

  insert into public.budget_reservations (
    idempotency_key, user_id, workspace_id, modality, amount_micro, status, allowed, reason,
    counters, expires_at
  ) values (
    p_key, v_user, p_workspace, p_modality, p_amount,
    case when not p_enforce then 'shadow' when v_reason is null then 'reserved' else 'denied' end,
    not p_enforce or v_reason is null, v_reason,
    case when p_enforce and v_reason is null then v_held else '[]'::jsonb end,
    v_now + make_interval(secs => p_ttl_seconds)
  ) returning id into v_id;

  return query select v_id, not p_enforce or v_reason is null, v_reason;
end;
$$;

-- How much of the tightest limit is gone, as a percentage: what the person may see. Never amounts.
create function public.budget_status(p_user uuid)
returns table (plan_key text, ends_at timestamptz, used_percent integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_ends timestamptz;
  v_limits jsonb;
  v_now timestamptz := now();
  v_pct numeric := 0;
  v_c record;
begin
  select a.plan_key, a.ends_at, p.limits into v_key, v_ends, v_limits
    from public.account_plans a join public.budget_plans p on p.key = a.plan_key
    where a.user_id = p_user;
  if not found then return; end if;
  for v_c in
    select (v_limits->>l.name)::numeric as lim, l.period from (values
      ('total_micro', 'total'),
      ('month_micro', 'month:' || to_char(v_now at time zone 'utc', 'YYYY-MM')),
      ('day_micro', 'day:' || to_char(v_now at time zone 'utc', 'YYYY-MM-DD'))
    ) as l(name, period)
  loop
    if v_c.lim > 0 then
      select greatest(v_pct, coalesce(max(
        (c.spent_micro + c.reserved_micro) * 100 / v_c.lim), 0)) into v_pct
      from public.budget_counters c
      where c.subject = 'user:' || p_user and c.period = v_c.period and c.modality = 'all';
    end if;
  end loop;
  return query select v_key, v_ends, floor(v_pct)::integer;
end;
$$;

-- One trial per invitation, per person and per identity, counted from now: not from when the
-- account was created. It never renews and nothing is charged when it ends.
create function public.activate_beta(
  p_user uuid, p_code_hash text, p_identity_hash text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.budget_plans;
  v_seats integer;
  v_taken integer;
  v_invite public.beta_invitations;
begin
  select * into v_plan from public.budget_plans where key = 'beta_90d';
  if not found or not v_plan.active then return 'closed'; end if;
  -- One at a time: seats can't be oversold.
  select seats into v_seats from public.budget_pools where key = v_plan.pool_key for update;
  select * into v_invite from public.beta_invitations where code_hash = p_code_hash for update;
  if not found then return 'invalid'; end if;
  if v_invite.redeemed_at is not null then return 'used'; end if;
  if v_invite.expires_at is not null and v_invite.expires_at <= now() then return 'expired'; end if;
  if exists (select 1 from public.account_plans where user_id = p_user) then return 'has_plan'; end if;
  if exists (select 1 from public.beta_invitations where identity_hash = p_identity_hash) then
    return 'already_tried';
  end if;
  select count(*) into v_taken from public.beta_invitations where redeemed_at is not null;
  if v_seats is not null and v_taken >= v_seats then return 'full'; end if;
  insert into public.account_plans (user_id, plan_key, ends_at)
    values (p_user, v_plan.key, now() + make_interval(days => v_plan.trial_days));
  update public.beta_invitations
    set redeemed_by = p_user, redeemed_at = now(), identity_hash = p_identity_hash
    where id = v_invite.id;
  return 'activated';
end;
$$;

-- The owner's report, aggregated where the data lives. Internal ids are shortened hashes: enough
-- to follow one account, never a name, an email or content.
create function public.usage_cost_report(p_since timestamptz) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select * from public.usage_events where created_at >= p_since and cost_status is not null
  ), per_user as (
    select left(md5(coalesce(user_id, workspace_id)::text), 8) as who,
      sum(coalesce(estimated_cost_usd, 0)) as cost
    from e group by 1
  ), per_run as (
    select sum(coalesce(estimated_cost_usd, 0)) as cost from e
    where ai_run_id is not null group by ai_run_id
  )
  select jsonb_build_object(
    'activeAccounts', (select count(*) from per_user),
    'byProvider', coalesce((
      select jsonb_agg(x order by x.cost desc) from (
        select provider, operation, cost_status as status, count(*) as calls,
          sum(coalesce(estimated_cost_usd, 0)) as cost
        from e group by 1, 2, 3
      ) x), '[]'::jsonb),
    'perAccount', (select jsonb_build_object(
        'p50', percentile_cont(0.5) within group (order by cost),
        'p95', percentile_cont(0.95) within group (order by cost)) from per_user),
    'perTurn', (select jsonb_build_object(
        'p50', percentile_cont(0.5) within group (order by cost),
        'p95', percentile_cont(0.95) within group (order by cost)) from per_run),
    'top', coalesce((
      select jsonb_agg(x) from (select who, cost from per_user order by cost desc limit 10) x
    ), '[]'::jsonb),
    'voice', (select jsonb_build_object(
        'cost', coalesce(sum(estimated_cost_usd) filter (where modality = 'voice'), 0),
        'minutes', coalesce(sum(units) filter (where operation = 'transcription'), 0) / 60
      ) from e),
    'unpriced', (select count(*) from e where cost_status = 'unknown'),
    'wouldDeny', coalesce((
      select jsonb_object_agg(reason, n) from (
        select reason, count(*) as n from public.budget_reservations
        where created_at >= p_since and status in ('shadow', 'denied') and reason is not null
        group by reason
      ) d), '{}'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(i order by i.month desc) from (
        select provider, month, amount_micro, credits_micro from public.provider_invoices
        where month >= (p_since at time zone 'utc')::date - 31
      ) i), '[]'::jsonb)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'budget_bump(text, text, text, bigint, bigint)',
    'usage_event_to_budget()',
    'release_budget(uuid, text)',
    'expire_budget_reservations(integer)',
    'reserve_budget(text, uuid, uuid, text, bigint, boolean, integer)',
    'budget_status(uuid)',
    'activate_beta(uuid, text, text)',
    'usage_cost_report(timestamptz)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'release_budget(uuid, text)',
    'expire_budget_reservations(integer)',
    'reserve_budget(text, uuid, uuid, text, bigint, boolean, integer)',
    'budget_status(uuid)',
    'activate_beta(uuid, text, text)',
    'usage_cost_report(timestamptz)'
  ] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- budget_bump stays private: only the definer functions above call it.
  revoke all on function public.budget_bump(text, text, text, bigint, bigint) from service_role;
end $$;
