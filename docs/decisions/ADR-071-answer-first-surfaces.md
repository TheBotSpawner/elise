# ADR-071: Answer first, source second (the `answer` Surface and `ui.answer`)

**Status:** Accepted (2026-10-16). Refines ADR-013 (Surfaces from results), ADR-048
(presentation discipline) and ADR-028 (representation hints).

## Context

- Asked "¿Cuáles son los principales competidores de Firbot?", ELISE found the right documents,
  but the Canvas showed a Knowledge card with their passages. The answer itself, the competitor
  map, was only in the prose.
- **Root cause:** presentation was coupled to retrieval. `from-results` turns every tool result
  into its source Surface deterministically, so `knowledge.search` became `knowledge_result` or
  `knowledge_source`, and web searches became `web_results`. Nothing stood between the evidence
  and what was drawn. The model could add a `summary` (sections of bullets), but the document
  stayed the lead, and nothing kept provenance per item.
- In the chat, each search added a generic chip ("Conocimiento · En el espacio de trabajo"),
  twice for two searches, without saying which documents.

## Decision

1. **Evidence ≠ presentation.** Retrieval Surfaces stay what they are: the source, shown when the
   source is what the user wants. A new layer, the **answer**, holds what the user asked for.
2. **`answer` Surface** (`core/workspace/registry.ts`):
   - It is one flexible family, not a widget per domain. Its intents are `list`, `entities`,
     `ranking`, `comparison`, `metrics`, `checklist` and `summary`.
   - It holds a title, an optional one-line summary, and items (title, short description, a
     textual badge, group, value, rank, comparison cells), metrics and columns.
   - Every item and metric carries `sources`, which are indexes into the Surface's `sources`
     list: title, link, kind (knowledge, web, recall) and Space.
   - It has a bounded vocabulary: no HTML, styles or layout from the model.
   - Priority is 90, so it leads above its evidence and below approvals. Size depends on shape:
     comparison is large, figures only are small, more than 8 items are large, and the rest
     medium.
3. **`ui.answer`** (`core/tools/answer.ts`):
   - The model calls it in the same response as its words. The runtime already ends a turn
     whose only calls are `ui.*`, so it costs no extra model call.
   - ELISE resolves every cited source to something on screen: `[n]` to the newest Knowledge
     search's document, a Surface handle, or a URL found in a visible result. An unknown source
     is refused.
   - Every figure (value, comparison cell or metric with a digit) must cite a resolved source.
     *Ceiling:* Surfaces keep only excerpts, so a figure is grounded by citation, not by
     matching text. The prompt forbids invented figures.
   - The evidence Surfaces it cites step back (they are dismissed). Their documents stay listed
     in the answer's **Fuentes · N**, and the chat chip re-presents them from history.
     `keepSources` keeps the document beside the answer, for "¿qué dice este documento?".
   - Comparisons need 2 to 6 criteria and a cell per option. Rankings number themselves.
4. **Policy** (`WORKSPACE_GUIDANCE`, plus `ANSWER_HINT` appended to `knowledge.search` and
   `web.search` results, the same way `TEMPORAL_HINT` is):
   - Answer first, source second.
   - Keep the source's own distinctions as badges, for example a direct competitor versus a
     reference.
   - The source is the answer only when the user asks for it ("abrime el documento", "¿de dónde
     sacaste eso?").
   - Emails, events, tasks, lists, finance, habits and goals already show as themselves. Dates
     go to `ui.timeline` and figures over time or shares go to `ui.visualize`. A single fact or
     "solo decímelo" gets no answer Surface.
   - Voice explains and the screen organizes: the model never reads the items one by one.
5. **Rendering** (`features/workspace/answer-view.tsx`):
   - Groups appear in the order given. Badges are words, never color alone.
   - Rankings show numbers and values; metrics show tiles; checklists show markers.
   - Each item has quiet source numbers.
   - The first 8 rows show, then "Ver todos (N)", plus "N de M" when the answer is partial.
   - Comparisons are a table only on a large canvas; narrow canvases and phones get one card
     per option.
   - "Fuentes · N" is a collapsed `<details>` whose links open the exact document (internal) or
     page (new tab).
6. **Chat chips** (`features/chat/message-thread.tsx`): retrieval calls (`knowledge.search`,
   `history.search`, `web.*`) become one **Fuentes · N** chip. Expanding it lists the documents
   by name and Space, other retrievals by kind, and "Mostrar en el espacio de trabajo".

## Consequences

- A question answered from documents shows the answer. Validated for real:
  - **Competitors:** 7 items. CenteIA is labelled "Competidor directo" or "Competidor más
    cercano"; the others are "Referente parcial" or "Referente de contenido y posicionamiento".
    The report is behind "Fuentes · 1".
  - **"Abrime el informe":** brings back the `knowledge_source` Surface.
  - **Phone:** the same answer, with no sideways scroll.
- Source-type Surfaces are unchanged. No migration was needed: Surfaces are stored as JSON in
  `live_workspaces`.
- **Not built:**
  - per-item passage excerpts (an item links to its document, not to the passage);
  - an answer Surface while results stream in (the evidence shows first and is replaced, the
    same way `ui.timeline` replaces it);
  - figures checked against full passage text.
