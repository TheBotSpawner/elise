# ADR-022: Finite Knowledge source lifecycle and Section identity

**Status:** Accepted (2026-10-02). Refines ADR-007 (Knowledge), ADR-018 (Sections) and
ADR-020 (History links). No migration.

## Context

A real Drive folder connected to UTN › AMII stayed "Preparando…" for hours, its files were never
retrievable, "Sincronizar ahora" failed with "Eso ya se resolvió o cambió mientras tanto", the
Section said "0 elementos", and a conversation about "análisis matemático 2" was not tagged AMII.
Root causes:

1. The initial sync was handed to Trigger.dev and never started (no worker ran it). Nothing
   closed the run, so the one-active-sync-per-source unique index blocked every later attempt:
   the page-load safety net silently no-oped and Sync now hit the index and returned CONFLICT,
   whose generic copy is "Eso ya se resolvió…". The only cleanup (expireStaleSyncs) ran on the
   same Trigger schedule and never touched the source, which stayed `idle` → "Preparando".
2. Space/Section counts came from indexed items only, so a connected source with no ingested
   files counted 0.
3. History mentions matched only a node's exact name ("AMII"); the description the user wrote
   ("Análisis Matemático II") was never used, and "II" ≠ "2".
4. Clipping math-heavy PDF text with `.slice()` split two-unit characters; Postgres jsonb rejects
   the lone surrogate, so the assistant's answer and the Live Workspace were silently not saved.

## Decision

1. **Every source state is finite** (`core/knowledge/source-state.ts`): preparing (first sync or
   first files on their way), syncing (usable, refreshing — retrieval keeps using the last
   index), up to date, needs attention. Limits in `SOURCE_LIFECYCLE`: a queued sync not started
   in 10 min or a running one not finished in 25 min is *stalled*; an ingestion not finished in
   30 min is stalled. Uploads and notes are containers and never go through this lifecycle.
2. **Stalled work is closed wherever it is seen**: the periodic dispatcher, the page-load safety
   net, Sync now and the Space page call `recoverStaleWork`. Stalled runs fail
   (`BACKGROUND_STALLED` / `TIMEOUT`), the source needs attention (retry after 30 min); stalled
   versions fail and their item keeps its last good version if it has one. A sync the runtime
   refuses to queue, or that crashes before closing its run, also closes it and marks the source.
   Transient failures (stalled, timeout, provider unavailable) are retried by the next sync.
3. **Sync now / Retry is idempotent**: `{ status: "started" | "already_syncing" }`; "already
   syncing" is information ("La fuente ya se está sincronizando."), never an error.
4. **Counts are sources**: a Space/Section shows "N fuentes" — each Drive/Notion source is one
   (before or after its first sync), each uploaded document and note is one. Files appear in the
   source details (found vs indexed).
5. **Section identity**: a node's description and the first line of its context are aliases
   when they are short identity phrases (≤ 6 words, not generic). Matching ignores case,
   accents and punctuation and reads Roman numerals II–IX as digits. History tagging and
   `knowledge.search` scope resolution use the same rules. One turn that used ≥ 2 passages of a
   Section is strong evidence (0.8). Manual removals are still never undone automatically.
6. **Section-first retrieval with inheritance**: the Section's own sources and, separately, up
   to 8 candidates from its parent Space are searched and merged, so a large Section can't crowd
   the parent's material out.
7. **Storage-safe text** (`core/text.ts`): clipping never splits a character; everything stored
   as JSON is made well-formed; a failed assistant-message save is logged, never silent.

## Consequences

- Production needs a running Trigger.dev worker for Knowledge (deploy `src/trigger`); without
  it sources now say "Necesita atención" within minutes instead of "Preparando" forever.
- Scanned PDFs without a text layer still can't be read (no OCR); each says so on its own row.
