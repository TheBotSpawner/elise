# ADR-018: Knowledge Sections (Space › Section)

**Status:** Accepted (2026-10-02). Refines the product representation of ADR-016 (Context
Profiles) and ADR-007 (Knowledge Spaces); the intelligence of ADR-016 is unchanged.

## Context

ADR-016 introduced Context Profiles (a subject, a client, a project) managed under My Elise ›
Contexts, linked to Knowledge Spaces and other sources. Knowledge already supported nested
Spaces ("New Space inside", hidden in the Space settings). Users had to create a Space and then,
separately, a Context, and understand how the two related. Two concepts competed for "a part of
my world".

## Decision

1. **Product model.** Users see Knowledge **Spaces** and, inside each, **Sections** (Espacio ›
   Sección): "University › Mathematics", "Acme Studio › Client A". "Contexts" is no longer a
   user-facing module: it leaves the My Elise page and navigation.
2. **One visible level.** A Section is a first-level child Space (`knowledge_spaces.parent_space_id`,
   the existing hierarchy, no new table). The UI and the server actions only create Sections
   under a top-level Space and only move a Space without Sections under one. The database still
   allows deeper rows (older data keeps working); nothing exposes them as sub-sections.
3. **1:1 intelligence.** Each Section has one Context Profile:
   `context_profiles.knowledge_space_id` (unique, same-workspace trigger, `on delete set null`).
   The Space is the source of truth for name, description and appearance; the profile follows
   (`updateSpace` keeps them in step). The profile holds what the Section knows: purpose (kind),
   links (email domains, people, task lists, Notion, websites…), routing preferences, study
   details and progress. Creating a Section creates both in one step; archiving a Space archives
   its Sections' profiles (kept, restorable).
4. **Purpose.** "What will you use this section for?" — Study / Client / Project / General — maps
   onto the existing kinds (`study`, `client`, `project`, `custom`). Study and Client Work
   Intelligence attach to the Section through that profile, unchanged.
5. **Identity.** A Section's identity includes its Space. Standalone profile names stay unique
   per workspace; Section profiles are unique by Section, so "University › Mathematics" and
   "Posgrado › Administración" coexist. Everywhere a context is shown (active indicator, prompts,
   errors) it reads "Space › Section". Resolution treats two same-named Sections as ambiguous
   (ELISE asks) unless the Space is named ("Mathematics de University"); tools accept the path.
6. **Inheritance at retrieval time.** Nothing is copied. A Section's search covers its own
   sources (primary) plus its parent Space's own general sources (inherited, weight 0.85) — never
   sibling Sections. A top-level Space's search covers its general sources and its Sections, and
   relevance decides what is used; results name the Section they come from. Listing and study
   material (what a session covers) use the primary scope only.
7. **Activation.** "Ask ELISE" from a Section starts the conversation in that Section's context;
   from a Space it scopes Knowledge to the Space only. Verbal switching ("Volvamos a
   Administración") resolves Sections like any context.
8. **ELISE creating Sections.** `contexts.propose` / `contexts.create` accept the top-level
   `space` it belongs in; then the context is created as a Section there. Without a Space it is a
   standalone context (still fully functional).
9. **Moving documents.** An uploaded document can move between a Space and its Sections (its item
   and passages change `space_id`/`source_id`; storage is untouched). Synced items (Drive,
   Notion) belong to their source and don't move alone.

## Migration and transition

Migration `20261002000021_knowledge_sections.sql` adds the column, the indexes and the trigger,
and attaches a standalone profile to a Section only when it is unambiguous: its only confirmed
Knowledge Space link points at an active Section with the same name, and no other profile claims
that Section. Everything else stays a standalone profile — still resolved by name and used by
every tool — and is adopted automatically when the user creates a Section with the same name.
Standalone profiles remain reachable at `/my-elise/contexts` (not in the navigation);
`/my-elise/contexts/<id>` of a Section redirects to the Section. No links, people, study
progress, Recall associations or active contexts are deleted.

## Consequences

- One concept for users; Context Profiles remain the internal intelligence layer.
- Older Spaces nested more than one level keep working but aren't promoted as sub-sections.
- A Space moved under another becomes a General Section (its context is created on move).
- Recents inside a Section are its own documents; study sessions and client events stay where
  they already appear (Study progress in the Section's context block, Recall, Home).
