# ADR-020: Untyped Sections and History organized by Knowledge

**Status:** Accepted (2026-10-04). Refines ADR-018 (Sections) and ADR-016 (Context Profiles):
the Section purpose is removed; context intelligence is unchanged.

## Context

Creating a Section asked "What will you use this Section for?" (Study / Client / Project /
General). A Section can be all of those at once, and the choice gated features (Study only
on `kind = study`, enforced by a database trigger). History had its own flat list, unrelated
to the Spaces and Sections the user already organizes Knowledge with.

## Decision

1. **Sections are untyped.** The dialog asks for a name, an icon and colour, and an optional
   description. New Sections get `kind = 'custom'`; the column stays as internal metadata for
   older contexts. Intent decides what runs: "quiz me on this" studies any context with
   material, "catch me up" runs Work Intelligence on any context. The `check_study_row`
   trigger now only requires a context of the same workspace. Untyped contexts show no type
   label anywhere.
2. **History links.** `interaction_knowledge_links` relates a History thread — a conversation
   (typed) or an interaction session (voice), the same `ThreadRef` the app uses — to a
   `knowledge_spaces` row (a Space or a Section). Structured ids, so renames show everywhere;
   `source` automatic/manual; `state` linked/removed (a removal is a tombstone). Same-workspace
   and same-author triggers plus RLS; a link organizes, it never grants access. Archived
   Spaces keep their links (shown subtly); a deleted Space takes its links with it.
3. **Automatic tagging** runs after each completed turn (not per token), deterministic and
   conservative (`core/history/links.ts`): the active Section, the Space a conversation started
   in, Knowledge used in two turns (or three passages in one), or an exact name said in two
   user turns. Threshold 0.7, at most three automatic links. A single mention or a substring
   ("math" for "Mathematics") never links. It never touches an existing link and never re-adds
   a removed one unless the user explicitly enters that Section again afterwards.
4. **Manual control**: a Tags dialog per History row; chat tools `history.addKnowledgeLink`,
   `history.removeKnowledgeLink`, `history.listKnowledgeLinks`.
5. **History UI**: one list of typed and voice conversations (voice marked), up to two chips
   (+N), Space filter (chips while ≤ 5 Spaces, else a select; "Without a Space"), Section
   filter, Group by None/Space/Section (collapsible), Sort Newest/Oldest. Search matches the
   Recall index, titles/summaries and Space/Section names. Titles come from the Recall summary,
   else a cleaned first message (greetings and politeness dropped).
6. **Recall**: `search_recall_chunks(p_spaces)` scopes to linked threads. `history.search`
   searches the named or active Section first, then its Space and sibling Sections, then the
   context's interactions, then everything.
7. **Knowledge pages** show the Section's related conversations and the Space's recent ones
   from the same links.
8. **Backfill** (migration 23, idempotent): only existing high-confidence evidence — context
   activations, study and meeting associations of Sections. Older threads stay untagged and get
   tagged when they are used again.

## Consequences

- Migration `20261004000023_history_knowledge_links.sql` is additive.
- Knowledge citations recorded before this change carry no Space id, so they don't count as
  evidence; conversations get tagged going forward.
- Grouping shows a thread in every group it belongs to.
