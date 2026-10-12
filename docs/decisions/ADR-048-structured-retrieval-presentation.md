# ADR-048: Structured database retrieval and Canvas presentation discipline

**Status:** Accepted (2026-10-12). Refines ADR-011 (Structured Notion), ADR-013/029 (Surfaces)
and ADR-046 (federated Knowledge).

## Context: the failed turn

"ELIS, consultá mi base de oportunidades en Notion y quiero que me analices cómo está la
situación en este momento en Firbot." (run `25d98112…`, 2026-10-06):

- `structured.listSources` returned nothing: no database was *mapped*, and Structured only knew
  mapped databases. Its guidance wasn't even in the prompt without one.
- The model fell back to `work.brief` (failed) and three `knowledge.search` calls (~10 s, 2.5 s,
  2.6 s: live Notion + embeddings each), every one auto-presented as a document Surface from
  Firbot Marketing/Solutions.
- Its last step called `ui.visualize` + `ui.timeline`, which failed; that was the 6th model call
  (`maxModelTurns: 6`). The runtime then threw its step-limit error, coded `RATE_LIMITED`, whose
  copy is "Demasiados pedidos". It was not a Notion 429.

## Decision

1. **Explicit database requests go to the database.** `explicitStructured(message)` (database,
   CRM, pipeline, "base de X", records… and not page/document words) removes `knowledge.search`
   from the turn's first tool set (still loadable with `tools.more` for an intentional
   supplement) and adds a per-turn instruction. Structured guidance is always present when the
   capability is; it says the explicit source wins over the conversation's Space.
2. **Any shared database is readable, live, read-only.** When no mapped source matches, the
   Notion provider resolves the name among the data sources shared with ELISE
   (`matchSourceNames`: exact → normalized without generic words → word cover; only a real tie
   asks). Its fields come from the live schema through the same rules as a proposed mapping.
   Writing still needs a confirmed mapping (ADR-011). Shared-source names and schemas are cached
   10 minutes per connection; records never are.
3. **`structured.analyze`.** One call reads the database live in batches of 100 (bounded at 1,000,
   reported partial beyond), then `analyzeRecords` computes deterministically: totals,
   open/won/lost/dormant, by stage in the schema's order, value per state (one number property;
   no cross-currency sums), overdue / closing within 30 days, stale (30+ days without edits),
   missing data, by company, and an attention list. Fields are found by type and the database's
   own names (Etapa, Valor estimado, Fecha estimada de cierre…). `scope: "open"` and
   `rank: value | close` serve the follow-ups.
4. **Notion request discipline** (`NotionHttp`, shared by Knowledge and Structured): per
   connection at most 3 requests in flight, starts spaced 340 ms; identical reads in flight are
   shared; reads retry at most twice after 429/529, honoring Retry-After (≤ 10 s) else 1 s, 2 s;
   writes never retry. Counters are logged per batch read (`structured.read_all`).
5. **Tool call ≠ Surface** (`core/workspace/presentation.ts`): source/schema lookups never become
   Surfaces; a repeated search in a turn replaces its earlier result; an analysis replaces the
   turn's document searches; a turn adds at most 4 Surfaces (approvals always show). A failed
   turn withdraws the searches it showed.
6. **One analytical object.** A `structured_analysis` result becomes ≤ 3 visualization Surfaces
   (KPI summary, stages bar, attention table) with stable ids
   `structured-analysis:<source>:<role>`, so follow-ups update them instead of adding cards.
7. **The last step answers.** On its last allowed model call the runtime exposes no tools and
   asks for an answer from what was read; a long chain no longer ends in a misleading error.

## Measured (real Oportunidades, read-only)

Resolved without asking; 14 records in 1 page; 3.7 s first call (shared-source list + schema +
1 query = 3 Notion requests), 1.3–1.9 s for follow-ups (1 request each, structure cached). The
failed turn made 3 live Knowledge rounds (each several Notion requests and an embedding call)
and 6 model calls; the new path is 1 analysis call.

## Not built

- A skeleton "Analizando…" Surface (the Orb/intent already signal progress).
- Collapsing repeated steps in the "N pasos" trace beyond what the policy prevents.
- Currency detection from Notion's number format (the value is reported in the property's units).
