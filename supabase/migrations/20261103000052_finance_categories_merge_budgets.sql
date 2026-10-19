-- Finance v3 (ADR-083): atomic category deletion, normalized category names, combined movements
-- with provenance, and budgets over several categories with a name and an icon. Additive and
-- non-destructive: no movement is ever deleted; legacy single-category budgets keep working.

-- ── 1. Category names: one per normalized name and type ─────────────────────
-- "  Regalos ", "regalos" and "REGALOS" are the same expense category. The existing index
-- (lower(name)) stays; this one also ignores surrounding and repeated spaces. Created only when
-- no legacy rows already collide (those are reported, never merged silently); ELISE normalizes
-- names on write either way.
do $$
begin
  if exists (
    select 1
    from public.finance_categories
    where archived_at is null
    group by workspace_id, category_type, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
    having count(*) > 1
  ) then
    raise notice 'finance_categories: legacy duplicates (spacing) exist; normalized index skipped. ELISE still blocks new duplicates.';
  else
    create unique index if not exists finance_categories_normalized_name_idx
      on public.finance_categories (
        workspace_id, category_type, lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
      ) where archived_at is null;
  end if;
end;
$$;

-- ── 2. Budgets: a name, an icon, several categories ─────────────────────────
alter table public.finance_budgets
  add column if not exists name text check (name is null or char_length(btrim(name)) between 1 and 60),
  add column if not exists icon text check (icon is null or char_length(icon) <= 16),
  alter column category_id drop not null;

-- One budget per (scope, category, sub, currency) no longer fits budgets over several categories.
drop index if exists public.finance_budgets_scope_idx;

create table public.finance_budget_categories (
  budget_id uuid not null references public.finance_budgets (id) on delete cascade,
  category_id uuid not null references public.finance_categories (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  primary key (budget_id, category_id)
);
create index finance_budget_categories_category_idx on public.finance_budget_categories (category_id);

-- Every legacy budget keeps its category as its first (only) link.
insert into public.finance_budget_categories (budget_id, category_id, workspace_id)
select id, category_id, workspace_id from public.finance_budgets where category_id is not null
on conflict do nothing;

create or replace function public.check_finance_budget_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.finance_book_in_workspace(new.book_id, new.workspace_id) or (
    new.category_id is not null and not exists (
      select 1 from public.finance_categories c where c.id = new.category_id and c.workspace_id = new.workspace_id
    )
  ) then
    raise exception 'budget references must belong to the same workspace';
  end if;
  return new;
end;
$$;

create or replace function public.check_finance_budget_category_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.finance_budgets b where b.id = new.budget_id and b.workspace_id = new.workspace_id
  ) or not exists (
    select 1 from public.finance_categories c where c.id = new.category_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'budget categories must belong to the same workspace';
  end if;
  return new;
end;
$$;
create trigger finance_budget_categories_refs before insert or update on public.finance_budget_categories
  for each row execute function public.check_finance_budget_category_refs();

alter table public.finance_budget_categories enable row level security;
create policy "Members read budget categories" on public.finance_budget_categories
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add budget categories" on public.finance_budget_categories
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members remove budget categories" on public.finance_budget_categories
  for delete to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.finance_budget_categories from anon;
grant select, insert, delete on public.finance_budget_categories to authenticated;

-- ── 3. Combined movements: provenance, never destruction ────────────────────
-- A source keeps everything (import ids, fingerprints, provenance); it's hidden (archived_at)
-- and points at the movement that replaced it. The combined one knows how many it holds.
alter table public.finance_transactions
  add column if not exists merged_into_transaction_id uuid references public.finance_transactions (id) on delete set null,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_source_count integer check (merged_source_count is null or merged_source_count >= 2);
create index if not exists finance_transactions_merged_into_idx
  on public.finance_transactions (merged_into_transaction_id) where merged_into_transaction_id is not null;

-- ── 4. Atomic operations (one transaction each; caller's membership checked) ─

-- Delete a category: its movements stay, uncategorized; subcategories move up; budgets lose the
-- link, and a budget left with no category is archived (never deleted).
create or replace function public.finance_delete_category(p_category uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_moved integer;
  v_archived integer;
begin
  select workspace_id into v_ws from public.finance_categories where id = p_category;
  -- Not found and not a member look the same: nothing about other workspaces leaks.
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'category not found' using errcode = 'P0002';
  end if;

  update public.finance_transactions set category_id = null
    where workspace_id = v_ws and category_id = p_category;
  get diagnostics v_moved = row_count;

  -- Legacy single-category column: the link table is the source of truth from here on.
  update public.finance_budgets set category_id = null
    where workspace_id = v_ws and category_id = p_category;
  delete from public.finance_budget_categories where workspace_id = v_ws and category_id = p_category;
  update public.finance_budgets b set status = 'archived', archived_at = now()
    where b.workspace_id = v_ws and b.archived_at is null
      and not exists (select 1 from public.finance_budget_categories x where x.budget_id = b.id);
  get diagnostics v_archived = row_count;

  delete from public.finance_categories where id = p_category and workspace_id = v_ws;
  return jsonb_build_object('uncategorized', v_moved, 'budgetsArchived', v_archived);
end;
$$;

-- Combine movements of one account and one currency into one, by signed sum. The sources are
-- kept, hidden and linked (finance_uncombine_transaction brings them back).
create or replace function public.finance_combine_transactions(
  p_ids uuid[],
  p_description text,
  p_category uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_ws uuid;
  v_account uuid;
  v_currency text;
  v_book uuid;
  v_status text;
  v_sum numeric(20, 4);
  v_date date;
  v_new uuid := gen_random_uuid();
  v_ok boolean;
begin
  if p_ids is null or cardinality(p_ids) < 2 or cardinality(p_ids) > 500 then
    raise exception 'combine needs between 2 and 500 movements' using errcode = '22023';
  end if;

  -- RLS: rows of other workspaces are simply not visible, so the count won't match.
  perform 1 from public.finance_transactions where id = any (p_ids) for update;
  select count(*), min(workspace_id::text)::uuid
    into v_count, v_ws
    from public.finance_transactions where id = any (p_ids);
  if v_count <> cardinality(p_ids) then
    raise exception 'movements not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.finance_transactions
    where id = any (p_ids)
      and (archived_at is not null or merged_into_transaction_id is not null
           or transaction_type not in ('income', 'expense') or to_account_id is not null)
  ) then
    raise exception 'only active income or expense movements can be combined' using errcode = '22023';
  end if;

  select count(distinct workspace_id) = 1
           and count(distinct account_id) = 1 and bool_and(account_id is not null)
           and count(distinct currency) = 1
           and count(distinct coalesce(book_id::text, '')) = 1
           and count(distinct status) = 1
    into v_ok
    from public.finance_transactions where id = any (p_ids);
  if not v_ok then
    raise exception 'movements must share account, currency, scope and status' using errcode = '22023';
  end if;

  -- Signed arithmetic in exact decimals: income adds, expense subtracts.
  select min(account_id::text)::uuid, min(currency), min(book_id::text)::uuid, min(status),
         sum(case when transaction_type = 'income' then amount else -amount end),
         max(transaction_date)
    into v_account, v_currency, v_book, v_status, v_sum, v_date
    from public.finance_transactions where id = any (p_ids);
  if v_sum = 0 then
    raise exception 'the combined amount would be zero' using errcode = '22023';
  end if;

  insert into public.finance_transactions (
    id, workspace_id, transaction_type, amount, currency, transaction_date, description,
    account_id, category_id, book_id, status, source, fingerprint, created_by_user_id,
    merged_source_count
  ) values (
    v_new, v_ws, case when v_sum > 0 then 'income' else 'expense' end, abs(v_sum), v_currency, v_date,
    nullif(btrim(coalesce(p_description, '')), ''), v_account, p_category, v_book, v_status, 'user_ui',
    'merged:' || v_new::text, (select auth.uid()), cardinality(p_ids)
  );

  update public.finance_transactions
    set merged_into_transaction_id = v_new, merged_at = now(), archived_at = now()
    where id = any (p_ids);
  return v_new;
end;
$$;

-- Undo a combination: the sources come back exactly as they were; the combined one is archived.
create or replace function public.finance_uncombine_transaction(p_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_restored integer;
begin
  perform 1 from public.finance_transactions
    where id = p_id and archived_at is null and merged_into_transaction_id is null
      and merged_source_count is not null
    for update;
  if not found then
    raise exception 'combined movement not found' using errcode = 'P0002';
  end if;
  update public.finance_transactions
    set merged_into_transaction_id = null, merged_at = null, archived_at = null
    where merged_into_transaction_id = p_id;
  get diagnostics v_restored = row_count;
  update public.finance_transactions set archived_at = now() where id = p_id;
  return v_restored;
end;
$$;

revoke all on function public.finance_delete_category(uuid) from public, anon;
revoke all on function public.finance_combine_transactions(uuid[], text, uuid) from public, anon;
revoke all on function public.finance_uncombine_transaction(uuid) from public, anon;
grant execute on function public.finance_delete_category(uuid) to authenticated;
grant execute on function public.finance_combine_transactions(uuid[], text, uuid) to authenticated;
grant execute on function public.finance_uncombine_transaction(uuid) to authenticated;
