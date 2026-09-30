-- Finance Native + Google Sheets (docs/architecture/10 §20-26, 16 §49-59, ADR-009).
-- Structured bookkeeping, not banking: accounts are conceptual sources of money, amounts are
-- exact numerics with an ISO currency, and different currencies are never summed together.
-- Generic imports (imports / import_rows) create native transactions; connected Google Sheets
-- stay the source of truth and are mirrored read-only into finance_source_rows by sync.

update public.capability_definitions set status = 'available' where key = 'finance';

-- ── Settings ─────────────────────────────────────────────────────────────────
-- default_currency resolves "20 de supermercado" when nothing else says which currency.
-- reporting_currency is prepared for explicit conversion later; nothing converts today.
create table public.finance_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  default_currency text check (default_currency ~ '^[A-Z]{3}$'),
  reporting_currency text check (reporting_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Accounts (where money comes from or goes to; no bank connection) ────────
create table public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  account_type text not null default 'other'
    check (account_type in ('cash', 'bank', 'credit_card', 'debit_card', 'digital_wallet', 'business', 'other')),
  currency text check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index finance_accounts_name_idx
  on public.finance_accounts (workspace_id, lower(name)) where archived_at is null;

-- ── Categories (user-defined, optional hierarchy) ────────────────────────────
create table public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  parent_category_id uuid references public.finance_categories (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  category_type text not null default 'expense' check (category_type in ('income', 'expense', 'both')),
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint finance_categories_parent_not_self check (parent_category_id is null or parent_category_id <> id)
);

create unique index finance_categories_name_idx
  on public.finance_categories (workspace_id, category_type, lower(name)) where archived_at is null;

-- ── Generic imports (docs/architecture/16 §57-59) ────────────────────────────
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  import_type text not null check (import_type in ('finance_transactions')),
  source_type text not null check (source_type in ('csv', 'xlsx', 'google_sheets')),
  -- File name, or spreadsheet id + tab for Google Sheets (used to detect double counting).
  source_reference text not null check (char_length(source_reference) <= 500),
  source_label text check (char_length(source_label) <= 300),
  connection_id uuid references public.provider_connections (id) on delete set null,
  file_path text,
  file_hash text,
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'importing', 'completed', 'failed', 'rolled_back', 'cancelled')),
  mapping_config jsonb not null default '{}'::jsonb,
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  imported_rows integer not null default 0,
  error_code text,
  runtime_job_id text,
  created_by_user_id uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index imports_workspace_idx on public.imports (workspace_id, created_at desc);
create index imports_hash_idx on public.imports (workspace_id, file_hash) where file_hash is not null;

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  import_id uuid not null references public.imports (id) on delete cascade,
  source_row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb,
  status text not null check (status in ('imported', 'invalid', 'duplicate')),
  error_details jsonb,
  created_resource_type text,
  created_resource_id uuid,
  created_at timestamptz not null default now(),
  unique (import_id, source_row_number)
);

-- ── Transactions (ELISE Finance is their source of truth) ────────────────────
create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  transaction_type text not null check (transaction_type in ('income', 'expense')),
  -- Exact decimal, always positive; the type says the direction. Never a float.
  amount numeric(20, 4) not null check (amount > 0 and amount < 1000000000000000),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transaction_date date not null,
  description text check (char_length(description) <= 300),
  counterparty text check (char_length(counterparty) <= 200),
  account_id uuid references public.finance_accounts (id) on delete set null,
  category_id uuid references public.finance_categories (id) on delete set null,
  subcategory text check (char_length(subcategory) <= 80),
  payment_method text check (char_length(payment_method) <= 80),
  -- Free project label until Entities exist; entity_id is reserved for that link.
  project text check (char_length(project) <= 120),
  entity_id uuid,
  status text not null default 'completed' check (status in ('completed', 'pending', 'cancelled')),
  notes text check (char_length(notes) <= 2000),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  import_id uuid references public.imports (id) on delete set null,
  import_row_number integer,
  external_reference text check (char_length(external_reference) <= 200),
  -- Canonical date|type|amount|currency|who, for duplicate detection across imports.
  fingerprint text not null,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index finance_transactions_date_idx
  on public.finance_transactions (workspace_id, transaction_date desc) where archived_at is null;
create index finance_transactions_fingerprint_idx
  on public.finance_transactions (workspace_id, fingerprint) where archived_at is null;
create index finance_transactions_import_idx on public.finance_transactions (import_id);

-- ── Connected Google Sheets (the sheet stays authoritative) ──────────────────
create table public.finance_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_type text not null default 'google_sheets' check (source_type in ('google_sheets')),
  connection_id uuid references public.provider_connections (id) on delete set null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  spreadsheet_id text not null check (spreadsheet_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  sheet_id bigint not null,
  sheet_title text not null,
  mapping_config jsonb not null default '{}'::jsonb,
  -- Off when the same sheet was also imported into ELISE, so nothing is counted twice.
  include_in_totals boolean not null default true,
  status text not null default 'idle'
    check (status in ('idle', 'syncing', 'ready', 'needs_attention', 'disconnected', 'archived')),
  row_count integer not null default 0,
  invalid_rows integer not null default 0,
  last_synced_at timestamptz,
  last_error_code text,
  next_sync_at timestamptz,
  sync_started_at timestamptz,
  runtime_job_id text,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index finance_sources_sheet_idx
  on public.finance_sources (workspace_id, spreadsheet_id, sheet_id) where archived_at is null;
create index finance_sources_due_idx on public.finance_sources (next_sync_at) where archived_at is null;

-- Normalized, read-only mirror of a connected sheet's rows. Structured, never vectorized.
create table public.finance_source_rows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.finance_sources (id) on delete cascade,
  -- Content fingerprint + occurrence: stable when rows move, new when a row changes.
  row_key text not null,
  row_number integer not null,
  transaction_type text not null check (transaction_type in ('income', 'expense')),
  amount numeric(20, 4) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transaction_date date not null,
  description text,
  counterparty text,
  account_name text,
  category_name text,
  subcategory text,
  payment_method text,
  project text,
  status text not null default 'completed' check (status in ('completed', 'pending', 'cancelled')),
  notes text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, row_key)
);

create index finance_source_rows_date_idx on public.finance_source_rows (workspace_id, source_id, transaction_date desc);

-- ── Same-workspace guards ────────────────────────────────────────────────────
create or replace function public.check_finance_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'finance_transactions' then
    if new.account_id is not null and not exists (
      select 1 from public.finance_accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id
    ) then
      raise exception 'account must belong to the same workspace';
    end if;
    if new.category_id is not null and not exists (
      select 1 from public.finance_categories c where c.id = new.category_id and c.workspace_id = new.workspace_id
    ) then
      raise exception 'category must belong to the same workspace';
    end if;
    if new.import_id is not null and not exists (
      select 1 from public.imports i where i.id = new.import_id and i.workspace_id = new.workspace_id
    ) then
      raise exception 'import must belong to the same workspace';
    end if;
  elsif tg_table_name = 'finance_categories' then
    if new.parent_category_id is not null and not exists (
      select 1 from public.finance_categories c where c.id = new.parent_category_id and c.workspace_id = new.workspace_id
    ) then
      raise exception 'parent category must belong to the same workspace';
    end if;
  elsif tg_table_name = 'imports' or tg_table_name = 'finance_sources' then
    if new.connection_id is not null and not exists (
      select 1 from public.provider_connections p where p.id = new.connection_id and p.workspace_id = new.workspace_id
    ) then
      raise exception 'connection must belong to the same workspace';
    end if;
  elsif tg_table_name = 'import_rows' then
    if not exists (select 1 from public.imports i where i.id = new.import_id and i.workspace_id = new.workspace_id) then
      raise exception 'import must belong to the same workspace';
    end if;
  elsif tg_table_name = 'finance_source_rows' then
    if not exists (select 1 from public.finance_sources s where s.id = new.source_id and s.workspace_id = new.workspace_id) then
      raise exception 'source must belong to the same workspace';
    end if;
  end if;
  return new;
end;
$$;

create trigger finance_transactions_refs before insert or update on public.finance_transactions
  for each row execute function public.check_finance_refs();
create trigger finance_categories_refs before insert or update on public.finance_categories
  for each row execute function public.check_finance_refs();
create trigger imports_refs before insert or update on public.imports
  for each row execute function public.check_finance_refs();
create trigger finance_sources_refs before insert or update on public.finance_sources
  for each row execute function public.check_finance_refs();
create trigger import_rows_refs before insert or update on public.import_rows
  for each row execute function public.check_finance_refs();
create trigger finance_source_rows_refs before insert or update on public.finance_source_rows
  for each row execute function public.check_finance_refs();

create trigger finance_settings_updated_at before update on public.finance_settings
  for each row execute function public.set_updated_at();
create trigger finance_accounts_updated_at before update on public.finance_accounts
  for each row execute function public.set_updated_at();
create trigger finance_categories_updated_at before update on public.finance_categories
  for each row execute function public.set_updated_at();
create trigger finance_transactions_updated_at before update on public.finance_transactions
  for each row execute function public.set_updated_at();
create trigger imports_updated_at before update on public.imports
  for each row execute function public.set_updated_at();
create trigger finance_sources_updated_at before update on public.finance_sources
  for each row execute function public.set_updated_at();
create trigger finance_source_rows_updated_at before update on public.finance_source_rows
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Members manage native finance data (archive, never delete). Import rows and the mirror of
-- connected sheets are written only by ELISE's server (service role) and read by members.
alter table public.finance_settings enable row level security;
alter table public.finance_accounts enable row level security;
alter table public.finance_categories enable row level security;
alter table public.finance_transactions enable row level security;
alter table public.imports enable row level security;
alter table public.import_rows enable row level security;
alter table public.finance_sources enable row level security;
alter table public.finance_source_rows enable row level security;

create policy "Members read finance settings" on public.finance_settings for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add finance settings" on public.finance_settings for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change finance settings" on public.finance_settings for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read finance accounts" on public.finance_accounts for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add finance accounts" on public.finance_accounts for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change finance accounts" on public.finance_accounts for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read finance categories" on public.finance_categories for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add finance categories" on public.finance_categories for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change finance categories" on public.finance_categories for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read transactions" on public.finance_transactions for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add transactions" on public.finance_transactions for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change transactions" on public.finance_transactions for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read imports" on public.imports for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members start imports" on public.imports for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change imports" on public.imports for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read import rows" on public.import_rows for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "Members read finance sources" on public.finance_sources for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add finance sources" on public.finance_sources for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change finance sources" on public.finance_sources for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read finance source rows" on public.finance_source_rows for select to authenticated using (public.is_workspace_member(workspace_id));

revoke delete on public.finance_settings, public.finance_accounts, public.finance_categories,
  public.finance_transactions, public.imports, public.finance_sources from anon, authenticated;
revoke insert, update, delete on public.import_rows, public.finance_source_rows from anon, authenticated;
revoke all on public.finance_settings, public.finance_accounts, public.finance_categories,
  public.finance_transactions, public.imports, public.import_rows, public.finance_sources,
  public.finance_source_rows from anon;

alter publication supabase_realtime add table
  public.finance_accounts, public.finance_categories, public.finance_transactions,
  public.imports, public.finance_sources;

-- ── Storage: uploaded spreadsheets waiting to be imported ────────────────────
-- Private; paths are workspace/{workspace_id}/finance-imports/{import_id}/{file}. Signed URLs only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-imports',
  'finance-imports',
  false,
  20971520,
  array[
    'text/csv',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream'
  ]
)
on conflict (id) do nothing;

-- ── ELISE Native provides Finance in every workspace ─────────────────────────
create or replace function public.provision_native_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  native_connection_id uuid;
  capability text;
begin
  insert into public.provider_connections
    (workspace_id, provider_key, created_by_user_id, external_account_id, display_name, status)
  values (new.id, 'elise_native', new.owner_user_id, new.id::text, 'ELISE', 'connected')
  returning id into native_connection_id;

  foreach capability in array array['tasks', 'habits', 'goals', 'lists', 'notes', 'finance'] loop
    insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level)
    values (new.id, native_connection_id, capability, 'write');
    insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
    values (new.id, capability, native_connection_id, true);
  end loop;

  return new;
end;
$$;

insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level)
select c.workspace_id, c.id, 'finance', 'write'
from public.provider_connections c
where c.provider_key = 'elise_native'
on conflict (connection_id, capability_key) do nothing;

insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
select c.workspace_id, 'finance', c.id, true
from public.provider_connections c
where c.provider_key = 'elise_native'
  and not exists (
    select 1 from public.capability_bindings b
    where b.workspace_id = c.workspace_id and b.capability_key = 'finance' and b.connection_id = c.id
  );
