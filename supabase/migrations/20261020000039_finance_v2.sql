-- ADR-052: Finance workspace v2 — Books (Ámbitos), transfers, receipts, budgets and dated
-- exchange rates. Additive and backward-compatible: no transaction, account or category is
-- recreated, no id changes. Existing transactions are NOT guessed into a Book: they stay
-- "Sin clasificar" (book_id null) until the user classifies them (or an account default does).

-- ── Books / Ámbitos: who the money belongs to (not a category) ───────────────
create table public.finance_books (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  book_type text not null default 'personal' check (book_type in ('personal', 'business', 'other')),
  icon text check (char_length(icon) <= 16),
  description text check (char_length(description) <= 300),
  reporting_currency text check (reporting_currency ~ '^[A-Z]{3}$'),
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index finance_books_name_idx
  on public.finance_books (workspace_id, lower(btrim(name))) where archived_at is null;
create unique index finance_books_default_idx
  on public.finance_books (workspace_id) where is_default and archived_at is null;

-- ── Transactions: Book, transfers, receipt ───────────────────────────────────
alter table public.finance_transactions
  add column book_id uuid references public.finance_books (id) on delete set null,
  -- Transfers move money between two own accounts: never income, never expense.
  add column to_account_id uuid references public.finance_accounts (id) on delete set null,
  -- "Comprobante": a link or an id (invoice number, bank reference).
  add column receipt text check (char_length(receipt) <= 500);
alter table public.finance_transactions drop constraint finance_transactions_transaction_type_check;
alter table public.finance_transactions
  add constraint finance_transactions_transaction_type_check
  check (transaction_type in ('income', 'expense', 'transfer'));

-- The Finance workspace reads one Book's period, newest first.
create index finance_transactions_book_date_idx
  on public.finance_transactions (workspace_id, book_id, transaction_date desc)
  where archived_at is null;

-- ── Accounts: an optional default Book (KiwiBank Firbot → Firbot) ────────────
alter table public.finance_accounts
  add column default_book_id uuid references public.finance_books (id) on delete set null;

-- ── Categories: global (empty) or offered only in some Books ─────────────────
alter table public.finance_categories add column book_ids uuid[] not null default '{}';

-- ── Connected sheets: the Book their rows belong to; transfers in the mirror ──
alter table public.finance_sources
  add column book_id uuid references public.finance_books (id) on delete set null;
alter table public.finance_source_rows drop constraint finance_source_rows_transaction_type_check;
alter table public.finance_source_rows
  add constraint finance_source_rows_transaction_type_check
  check (transaction_type in ('income', 'expense', 'transfer'));

-- ── Budgets: a monthly spending guide per Book + category (+ subcategory) ────
create table public.finance_budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  book_id uuid references public.finance_books (id) on delete cascade,
  category_id uuid not null references public.finance_categories (id) on delete cascade,
  subcategory text check (char_length(subcategory) <= 80),
  period text not null default 'monthly' check (period in ('monthly')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount numeric(20, 4) not null check (amount > 0 and amount < 1000000000000000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index finance_budgets_scope_idx
  on public.finance_budgets (
    workspace_id, coalesce(book_id, '00000000-0000-0000-0000-000000000000'::uuid), category_id,
    lower(coalesce(subcategory, '')), currency
  ) where archived_at is null;

-- ── Exchange rates: explicit, dated, entered by the user (no FX provider) ────
-- A conversion uses the latest rate on or before the transaction's own date, so history is
-- never recalculated with today's rate; the original amount and currency are never touched.
create table public.finance_fx_rates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_currency text not null check (from_currency ~ '^[A-Z]{3}$'),
  to_currency text not null check (to_currency ~ '^[A-Z]{3}$' and to_currency <> from_currency),
  rate numeric(20, 8) not null check (rate > 0),
  effective_date date not null,
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index finance_fx_rates_day_idx
  on public.finance_fx_rates (workspace_id, from_currency, to_currency, effective_date);

-- ── Same-workspace guards for every new reference ────────────────────────────
-- Cross-workspace references are rejected (one function per table: PL/pgSQL resolves every
-- NEW.field it reads, so a shared function can't name columns another table lacks).
create or replace function public.finance_book_in_workspace(book uuid, ws uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select book is null or exists (
    select 1 from public.finance_books b where b.id = book and b.workspace_id = ws
  );
$$;

create or replace function public.check_finance_transaction_v2_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.finance_book_in_workspace(new.book_id, new.workspace_id) then
    raise exception 'book must belong to the same workspace';
  end if;
  if new.to_account_id is not null and not exists (
    select 1 from public.finance_accounts a where a.id = new.to_account_id and a.workspace_id = new.workspace_id
  ) then
    raise exception 'account must belong to the same workspace';
  end if;
  return new;
end;
$$;

create or replace function public.check_finance_account_book()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.finance_book_in_workspace(new.default_book_id, new.workspace_id) then
    raise exception 'book must belong to the same workspace';
  end if;
  return new;
end;
$$;

create or replace function public.check_finance_book_ref()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.finance_book_in_workspace(new.book_id, new.workspace_id) then
    raise exception 'book must belong to the same workspace';
  end if;
  return new;
end;
$$;

create or replace function public.check_finance_budget_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.finance_book_in_workspace(new.book_id, new.workspace_id) or not exists (
    select 1 from public.finance_categories c where c.id = new.category_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'budget references must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger finance_transactions_v2_refs before insert or update on public.finance_transactions
  for each row execute function public.check_finance_transaction_v2_refs();
create trigger finance_accounts_v2_refs before insert or update on public.finance_accounts
  for each row execute function public.check_finance_account_book();
create trigger finance_sources_v2_refs before insert or update on public.finance_sources
  for each row execute function public.check_finance_book_ref();
create trigger finance_budgets_refs before insert or update on public.finance_budgets
  for each row execute function public.check_finance_budget_refs();

create trigger finance_books_updated_at before update on public.finance_books
  for each row execute function public.set_updated_at();
create trigger finance_budgets_updated_at before update on public.finance_budgets
  for each row execute function public.set_updated_at();
create trigger finance_fx_rates_updated_at before update on public.finance_fx_rates
  for each row execute function public.set_updated_at();

-- ── RLS (same conventions as Finance: members manage, archive instead of delete) ─
alter table public.finance_books enable row level security;
alter table public.finance_budgets enable row level security;
alter table public.finance_fx_rates enable row level security;

create policy "Members read finance books" on public.finance_books for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add finance books" on public.finance_books for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change finance books" on public.finance_books for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read budgets" on public.finance_budgets for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add budgets" on public.finance_budgets for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change budgets" on public.finance_budgets for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

-- Rates are corrected in place or removed (a wrong rate must be fixable).
create policy "Members manage exchange rates" on public.finance_fx_rates for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

revoke delete on public.finance_books, public.finance_budgets from anon, authenticated;
revoke all on public.finance_books, public.finance_budgets, public.finance_fx_rates from anon;

alter publication supabase_realtime add table public.finance_books, public.finance_budgets, public.finance_fx_rates;
