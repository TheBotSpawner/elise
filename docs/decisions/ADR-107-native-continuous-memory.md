# ADR-107: Native continuous memory

**Status:** Accepted (2026-10-21). Extends ADR-068 (Memory) and ADR-012 (Universal Recall). Migration `20261113000062_native_memory.sql`. Audit: `docs/engineering/ELISE_Memory_Audit_vs_Honcho_Report.md`. Implementation report: `docs/engineering/30-native-memory-implementation.md`.

## Context

ELISE's Memory (ADR-068) learned only when the model called `memory.remember` in a turn. Every turn received up to 60 facts, and inferences were presented as if the person had said them. Forgetting removed the current value but left its earlier versions in place. GPT-Live's direct answers and the Morning Brief never saw memory. Honcho was used as a benchmark only: no dependency is added.

## Decision

**Storage.** Facts move from one JSON array per person to `memory_facts` rows.

- Each row holds `category`, `provenance`, `certainty`, `sources`, `corroborations`, `observed_at`, `last_confirmed_at` and `extractor`.
- A unique active key per person enforces one current value.
- Earlier values are kept as `superseded`.
- Migration 062 copies the JSON with honest provenance, then deletes the JSON copy.
- Until the migration is applied, memory is read-only from the old copy.

**Provenance.** The values are:

| Value | Meaning |
|---|---|
| `user_explicit` | The person said it in a conversation. |
| `user_settings` | The person wrote it in Settings. |
| `tool_verified` | Read from their own data. |
| `inferred` | Concluded by ELISE. |
| `unknown` | Never invented. |

A value is replaced only by an equal or stronger source, so an inference never overwrites what the person said. Assistant text is never evidence.

**Context.**
- `selectContextFacts` picks what a turn uses:
  - every fact when there are eight or fewer;
  - otherwise up to 12 facts that share words with the message (each word weighted by how rare it is among the person's facts, ignoring matches under half the best one);
  - plus up to 6 standing preferences and constraints the person stated.
- Facts reach prompts with their source, certainty and date, as data and never as instructions.
- A short profile is included.
- The same `memoryForContext` contract serves chat, legacy voice and Desktop (one server), GPT-Live direct answers (stated facts and the profile only) and the Morning Brief.

**Learning (opt-in, off by default).** Learning reuses the Recall pipeline: it runs after the `recall-index` job, and a 15-minute sweep catches conversations that went quiet.

- **Consent:** `memory.learning` holds `{on, since}`. Nothing before `since` is read, so there is no backfill.
- **Run:** each run claims the interaction, then batches its new turns: at least 3 from the person, or 10 minutes of quiet.
- **Proposal:** a background model proposes candidates as structured output.
- **Gate (`validateCandidate`):** decides deterministically what may be kept. It rejects:
  - assistant-only, context-only, hypothetical, quoted or pasted evidence;
  - temporary items, secrets, sensitive attributes and instruction-like text;
  - "stated" facts that don't match the person's own words;
  - inferences below 0.7 confidence or with fewer than two turns of evidence.
- **Saving:** if learning was turned off during the run, nothing is saved. Facts are saved silently and listed under "Aprendido recientemente".
- **Rollout:** gated by `MEMORY_LEARNING=on`.

**Consolidation.** A daily job runs only for opted-in people whose facts changed.

- It retires duplicate or outdated inferences, never what the person said.
- It rebuilds a profile of up to 12 lines, each citing active facts.
- If the facts behind a profile line are forgotten, the line goes too.

**Reasoning.** `memory.reflect` gathers what the person said, what was inferred, how values changed, the profile, and Recall episodes. The turn's own model reasons over this evidence. There is no second vector store and no extra model call.

**Forgetting.** Forgetting a fact (by id or key) deletes every version of it and drops the profile lines that cite it.

- It leaves keyed HMAC fingerprints of the key, the value and its word roots, never the text, so the extractor won't learn it again.
- Episodes from `memory.reflect` that mention it are left out.
- Asking explicitly to remember it again lifts the block.
- Source conversations stay in History. The UI and the tool say so, and never delete conversations implicitly.
- Audit rows carry metadata only.

**Cost.** `memory_spend` is a ledger with `memory_reserve_spend`, which reserves atomically under a per-workspace lock, is idempotent per job and callable by the service role only, and `memory_settle_spend`.

- Hard monthly caps: `MEMORY_USER_MONTHLY_USD` (default 0.5) and an optional `MEMORY_WORKSPACE_MONTHLY_USD`.
- A model without a known price can't be budgeted, so learning fails closed. Prices come from `src/config/pricing.ts` or `AI_MODEL_PRICES`.
- Reading memory never costs anything and is never capped.

**Tools.**
- New: `memory.reflect` and `memory.stopLearning` (turning learning on is Settings-only, because it needs consent).
- `memory.list` now shows provenance.
- `memory.forget` reports that the source conversations remain.
- A "memory" tool-selection signal makes these tools reachable without `tools.more`.

## Consequences

- People who never opt in get the same explicit Memory as before, now relevance-limited and honestly labeled.
- Learning needs three settings in Vercel and Trigger.dev: `MEMORY_LEARNING=on`, a verified price for the background model, and migration 062 applied.
- Limits:
  - Suppression catches the same key, the same value or a rewording with mostly the same words. Different words or a translation aren't caught.
  - Relevance is lexical (stems, weighted by rarity), not semantic.
  - Cost caps are per calendar month in UTC. A single run may overshoot its estimate before reconciliation.
