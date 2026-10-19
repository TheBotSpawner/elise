-- ADR-089: a transfer between accounts in different currencies records both sides: what left
-- (amount, currency) and what arrived (to_amount, to_currency). The rate is derived from them,
-- never stored separately, so the two amounts and the rate can never disagree.

alter table public.finance_transactions
  add column if not exists to_amount numeric(20, 4) check (to_amount > 0),
  add column if not exists to_currency text check (to_currency ~ '^[A-Z]{3}$');

alter table public.finance_transactions
  add constraint finance_transactions_transfer_fx check (
    (to_amount is null and to_currency is null)
    or (transaction_type = 'transfer' and to_amount is not null and to_currency is not null
        and to_currency <> currency)
  );
