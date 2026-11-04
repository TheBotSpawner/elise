# ADR-138: cost per account and budget limits

**Status:** Accepted (2026-11-04), Phase 1. Extends ADR-019 and ADR-068. Everything ships in observe
mode: nothing is blocked until the owner turns it on. Details and the rollout checklist are in
`docs/engineering/38-cost-accounting.md`.

## Context

Before setting prices, ELISE must know what each account really costs and be able to stop an account
from costing too much. `usage_events` (ADR-019) already records paid calls, but one month of real data
showed its costs can't be trusted: 57 % of the calls on the default model had no price, ElevenLabs was
estimated at less than half its list price, a hosted search's fee was lost, a cut stream left no trace,
and nothing could limit anything.

## Decision

1. **One ledger.** `usage_events` stays the record of what was spent; there is no second accounting.
   It gains cost status, price version, an idempotency key and the amount budgets count. It's immutable
   for every API role, the server's included; corrections are `adjustment` rows.
2. **Costs are stored, never recomputed.** Each event keeps its cost and `price_version`, so a new price
   can't change history. Prices live in versioned code (`config/pricing.ts`), not a table: they change
   rarely, and an unverified price is `unknown`, never guessed. A deploy can add models through
   `AI_MODEL_PRICES`.
3. **Unknown is never free.** A succeeded call with no price counts against budgets at a deliberately
   high stand-in, and stays out of every margin conclusion.
4. **Counters follow the ledger.** A database trigger moves each event's amount into `budget_counters`,
   whatever wrote it, so they can't drift from it.
5. **One atomic gate per interaction.** `reserve_budget` decides before spending: membership, plan,
   trial end, and every limit, with rows locked in sorted order. Identity comes from the verified
   session. A job has no person and answers to the workspace's owner. Single voice calls ask once per
   30 s per instance, so no sentence waits for the database; the overshoot is cents at most.
6. **A safety net in every adapter.** Each paid adapter checks that its scope passed the gate. A path
   nobody wired is logged in shadow and refused when enforcing: forgetting a route can't make it
   unlimited.
7. **Three modes.** `ELISE_BUDGET_MODE`: observe (default), shadow, enforced, or enforced for chosen
   workspaces. Anything unreadable means observe. If the gate fails while enforcing it refuses, or
   allows five chat turns an hour if configured; it never allows everything.
8. **A refused job still runs**, in a scope the adapters reject: paid calls fail through its usual
   error path, recorded. No run is left hanging and no retry can spend.
9. **Plans are data, off by default.** `budget_plans` holds limits as hypotheses for review. No plan
   means refused, never unlimited: the owner needs an explicit `internal` row before enforcing. The beta
   counts 90 days from activation, once per invitation and identity, and never renews or charges.
10. **People see levels, not money.** Settings shows 70, 90 and 100 %. Costs, balances and plans are
    server-only, reads included.
11. **Invoices stay apart.** `provider_invoices` holds what a provider charged. Reconciling never
    rewrites an event.

`core/entitlements.ts` stays what it was: which features exist. Budgets are how much.

## Consequences

- One additive migration (070), prepared and tested, not applied. The recorder keeps working if code
  ships first: it falls back to the old columns.
- Shadow and enforcing add one database call per turn, in parallel with the turn's existing reads.
- A turn's reservation is held until it ends; a crash gives it back after 10 minutes.
- GPT-Live is billed straight from the browser, so only its start is gated. It's off (declined by the
  owner), and its client-reported seconds stay out of the ledger on purpose.
- The Desktop/Web label comes from a header anyone can send: it's a report label, never a permission.
- Beta activation has no screen or route yet: it's the `activate_beta` function, until the beta opens.
