# ADR-007 — Knowledge: Spaces, ingestion, hybrid retrieval, Drive and Notion

**Status:** Accepted (2026-09-29)

## Context

Knowledge (docs/architecture/09, 16 §34-41) lets ELISE answer from the user's documents with
citations. It must stay on Supabase (Postgres + pgvector), be tenant-scoped, version-aware,
processed in the background, and feed the existing single runtime as a native capability.

## Decisions

1. **Model.** `knowledge_spaces` (hierarchy; a trigger refuses cycles, cross-workspace parents
   and more than 12 levels) → `knowledge_sources` (upload, google_drive, notion; `note` reserved
   for ELISE Notes) → `knowledge_items` → `knowledge_versions` → `knowledge_chunks`, plus
   `knowledge_sync_runs`. Every row carries `workspace_id`.
2. **ELISE owns the index.** `knowledge` is an ELISE-internal, read-only capability (like
   `schedules`): its tools never go through provider resolution; provenance (Upload, Drive,
   Notion) is data on each passage. Tools: `knowledge.search`, `getItem`, `listSources`,
   `listRecentChanges`, `compare`, `overview`.
3. **Writes are server-side.** Users read their workspace's Knowledge through RLS; items,
   versions, chunks and sync runs are written with the service role by ingestion/sync after an
   ownership check, always filtered by workspace.
4. **Uploads.** Private bucket `knowledge-originals` (25 MB, PDF/DOCX/TXT/MD/CSV), paths
   `workspace/{workspace}/knowledge/{item}/{version}/{file}`. The server issues one-time signed
   upload URLs; the browser uploads directly; the server verifies the object before ingestion.
   Downloads use 5-minute signed URLs. No Storage policies for API users.
5. **Versioning and dedup.** Every change is a new `knowledge_version` (upload of a new file,
   or an external revision). The extracted text is hashed (SHA-256): if it equals the current
   version's hash with the same chunking version and embedding model, nothing is re-embedded
   (`unchanged`). Only the current version's chunks are searchable; older versions keep their
   extracted text (last 5) for comparison and history. A failed update keeps the previous version
   searchable and flags the item.
6. **Chunking.** Structure-aware (headings, pages, rows), ~1400-character target, 200-character
   overlap within a section, never across sections, tiny sections merged. Centralized in
   `CHUNKING` with a version string recorded per version.
7. **Embeddings.** `EmbeddingProvider` port; OpenAI `text-embedding-3-small` at 1536 dimensions
   (configurable with `OPENAI_EMBEDDING_MODEL`; `dimensions` keeps the column size). The model
   is recorded on every chunk; `knowledge-reindex` re-ingests versions built with another model
   or chunking version.
8. **Hybrid retrieval.** `search_knowledge_chunks` (SECURITY INVOKER): scope first (workspace,
   Spaces incl. descendants, items; current versions of ready items), then pgvector cosine
   candidates + full-text (`simple` config, OR of key terms) fused with reciprocal rank fusion.
   The tool keeps at most 8 passages (max 2 per document, ~9000 characters) and treats weak
   semantic-only hits (cosine < 0.3) as no evidence. The active Space of the conversation is
   searched first; everything only when asked.
9. **Answer discipline.** Evidence goes to the model numbered and marked `untrustedContent`;
   the model cites `[n]`; the UI shows a Sources card linking each citation to its passage,
   version and original. With no evidence, the tool tells the model to say so and to label any
   general knowledge explicitly.
10. **Google Drive** is the `knowledge` capability of an existing Google connection, requested
    incrementally with `drive.readonly` (read-only; only selected folders/files are indexed).
    Docs → Markdown export, Sheets → CSV, Slides → text, other supported files downloaded.
11. **Notion** is its own provider connection (public integration OAuth; the user picks pages
    in Notion). Pages, subpages and database pages are normalized from blocks (headings,
    lists, to-dos, tables) with database properties as text. Read-only; no structured mapping.
12. **Sync.** Periodic (every source about hourly, dispatcher every 10 minutes) and Sync Now
    use the same `knowledge-sync` task: list the selection, compare external id + revision,
    create/update versions, mark missing items `removed` (out of search immediately). A source
    that can't be read removes nothing and is marked needs attention. One sync per source at a
    time; lost runs expire after 45 minutes.
13. **Removal policy.** Removing a source or disconnecting its account stops sync immediately
    and deletes what ELISE indexed from it (items, versions, chunks, originals). The data in
    Drive/Notion is untouched.

## Consequences

- `drive.readonly` is a Google _restricted_ scope (verification needed beyond Testing mode).
- Notion requires a public integration (client id/secret); without it, Notion stays disabled.
- Scanned PDFs (no text layer) are marked "needs attention"; there is no OCR.
- Large-Space summaries use per-document opening passages (25 most recent); a background
  hierarchical summary is not built yet.
