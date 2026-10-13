-- ADR-054: an optional icon per finance category (one emoji, validated by ELISE).
alter table public.finance_categories
  add column if not exists icon text check (icon is null or char_length(icon) <= 16);
