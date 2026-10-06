# ADR-047: General Knowledge

**Status:** Accepted (2026-10-06). Builds on ADR-018/020 (Spaces and Sections), ADR-035
(Knowledge administration), ADR-040 (Methods) and ADR-046 (federated sources). Migration
`20261017000036_general_knowledge.sql`.

## Context

Some context, sources and Methods belong to no single area: how the user plans a day, writes,
decides; a personal handbook. Methods already had a workspace-wide scope (`space_id = null`,
"global"), but there was no visible, editable place for that layer, and nothing for context or
sources.

## Decision

**One system Space per workspace.** `knowledge_spaces.kind` is `standard` or `general`; a partial
unique index allows one `general` per workspace. Identity is `kind`, never the name: a user Space
called "General" or "General Knowledge" stays `standard`. New workspaces get it from an
`after insert` trigger on `workspaces`; existing ones were backfilled idempotently. Default look:
`sparkles`, cyan; description "Contexto y formas de trabajar que ELISE usa en todos tus espacios."
It starts empty — nothing inferred.

**Invariants, in the database** (`protect_general_knowledge`, for every writer including the
service role) **and the application** (`generalKnowledgeProtected`):

- it can't be renamed, archived/deleted, or moved under another Space;
- no Space becomes General, and General never stops being it.

Everything else is ordinary: description, context, look, Sections, uploads, external live sources
(ADR-046 applies unchanged), Methods. The chat tools refuse rename/archive in `describe()`, so an
impossible operation fails with its reason before any approval is proposed; ELISE says it
naturally and offers to change the content instead. In the UI the "…" (archive) action isn't
offered and the name field is read-only in Edit; no warnings otherwise.

**Methods.** General Knowledge's Methods *are* the workspace-wide Methods: stored with
`space_id = null` (a trigger normalizes a write that names the General Space's id; the tools map
"General Knowledge" to it). So selection is unchanged and deterministic: Section > Space > General
(ADR-040 §2.3), contradictory Methods are never merged. "Métodos generales" are labelled General
Knowledge. Placement is the model's semantic choice, guided per turn: the narrowest scope that
represents the intention; cross-domain wording ("siempre", "en general", "cada vez que", "para
cualquier proyecto", "sin importar el espacio", "guardalo como método general") is a strong
signal for General, not a keyword rule. "Guardalo como método" is now a durable teaching signal.
The default scope of a new Method is the conversation's Space/Section, General when there is none.

**Context precedence.** General's context joins a turn as the least specific note
(`general="true"`) with the rule "Section, then its Space, then General Knowledge". It is included
when no Space is active (it is the default scope then) and, inside a Space, only when the message
shares terms with it (`generalContextApplies`) — never the whole of General in every turn.

**Retrieval.** Inside a Space or Section, `knowledge.search` adds General to the inherited tier
(after the Section and its Space, with the inherited weight). With no Space active, all Knowledge
is searched (General included); a request naming another Space is routed there as before.

**Not memory, not settings.** Recall stays separate and nothing inferred is copied into General;
ELISE may only save it when the user asks. Timezone, language, theme and notifications stay in
Settings; the teaching guidance says so.

## Consequences

- Every workspace shows General Knowledge first in Knowledge; onboarding and first-run prompts
  ignore it when looking for the user's own Spaces.
- The relevance gate for General's context is lexical; a General context that shares no words with
  the request isn't added inside a Space (Methods and `knowledge.search` still reach it).
- Deleting a workspace still cascades to its General Space (deletes are not blocked).
