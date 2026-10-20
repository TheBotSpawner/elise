# ADR-101: Account balances (opening balance + ledger)

**Status:** Accepted (2026-10-20). Extends ADR-052 and ADR-083. Supersedes ADR-089's "ELISE keeps
no account balances".

## Context

Asked by voice "¿Cuánta plata tengo en mi cuenta de Mercado Pago, según mis finanzas?", ELISE
answered with October's income, expenses and net, then said it didn't include an opening balance.
Finance had no notion of an account's balance: the model only had `finance.getSummary`, which
answers a period's cash flow. Accounts had no starting point either, so even a correct sum of
movements could not be a balance.

## Decision

1. **Model (migration 059, additive).** `finance_accounts` gets:
   - `opening_balance numeric(20,4) not null default 0`. It may be negative (debt) and is always in
     the account's currency: a non-zero value needs one (constraint).
   - `opening_balance_date date`: the balance at the **start** of that day. Movements dated on or
     after it count; earlier ones are already inside it. Null means every movement counts.
   - `opening_balance_set_at timestamptz`: null until someone sets it. "0 because nobody said" is
     never presented as a known starting point.

   Existing accounts get 0 and no date, which is what they meant before. No balance is stored, so
   it can never disagree with the movements, and setting an opening balance never creates or
   edits a movement.
2. **One calculation, in the database.** `finance_account_balances(workspace, as_of)` is a
   `security invoker` SQL function, so RLS applies. It computes in exact decimals and returns text,
   one row per account and currency:
   - income adds to `account_id`, and expense subtracts from it;
   - a transfer subtracts `amount` from `account_id` and adds `to_amount` (ADR-089), or `amount`
     in the same currency, to `to_account_id`;
   - only completed, active (`archived_at is null`) movements count. Deleted movements and the
     sources of a combined movement are archived, so they never count twice;
   - pending movements are reported apart, and cancelled ones never count;
   - a movement in a currency other than the account's gets its own row. Nothing is ever
     converted.
3. **Tool:** `finance.getBalances` (read, no approval; native provider only). It takes an account
   name or all accounts, and an optional day. Several matching accounts are each returned with
   their name. The output carries provenance: "recorded balance calculated by ELISE", never the
   bank's live balance. It also says whether the opening balance was set, how many movements
   counted, and the last movement. `finance.createAccount` / `updateAccount` take
   `openingBalance` and `openingBalanceDate`, and follow the existing write policy.
4. **Same number everywhere.** The chat card (`finance_balances`), Finanzas › Cuentas (balance per
   account, opening balance and date in the edit form) and voice all read the same tool. The page
   refreshes through the existing `revalidatePath` after any Finance write.
5. **Guidance.** Balance questions go to `finance.getBalances`, never to `getSummary`. ELISE
   leads with the balance and says it is calculated from what is recorded. If no opening balance
   was set, it says the balance starts from 0 and offers to set it.

## Consequences

- Until migration 059 is applied, `getBalances` answers "needs the latest database update", and
  Cuentas shows no balances. Nothing else changes.
- Connected Google Sheets rows have no account link, so they aren't in account balances.
- Reconciling with a real bank balance is done by setting the opening balance (and its date). A
  separate "adjustment" movement type, with its own audit trail, wasn't added. That is the next
  step if people need a dated correction mid-history.
- Credit card accounts show what is owed as a negative balance.
