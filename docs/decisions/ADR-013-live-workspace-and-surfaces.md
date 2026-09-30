# ADR-013: Live Workspace and contextual Surfaces

**Status:** Accepted (2026-09-30)

## Context

ELISE should gather what the user needs around their intent instead of making them pick a
module, conversation or app. "Prepare me for my meeting" should bring the meeting, the related
email, the last decisions, the documents and the open tasks into view, on Home, while the
conversation continues.

The docs require chat to stay the main element on Home (`docs/product/04` §4). They also say
Home must not become a dashboard of widgets (`05` §14), that "ELISE prepares, the user decides
when to consume" (`04` §5), and that meeting prep is P0 (`03`, CAL-006). Until now, no doc
defined a "surface" or a runtime-to-UI contract for structured results. This ADR defines both.

## Decisions

### Model

1. **The Live Workspace belongs to an interaction.** One workspace per conversation or
   interaction session holds:
   - the active intent;
   - a few Surfaces;
   - which Surface is focused;
   - a version and a turn counter.

   It is ephemeral. It is saved in `live_workspaces` so it survives a refresh, navigating
   away and a reconnect. A row expires 12 hours after its last change and is deleted when its
   conversation is deleted. Arrangement history is never kept.
2. **A Surface is a canonical, framework-free model** (`src/core/workspace`). Its fields are:
   - `id`, a stable, deterministic key;
   - `handle` (S1, S2…), which the model uses to refer to it;
   - `type`, `title`, `state` (loading, ready, attention, error or stale) and `priority`;
   - `size` (micro, small, medium, large or expanded);
   - `source`, the capability and account it came from;
   - `ref`, the canonical resource it points to;
   - `payload`, a small validated snapshot;
   - `actions`, `intentId`, `transient`, and timestamps.
3. **The Surface registry** maps each type to its payload schema, allowed sizes, default size
   and priority, supported actions, and a compact description for the model. The UI maps the
   same types to renderers. The model never references components.

   The initial types are:
   - `meeting` and `calendar_event`;
   - `email_thread` and `email_list`;
   - `knowledge_source`, `knowledge_result` and `document`;
   - `recall`;
   - `task_list` and `task`;
   - `person`, only from meeting participants, since no entity system exists yet;
   - `links`, `schedule`, `settings` and `approval`;
   - `summary`;
   - `result`, a wrapper that renders any other existing tool result with its existing card.

   Every payload is validated on write and again on restore. An invalid Surface is dropped.
4. **Payloads are snapshots, not copies of domain data.** Each Surface keeps a `ref` to the
   real resource (event, thread, task, knowledge item, interaction) plus the few fields needed
   to render it. Lists are capped, and email thread bodies are never stored. Opening a
   Surface loads fresh detail through the normal tool path. Anything the snapshot doesn't
   hold is fetched when needed.

### Who does what

5. **The application presents results automatically.** Every tool result becomes Surfaces
   through the registry's deterministic mapping, and an approval becomes an `approval`
   Surface. The model never has to "draw" a result it fetched.
6. **Presentation tools** (capability `workspace`, internal, presentation only) are
   `ui.listSurfaces`, `ui.present`, `ui.update`, `ui.focus`, `ui.dismiss` and `ui.clear`.
   - `ui.present` accepts only `summary` (structured sections: facts, context, suggestions)
     and `links`.
   - A link must already appear in the workspace's own data (event, email or evidence). The
     model can't introduce URLs.
   - The model decides what deserves attention (focus, dismiss, summarize). It never decides
     HTML, CSS, components, authorization or data access.
7. **Surface actions use the same paths as conversation.**
   - Direct actions, such as completing a task, reverting an accent or resuming a schedule,
     are built on the server from the registry and the Surface payload. They run through
     `executeToolCall` with origin `user_ui`, under the same policy and approvals.
   - Conversational actions, such as summarizing or drafting a reply, send a normal chat
     message.
   - Links are limited to `https:` or internal paths.
   - Showing a Surface never grants authority.

### Lifecycle

8. **Lifecycle is deterministic and owned by the application, not the model.**
   - A primary orchestration, such as meeting prep, begins a new intent. That clears the
     previous intent's Surfaces, except pending approvals.
   - Other results join the current intent. If there is none, an intent is inferred from the
     tool's capability, with the user's message as its description.
   - At most 6 Surfaces are visible. Beyond that, the lowest-priority, least recently used
     Surface is removed.
   - A Surface not presented, updated or focused in the last 4 user turns decays away at the
     start of the next turn.
   - Transient Surfaces (settings confirmations) appear by the composer, disappear after a
     few seconds and are never restored after a reload.
   - On restore, snapshots older than 15 minutes are marked `stale`.
9. **Intents are lightweight.** The kinds are `meeting_prep`, `research`, `recall`,
   `planning`, `communication`, `settings` and `general`, each with a natural-language
   description. `settings` is transient: it never replaces the current intent.

### Runtime and UI

10. **Streaming reuses the chat NDJSON stream.** It adds two events:
    - `workspace`, with ops (present, update, focus, dismiss, clear, intent) that the client
      applies with the same pure reducer;
    - nested activity steps for orchestrations.

    The server saves after every step. Changes from elsewhere (another tab, approvals
    decided in the Approval Center, background jobs) arrive through Supabase Realtime on
    `live_workspaces` and `approvals`. The newer version wins.
11. **Deictic context.** The context builder includes a compact digest of the visible
    Surfaces: their handles, titles and item ids, never full payloads. "The second email" and
    "those tasks" then resolve without asking.
12. **Meeting prep is an orchestration, not an agent.** `meeting.prepare` resolves the event
    deterministically (id, time, participant or title words; otherwise the next meeting). If
    the match is ambiguous, it asks.

    It then runs read-only sub-calls through the normal executor, in parallel: email per
    participant, Recall, Knowledge and tasks. It gathers links and presents Surfaces as each
    source returns.

    It hands the model organized facts and untrusted retrieved context. The model writes the
    brief with `ui.present summary`, keeping facts, retrieved context and ELISE's suggestions
    separate. A failed source is reported and never discards the rest.
13. **Layout.**
    - Desktop: the conversation keeps its own column and stays primary. Surfaces sit in a
      side pane as a primary Surface plus sparse supporting Surfaces. Expanding a Surface
      happens inside the pane.
    - Mobile: the workspace stacks after the conversation, with the primary Surface first,
      supporting Surfaces in a horizontal row, and expansion as a sheet.
    - With no Surfaces, Home and Chat look exactly as before.
    - The tool trace is the activity indicator, with human labels ("Searching your
      knowledge"), never tool names.

## Consequences

- Home gains a split layout only while an intent has Surfaces, so an idle Home is unchanged.
- Old conversations without a workspace keep their inline cards. New turns show chips in the
  thread that point to their Surfaces.
- Background jobs update Surfaces by resource ref (`markResourceSurfaces`). The first user is
  approved Structured bulk changes.
- Person Surfaces stay minimal until an entity system exists.
