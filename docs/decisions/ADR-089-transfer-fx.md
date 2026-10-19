# ADR-089: Transfers between currencies

**Status:** Accepted (2026-10-19). Extends ADR-052 (transfers).

## Decision

- **Model (migration 056):** a transfer keeps what left (`amount`, `currency`) and, when the
  destination is in another currency, what arrived (`to_amount`, `to_currency`). A database
  constraint enforces it: both or neither, only on transfers, and never in the same currency.
- **The rate is derived, never stored:** `impliedRate` computes it from the two amounts, exactly
  (8 decimals, no floats). It reads the readable way round ("1 USD = 1280 ARS", never "1 ARS =
  0.00078 USD"), so the amounts and the rate can never disagree.
- **Form:**
  - Choosing a destination account with another currency shows "Recibido" (amount and currency).
    "Llega en otra moneda" / "Llega en la misma moneda" switch it by hand.
  - "Tipo de cambio" follows from the two amounts. Editing it recomputes what arrived, from what
    left.
  - The movement's detail shows what arrived and the rate. The row reads "Wise → Mercado Pago
    (ARS 128.000)".
- **Chat:** `finance.createTransaction` and `finance.updateTransaction` take `toAmount` and
  `toCurrency` ("mandé 100 dólares y me llegaron 128.000 pesos").
- Transfers still never count as income or expense. ELISE keeps no account balances, so nothing
  else changes.
- **Rollout:** without migration 056 the provider reports no received side, and saving one says
  the database needs its update.
