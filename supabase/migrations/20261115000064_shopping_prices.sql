-- ADR-111: public supermarket prices (SEPA, Secretaría de Comercio, CC-BY 4.0) for Listas, chat
-- and voice. Public data is shared by everyone (read-only to members, written only by the
-- ingestion with the service role); what a person links or watches is theirs, under RLS.
--
-- Additive: no existing row changes. Nothing is downloaded by this migration: ingestion runs
-- only when it is deliberately enabled (SHOPPING_INGEST_ENABLED) or run by hand.

insert into public.capability_definitions (key, display_name, status) values
  ('shopping', 'Supermarket prices', 'available')
on conflict (key) do update set status = 'available';

-- ── Public catalog: products with a real barcode, as published (~61k) ────────────────────────
create table public.shopping_products (
  ean text primary key check (ean ~ '^[0-9]{13,14}$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  brand text check (char_length(brand) <= 80),
  size_amount numeric check (size_amount is null or size_amount > 0),
  size_unit text check (size_unit in ('g', 'ml', 'u')),
  -- Name and brand folded (lowercase, no accents): what a search reads.
  search text not null check (char_length(search) <= 300),
  last_seen date not null,
  updated_at timestamptz not null default now()
);

-- ── Each day's ingestion: provenance and operations ──────────────────────────────────────────
create table public.shopping_ingestions (
  id uuid primary key default gen_random_uuid(),
  dataset_date date not null,
  source_file text not null check (char_length(source_file) <= 300),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb check (octet_length(stats::text) <= 20000),
  error text check (char_length(error) <= 500)
);
create index shopping_ingestions_recent_idx on public.shopping_ingestions (started_at desc);

-- ── Price history, only for products someone links or watches (delta-only) ───────────────────
create table public.shopping_price_history (
  ean text not null check (ean ~ '^[0-9]{13,14}$'),
  region text not null check (region ~ '^AR-[A-Z]$'),
  chain_id text not null check (char_length(chain_id) <= 20),
  chain_name text not null check (char_length(chain_name) <= 120),
  observed_on date not null,
  list_cents integer not null check (list_cents > 0),
  primary key (ean, region, chain_id, observed_on)
);

alter table public.shopping_products enable row level security;
alter table public.shopping_ingestions enable row level security;
alter table public.shopping_price_history enable row level security;
create policy "Members read the public catalog" on public.shopping_products for select
  to authenticated using (true);
create policy "Members read ingestion status" on public.shopping_ingestions for select
  to authenticated using (true);
create policy "Members read public price history" on public.shopping_price_history for select
  to authenticated using (true);

-- ── A list item linked to a product (the person chose it, or typed its barcode) ──────────────
create table public.list_item_products (
  list_item_id uuid primary key references public.list_items (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ean text not null check (ean ~ '^[0-9]{13,14}$'),
  quantity integer not null default 1 check (quantity between 1 and 99),
  match_method text not null check (match_method in ('barcode', 'confirmed')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index list_item_products_ean_idx on public.list_item_products (ean);
create trigger list_item_products_updated_at before update on public.list_item_products
  for each row execute function public.set_updated_at();

alter table public.list_item_products enable row level security;
create policy "Members manage their list products" on public.list_item_products for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.list_items i
       where i.id = list_item_id and i.workspace_id = list_item_products.workspace_id
    )
  );

-- ── Price alerts (checked once a day, right after fresh data arrives) ────────────────────────
create table public.shopping_price_alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  ean text not null check (ean ~ '^[0-9]{13,14}$'),
  product_name text not null check (char_length(product_name) between 1 and 200),
  region text not null check (region ~ '^AR-[A-Z]$'),
  threshold_cents integer not null check (threshold_cents > 0),
  chains text[] check (chains is null or cardinality(chains) <= 20),
  status text not null default 'active' check (status in ('active', 'paused')),
  -- armed: waiting for a crossing · triggered: notified, re-arms when the price is back above.
  state text not null default 'armed' check (state in ('armed', 'triggered')),
  last_check text check (last_check in ('hold', 'fire', 'rearm', 'stale', 'no_data')),
  last_checked_at timestamptz,
  last_best_cents integer,
  last_best_chain text check (char_length(last_best_chain) <= 120),
  last_quote_date date,
  triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shopping_price_alerts_active_idx on public.shopping_price_alerts (ean, region)
  where status = 'active';
create trigger shopping_price_alerts_updated_at before update on public.shopping_price_alerts
  for each row execute function public.set_updated_at();

alter table public.shopping_price_alerts enable row level security;
create policy "Users manage their price alerts" on public.shopping_price_alerts for all
  to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- One notification per crossing (the alert's trigger time is part of its source id).
create unique index notifications_price_alert_once on public.notifications (source_id, notification_type)
  where source_type = 'shopping_price_alert';

-- ── Each province's prices of the day, compact and compressed (one object per province) ─────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shopping-prices', 'shopping-prices', false, 20971520, array['application/gzip'])
on conflict (id) do nothing;
