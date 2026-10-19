-- ADR-087: a movement can belong to several Ámbitos ("Personal" and "Firbot").
-- book_ids holds the whole set; book_id stays as its first (primary) Ámbito so every existing
-- function, import and budget keeps working. A trigger keeps the two in step either way.

alter table public.finance_transactions
  add column if not exists book_ids uuid[] not null default '{}';

update public.finance_transactions
set book_ids = array[book_id]
where book_id is not null and book_ids = '{}';

create index if not exists finance_transactions_book_ids_idx
  on public.finance_transactions using gin (book_ids);

create or replace function public.sync_finance_transaction_books()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.book_ids is not distinct from old.book_ids
     and new.book_id is distinct from old.book_id then
    -- Only book_id changed: a single-Ámbito client, or the FK clearing a deleted Ámbito.
    new.book_ids := case
      when new.book_id is null then array_remove(old.book_ids, old.book_id)
      else array[new.book_id]
    end;
  elsif tg_op = 'INSERT' and new.book_ids = '{}' and new.book_id is not null then
    new.book_ids := array[new.book_id];
  end if;
  -- No duplicates, no nulls, order kept (the first is the primary).
  new.book_ids := coalesce(
    (select array_agg(b order by first_at)
       from (select b, min(i) as first_at
               from unnest(new.book_ids) with ordinality as u(b, i)
              where b is not null
              group by b) d),
    '{}'
  );
  new.book_id := new.book_ids[1];
  if exists (
    select 1 from unnest(new.book_ids) as b
    where not public.finance_book_in_workspace(b, new.workspace_id)
  ) then
    raise exception 'book must belong to the same workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists finance_transactions_sync_books on public.finance_transactions;
create trigger finance_transactions_sync_books
  before insert or update on public.finance_transactions
  for each row execute function public.sync_finance_transaction_books();

-- A deleted Ámbito leaves every movement it was a secondary Ámbito of (the FK handles book_id).
create or replace function public.forget_finance_book()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.finance_transactions
  set book_ids = array_remove(book_ids, old.id)
  where workspace_id = old.workspace_id and book_ids @> array[old.id] and book_id is distinct from old.id;
  return old;
end;
$$;

drop trigger if exists finance_books_forget on public.finance_books;
create trigger finance_books_forget
  before delete on public.finance_books
  for each row execute function public.forget_finance_book();

-- Combining (ADR-083) with several Ámbitos: the same set of Ámbitos (any order), which the
-- combined movement keeps. Movements without an account combine too, when none has one.
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
  v_books uuid[];
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
           and count(distinct coalesce(account_id::text, '')) = 1
           and count(distinct currency) = 1
           and count(distinct (select coalesce(array_agg(b order by b), '{}') from unnest(book_ids) b)) = 1
           and count(distinct status) = 1
    into v_ok
    from public.finance_transactions where id = any (p_ids);
  if not v_ok then
    raise exception 'movements must share account, currency, scope and status' using errcode = '22023';
  end if;

  -- Signed arithmetic in exact decimals: income adds, expense subtracts.
  select min(account_id::text)::uuid, min(currency), min(status),
         sum(case when transaction_type = 'income' then amount else -amount end),
         max(transaction_date)
    into v_account, v_currency, v_status, v_sum, v_date
    from public.finance_transactions where id = any (p_ids);
  select book_ids into v_books from public.finance_transactions where id = p_ids[1];
  if v_sum = 0 then
    raise exception 'the combined amount would be zero' using errcode = '22023';
  end if;

  insert into public.finance_transactions (
    id, workspace_id, transaction_type, amount, currency, transaction_date, description,
    account_id, category_id, book_ids, status, source, fingerprint, created_by_user_id,
    merged_source_count
  ) values (
    v_new, v_ws, case when v_sum > 0 then 'income' else 'expense' end, abs(v_sum), v_currency, v_date,
    nullif(btrim(coalesce(p_description, '')), ''), v_account, p_category, v_books, v_status, 'user_ui',
    'merged:' || v_new::text, (select auth.uid()), cardinality(p_ids)
  );

  update public.finance_transactions
    set merged_into_transaction_id = v_new, merged_at = now(), archived_at = now()
    where id = any (p_ids);
  return v_new;
end;
$$;

-- The account a movement goes to when none is said ("Mercado Pago"). Archived or deleted → none.
alter table public.finance_settings
  add column if not exists default_account_id uuid references public.finance_accounts (id) on delete set null;

create or replace function public.check_finance_settings_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.default_account_id is not null and not exists (
    select 1 from public.finance_accounts a
    where a.id = new.default_account_id and a.workspace_id = new.workspace_id and a.archived_at is null
  ) then
    raise exception 'account must belong to the same workspace';
  end if;
  return new;
end;
$$;

drop trigger if exists finance_settings_refs on public.finance_settings;
create trigger finance_settings_refs
  before insert or update on public.finance_settings
  for each row execute function public.check_finance_settings_refs();
