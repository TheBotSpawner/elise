-- ADR-087: a budget can cover several Ámbitos ("Salidas" across Personal and Firbot): it counts
-- the expenses of any of them. book_ids holds the set; book_id stays as its first, kept in step
-- by the same trigger movements use. No Ámbito at all = every Ámbito (as before).

alter table public.finance_budgets
  add column if not exists book_ids uuid[] not null default '{}';

update public.finance_budgets
set book_ids = array[book_id]
where book_id is not null and book_ids = '{}';

drop trigger if exists finance_budgets_sync_books on public.finance_budgets;
create trigger finance_budgets_sync_books
  before insert or update on public.finance_budgets
  for each row execute function public.sync_finance_transaction_books();

-- A deleted Ámbito leaves movements and budgets that have other Ámbitos too. A budget of only
-- that Ámbito goes with it (its FK cascades, as before).
create or replace function public.forget_finance_book()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.finance_transactions
  set book_ids = array_remove(book_ids, old.id)
  where workspace_id = old.workspace_id and book_ids @> array[old.id] and book_id is distinct from old.id;
  update public.finance_budgets
  set book_ids = array_remove(book_ids, old.id)
  where workspace_id = old.workspace_id and book_ids @> array[old.id] and book_ids <> array[old.id];
  return old;
end;
$$;
