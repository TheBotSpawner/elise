# ADR-016: Context Profiles, Study Mode and Client / Work Intelligence

**Status:** Accepted (2026-10-01)

## Context

ELISE can already read the user's email, calendar, tasks, Knowledge, Recall, structured
Notion data and the public web. It does not yet know which *area* of the user's life a
request belongs to. "Poneme al día con Client A", "tomame oral de Administración" and "¿qué le
debemos a Alex?" all need ELISE to know where that part of the user's world lives: which
Knowledge Space, which email domain, which task list, which people.

`docs/architecture/11` describes entities, active context and study/work context packages.
`16` §92 says not to create a universal context table "until real usage requires it", and
§98 leaves the study tables for when Study is implemented. This milestone is that usage. Study
and Work must not become separate agents: they are experiences on the same ELISE Core
(`11` §75-76, ADR-001).

## Decisions

### Context Profiles

1. **A Context Profile is an organizational layer, never a source of truth.** It has:
   - a kind (`study`, `client`, `project`, `work`, `custom`), a name, a description and aliases;
   - an icon, an accent and a status;
   - optional routing instructions;
   - for study, three optional fields: target date, objective and level.

   These live in `context_profiles`. The study fields are nullable columns rather than a
   separate table: they are three values, and only meaningful for `kind = study`.
2. **Context links point to existing resources; nothing is copied.** `context_links` holds one
   row per link. The link types are:
   - resource links: Knowledge Space or item, structured source, account (a provider
     connection), task list, ELISE list, note, person or organization;
   - value links: email domain, email address, web domain, calendar keyword, keyword.

   A database trigger checks that every resource link points to a record of the same
   workspace. Gmail stays Gmail and Tasks stay Tasks. A link only tells ELISE where to look.
3. **Context is never authorization.** A link changes what ELISE *searches first*. Every read
   still goes through the executor: binding resolution, permissions, RLS, policy and approvals.
   A context linked to an account the user has since disconnected simply finds nothing there.
   Context instructions are routing preferences. They're quoted to the model as data and can't
   change rules or policy.
4. **Deletion removes only the organizational layer.** Archiving keeps everything. Deleting a
   profile removes its links, its interaction associations and its study progress, and asks for
   explicit confirmation when study progress exists. Emails, tasks, Knowledge, Notion and
   calendar data are never touched.

### Resolution and the active context

5. **Resolution is deterministic and asks when unsure** (`11` §32-33). It matches, in order of
   strength:
   - an explicit switch phrase ("ahora hablemos de…", "volvamos a…", "switch to…");
   - the name;
   - aliases;
   - linked email addresses and domains;
   - linked people's names.

   One clear match activates the context. Two comparable matches are ambiguous, and ELISE
   asks. The model can also activate or clear a context with tools, for example when the
   visible Surfaces make it clear.
6. **The active context belongs to the interaction**, next to the active intent but separate
   from it. It is stored on the Live Workspace (`live_workspaces.context_profile_id`). It is
   ephemeral (`11` §8) and streamed to the browser like any other workspace operation.
   - Switching to another context clears the previous context's Surfaces. Pending approvals
     stay.
   - Clearing the context keeps the Surfaces.
   - A context nobody has touched for 6 turns decays away, so an old subject doesn't leak into
     unrelated requests.
   - Changing context never creates a new thread.
7. **The Context Builder gets a compact representation.** That means the name, kind, aliases,
   source hints and instructions, plus the names of the other profiles. It never gets the linked
   data. Tools use the links to decide where to retrieve:
   - Knowledge searches the linked Spaces first;
   - Recall searches the context's interactions first, then everything if nothing is found;
   - Meeting Prep and the work brief scope email, tasks, calendar and the web to the links.
8. **Recall association.** An interaction is associated with a context only when that is
   known: the context was activated in it, a study session ran in it, or Meeting Prep
   recognized it. These rows live in `context_interactions`. There is no retroactive labelling
   by weak inference. The Recall search RPC takes an optional context filter.

### Entities

9. **A lightweight `entities` table for people and organizations.** It holds a name, aliases,
   emails, domains and an optional organization, as `11` §28-29 and `16` §30 describe.
   - Aliases, emails and domains are arrays on the row instead of separate alias tables. Lookup
     is by exact email or domain first, then by name.
   - An email belongs to at most one active entity, which a trigger enforces.
   - Entities are created only from confirmed context creation (the people the user ticked)
     or by explicit request. Two people called "Chris" stay two entities, and a first-name
     match among several people is reported as ambiguous.
   - There is no merge UI yet; merging is a future, explicit action.

### Study

10. **Study is a thin orchestration over Knowledge, the Live Workspace and Voice.** A study
    session belongs to a user, a workspace and a study profile. Its mode is `review`,
    `oral_exam` or `quiz`. Its scope (Spaces, documents, units, topics) is resolved *before* it
    starts. When the material doesn't cover the requested scope, ELISE says so and offers what
    exists.
11. **Questions come from the user's material.** Concepts are discovered from the scope's
    passages by AI, with labels and references back to Knowledge items and chunks, at most 12
    per discovery and never thousands. Each question is generated by AI from one concept's
    evidence and stored server-side with its key points and three progressive hints:
    category, then relationship, then partial structure.
12. **No answer leakage.** The question Surface, the main model and the voice reply get only
    the question. The key points, hints and evidence stay in the session row until the user
    answers, asks for a hint or asks for the source.
13. **Evaluation is AI-assisted against the evidence, and progress is deterministic.**
    - The evaluator returns `strong`, `partial` or `needs_review`, with what was correct, what
      was missing, what was incorrect and the source references. There are no percentages.
    - Each concept keeps a small integer score and a status: not reviewed, learning,
      understood or needs review.
    - The next concept is chosen deterministically: weak concepts come back later from another
      angle, understood ones are repeated less, and the same concept is never asked twice in a
      row.
14. **Persistence.** Sessions, concepts and attempts are stored, private to their author (RLS).
    A session's summary covers what was covered, strong areas, areas to review, important
    mistakes and the next review. Session preferences ("don't correct me until the end", "be
    strict") belong to the session and never become permanent preferences.

### Client / Work Intelligence

15. **`work.brief` is an orchestration like Meeting Prep** (ADR-013 §12). It resolves the
    context, chooses a baseline, then gathers through the executor in parallel: email, meetings,
    tasks, Knowledge (with recent changes), Recall, linked structured sources and, when asked,
    the web. Every source is bounded, and a failing source becomes a marked gap, never a failed
    brief.
    - **Baseline**, in order: the date the user gave, then the last associated interaction,
      then the last related meeting, then a 14-day window, said as such.
    - **Commitments** are quoted sentences from email snippets, Recall excerpts and tasks, with
      their source and direction (ours, theirs, waiting). They're found by deterministic
      patterns, never generated. Nothing becomes a task unless the user asks; then the normal
      Tasks tool runs.
    - **The timeline** is derived from source metadata on each request. No timeline table.
    - Internal and external evidence stay separate in the output and in the Surfaces.
16. **Meeting Prep recognizes the context.** It matches attendee emails and domains, the
    linked people and the title against profiles. One clear match scopes Knowledge, Recall,
    email, tasks and the web to that context, and activates it.
17. **The Morning Brief's "Today's focus"** lists only contexts with a concrete signal today:
    - a meeting;
    - an open task due or overdue in a linked list or matching the context;
    - an email needing a reply from a linked domain;
    - an exam within 3 days or concepts needing review.

    It's computed from data the brief already gathers, plus study progress.

### Surfaces

18. **New Surface types** are `context_overview`, `context_proposal`, `commitments`,
    `timeline`, `study_question`, `study_progress` and `study_summary`. Email, meetings, tasks,
    Recall, Knowledge, web and summaries reuse the existing types. Direct actions (hint, next
    question, reveal source, end session, create task, create context) resolve to one tool call
    built from the Surface's own stored payload and run through the executor.

## Consequences

- Study and Work are ordinary tools, so Voice, Recall, the Live Workspace and approvals work
  with them without special cases. Future contexts (travel, health, a job search) are a new
  profile kind, not new infrastructure.
- Resolution by names, aliases and domains is predictable but literal. Misspellings and new
  nicknames need an alias or the model's own `contexts.activate`.
- Study evaluation costs one extra AI call per answer, and question generation one per
  question. Both use the fast tier.
- People live as rows with arrays. If merging, splitting and relationship types grow,
  `entity_aliases` and `entity_relationships` (`16` §31-32) can be extracted later without
  changing the tools.
