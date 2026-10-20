-- ADR-101: every account has a recorded balance, computed by ONE function from the ledger.
--
--   balance(account, as_of) = opening_balance
--                             + Σ signed effects of its completed, active movements dated
--                               from opening_balance_date (or ever) through as_of
--
-- Additive: existing accounts get opening_balance 0 and no date (every movement counts), which
-- is exactly what they meant before. `opening_balance_set_at` stays null until the person (or
-- ELISE, on their request) sets it, so "0 because nobody said" is never presented as known.
-- No balance is stored: it can never disagree with the movements.

alter table public.finance_accounts
  add column if not exists opening_balance numeric(20, 4) not null default 0
    check (abs(opening_balance) < 1000000000000000),
  -- The baseline is the balance at the START of this day: movements dated on or after it count,
  -- earlier ones are already inside it. Null: every movement counts.
  add column if not exists opening_balance_date date,
  add column if not exists opening_balance_set_at timestamptz;

-- An opening balance is money in one currency: the account must have it.
alter table public.finance_accounts
  add constraint finance_accounts_opening_needs_currency
  check (opening_balance = 0 or currency is not null);

-- Effects, one row per account a movement touches (exact decimals, never floats):
--   income → +amount on account_id;  expense → −amount on account_id;
--   transfer → −amount (its currency) on account_id and +to_amount (to_currency), or +amount
--   when it arrived in the same currency, on to_account_id. Transfers are never income/expense.
-- Counted: completed and active (archived_at null). Combined sources are archived, so only the
-- combined movement counts; pending ones are reported apart; cancelled ones never count.
-- Movements in a currency other than the account's are returned as their own rows, never
-- converted. Security invoker: RLS decides what the caller sees; the workspace is explicit too.
create or replace function public.finance_account_balances(p_workspace uuid, p_as_of date)
returns table (
  account_id uuid,
  currency text,
  -- Exact decimals as text: PostgREST would turn numeric into a JSON (float) number.
  opening text,
  movements text,
  balance text,
  pending text,
  counted integer,
  pending_count integer,
  first_movement date,
  last_movement date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with acct as (
    select a.id, a.currency, a.opening_balance, a.opening_balance_date
    from public.finance_accounts a
    where a.workspace_id = p_workspace and a.archived_at is null
  ),
  effects as (
    select t.account_id as account_id, t.currency as currency,
           case when t.transaction_type = 'income' then t.amount else -t.amount end as delta,
           t.transaction_date, t.status
      from public.finance_transactions t
      where t.workspace_id = p_workspace and t.archived_at is null and t.account_id is not null
        and t.status <> 'cancelled'
    union all
    select t.to_account_id, coalesce(t.to_currency, t.currency), coalesce(t.to_amount, t.amount),
           t.transaction_date, t.status
      from public.finance_transactions t
      where t.workspace_id = p_workspace and t.archived_at is null
        and t.transaction_type = 'transfer' and t.to_account_id is not null
        and t.status <> 'cancelled'
  ),
  sums as (
    select e.account_id, e.currency,
           coalesce(sum(e.delta) filter (where e.status = 'completed'), 0) as movements,
           coalesce(sum(e.delta) filter (where e.status = 'pending'), 0) as pending,
           (count(*) filter (where e.status = 'completed'))::integer as counted,
           (count(*) filter (where e.status = 'pending'))::integer as pending_count,
           min(e.transaction_date) filter (where e.status = 'completed') as first_movement,
           max(e.transaction_date) filter (where e.status = 'completed') as last_movement
    from effects e
    join acct a on a.id = e.account_id
    where e.transaction_date <= p_as_of
      and (a.opening_balance_date is null or e.transaction_date >= a.opening_balance_date)
    group by e.account_id, e.currency
  ),
  keys as (
    select id as account_id, currency from acct where currency is not null
    union
    select s.account_id, s.currency from sums s
  )
  select k.account_id, k.currency,
         (case when k.currency = a.currency then a.opening_balance else 0 end)::text,
         coalesce(s.movements, 0)::text,
         ((case when k.currency = a.currency then a.opening_balance else 0 end)
           + coalesce(s.movements, 0))::text,
         coalesce(s.pending, 0)::text,
         coalesce(s.counted, 0),
         coalesce(s.pending_count, 0),
         s.first_movement,
         s.last_movement
  from keys k
  join acct a on a.id = k.account_id
  left join sums s on s.account_id = k.account_id and s.currency = k.currency;
$$;

revoke all on function public.finance_account_balances(uuid, date) from public;
grant execute on function public.finance_account_balances(uuid, date) to authenticated;
