# ADR-012: Universal Recall and ELISE Self-Control

**Status:** Accepted (2026-09-30)

## Context

People talk to ELISE as one continuous assistant, not as separate threads. They ask "what did
we decide about the pricing?" without remembering which conversation it was in. Voice and
other modalities are coming, and they must not flood History with threads.

People also want ELISE to adjust itself ("switch to light mode", "change your color to green",
"pause my Morning Brief"). That must not become a way to change code, prompts or security.

## Decisions

### Recall

1. **Interaction model.** An *interaction session* (`interaction_sessions`) is one continuous
   exchange, with a modality of `text`, `voice`, `proactive` or `live`. A text session points
   to its `conversations` row and reuses `messages` as its turns, so nothing is duplicated.
   Other modalities store their turns in `interaction_turns` and never create a History
   thread. Whatever the modality, a session stays retrievable.
2. **A separate recall index.** `recall_chunks` holds deterministic excerpts of up to about
   1,400 characters or 6 turns. Each excerpt keeps its provenance: the ids of its source
   turns and its time range. It also has an embedding (pgvector) and a generated full-text
   vector.

   The index is separate from Knowledge. Knowledge is the user's documents, Recall is what
   was said, and Memory is learned preferences. Each has its own tools and guidance.
3. **Hybrid retrieval in Postgres.** `search_recall_chunks` fuses cosine similarity and
   `ts_rank_cd` by reciprocal rank, the same way Knowledge does. It applies date filters and
   excludes the current conversation.

   It is `security invoker`, and RLS limits it to the author. When embeddings are unavailable,
   it falls back to full-text only.

   A semantic-only match below a similarity of 0.32 is not evidence, so "not found" stays
   honest.
4. **Indexing never blocks chat.** After each turn, the conversation is queued as a
   `recall-index` job on Trigger.dev, or indexed detached in-process when Trigger.dev isn't
   configured.

   Indexing is idempotent and incremental. Excerpts are hashed, only changed ones are
   embedded, and excerpts past the end are removed.

   Summaries (title, summary, topics) come from one bounded, fast model call after every 6 new
   turns. They are optional.
5. **Backfill is the same sweep.** `sweepRecall` indexes every conversation whose index is
   missing or older than its last message. Because progress is the index itself, the sweep is
   resumable and idempotent.

   `recall-sweep` runs every 15 minutes, and `recall-backfill` works through one workspace in
   batches of 100.
6. **Tools.** The tools are `history.search`, `history.getContext` (at most 12 turns around an
   excerpt), `history.getInteraction` and `history.getRecent`.

   Dates are resolved deterministically in the user's time zone, using the same periods as
   Finance (`core/periods.ts`). Results are grouped per interaction and returned oldest first,
   so the model can synthesize how things changed. Each result links to its interaction
   ("View interaction").
7. **Context builder.** Recall guidance is always present. When the message refers to earlier
   conversations (a deterministic EN/ES pattern check), up to 3 results are prefetched, with a
   2.5 s budget and best effort. They are injected as quoted excerpts. The whole history is
   never injected.
8. **Evidence, never authorization.** Recalled text is marked `untrusted` and wrapped as data.
   An old "always send without asking" changes no policy. Approvals and current settings
   always apply.
9. **Privacy.** Deleting a conversation from History archives it. A trigger on
   `conversations.archived_at` deletes its excerpts and embeddings and marks the session
   archived in the same transaction. The indexer never indexes archived conversations.

   Only the service role writes the index, and a trigger keeps each session within one user
   and workspace.
10. **Surface-ready.** `RecallResult` is a framework-free model. It is rendered today as a chat
    card and in History search, and later as a Live Workspace surface.

### Self-Control

11. **Typed internal tools only.** The self-control tools are:
    - `settings.get` and `settings.update` (language, and a time zone resolved to a canonical
      IANA id, or a question when ambiguous);
    - `appearance.get`, `setTheme` and `setAccent`;
    - `notifications.getPreferences` and `updatePreferences` (reusing each Schedule's delivery
      setting);
    - `schedules.list`, `pause` and `resume`;
    - `connections.list` (read-only).

    Disconnecting remains a user action in Connections. No tool touches prompts, policy,
    permissions, RLS, secrets or code.
12. **Internal writes go through the normal path.** Internal capabilities have no provider
    binding. Their writes are still recorded actions under policy, with an execution trace
    and an audit event.

    The settings store adds explicit events: `appearance.theme_changed`,
    `appearance.accent_changed`, `settings.timezone_changed`, `settings.language_changed` and
    `notifications.updated`.
13. **Accents are an allowlist of design tokens.** The accents are cyan (the default), blue,
    violet, green and amber. They are stored on `user_profiles.accent` with a CHECK constraint
    and applied as `data-accent` on `<html>`. `globals.css` overrides only the `--accent*`
    tokens for light and dark. Error, warning, success and approval colours never change.

    The orb takes its idle and listening colours from the accent. The model can only name an
    accent, never a CSS value. When a tool changes the appearance, the chat applies the
    approved values at once.
14. **The theme is a profile setting.** `user_profiles.theme` is the source of truth when
    signed in. The cookie is kept for signed-out pages and as a fallback.

## Consequences

- Past conversations need one backfill (the sweep does it automatically) before they can be
  recalled.
- Recall quality depends on embeddings. Without them it is lexical only, and that is logged.
- Voice sessions can be added by writing `interaction_sessions` and `interaction_turns`. No
  schema change is needed.
- There is no entity system yet. Topics come from summaries and are not resolved entities.
