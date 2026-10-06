# ADR-046: Federated Knowledge, live Tasks, and the app boot

**Status:** Accepted (2026-10-06). Supersedes ADR-007 §10-12 (Drive/Notion ingestion and sync)
and the ingestion parts of ADR-022/036/037 for connected sources. Refines ADR-009 (Tasks).
Migration `20261016000035_federated_knowledge.sql`.

## Context

- Connecting a Notion database or a Drive folder copied it: every page/file was listed, a version
  created, its content downloaded, extracted, chunked and embedded, then re-synced hourly. In the
  real data that was 2 Notion sources (860 items) and 3 Drive folders (62 files): 1,502 versions,
  865 of them with stored text, and 2,319 chunks. Answers came from copies up to an hour old.
- Source rows said "Preparando fuente…", "Indexando 346 páginas", and 50 database rows "needed
  attention" one by one.
- Google Tasks was already read live per request (ADR-009), but nothing re-read it afterwards:
  the Tasks page and task Surfaces kept their first snapshot, and the model could answer from a
  task list on screen or from an earlier turn.

## Decision: connected is not mirrored

**Two source modes**, stored as `knowledge_sources.access_mode`, a column *generated* from the
source type so it can't drift:

| Mode | Sources | What ELISE keeps |
| --- | --- | --- |
| `native_indexed` | uploads, ELISE Notes, saved chat attachments | the copy: extraction, OCR, chunks, embeddings |
| `external_live` | Google Drive, Notion | a metadata catalog; content is read when a question needs it |

An "imported copy" of an external document is an upload, so it is `native_indexed` by
construction (ADR-035 promotion already works this way). `external_cached` / `external_mirrored`
are not built.

**Catalog, not mirror.** The old sync is now a catalog refresh (`core/knowledge/sync.ts`): it
lists the selection and upserts `knowledge_items` with title, URL, MIME type, path, provider
modified time and revision (`metadata.revision`) — no version, no content, no ingestion job. Drive
also records every folder of the selection (`configuration.catalog.folderIds`): the scope live
search may look in. `ingestVersion` refuses any `external_live` version, whatever asks (retry,
reindex, an old queued job).

**Live retrieval** (`application/knowledge-live.ts`, policy in `core/knowledge/live.ts`), staged
and bounded, runs inside `knowledge.search` next to the native index:

1. the Spaces in scope give their Drive/Notion roots (one per connected database, page, folder,
   file);
2. roots the question names best are asked (≤ 4); words that only name the scope (root, Space,
   Section names and descriptions) are dropped — the provider is searched for the *subject*;
3. each provider searches itself, metadata only:
   - **Drive**: `files.list` with `name contains` / `fullText contains` and `'<folder>' in parents`
     over the permitted folders (never wider than what was selected); newest first for "the
     latest";
   - **Notion**: data-source query with a title filter, plus the 25 newest records scored on their
     properties; `created_time` descending for "the latest". A page root's inline databases are
     queried; its subpages come from the catalog;
4. the best candidates across roots (≤ 4) are read now — Notion properties + first 300 blocks,
   Drive export/download through the shared extraction (OCR included) with `purpose: "live"`,
   which **never** writes `document_extractions`;
5. the passages that share the subject (else the document's opening) are evidence, cited with the
   original URL; the catalog entry is ensured so the citation has a stable item.

**Cache ≠ source of truth.** Read content is kept in memory for 10 minutes under
`provider:id:revision` (Drive `version`, Notion `last_edited_time`), so a changed document misses
the cache. Notion structure (a page's databases, a database's data sources) is cached the same
way. Nothing is persisted because it was once queried.

**Retrieval of copies.** `search_knowledge_chunks` only searches `native_indexed` sources; overview
previews and `knowledge.compare` ignore live sources' old text. A stale copy is never cited.

**UI.** A live source is one row, "Disponible · comprobado hace X" or "Necesita atención" (its own
health: access lost, listing failed). No item counts, phases or per-page attention; "Sync now"
reads "Comprobar ahora" (refreshes the catalog). Rows of a database never appear in "Recientes".
A cited live document's page says it is read live from Notion/Drive and offers "Abrir original";
legacy versions are not shown.

## Legacy data migration

Measured before migration 035: external items `ready` 864, `needs_attention` 50, `processing` 1,
`removed` 7; 1,502 versions (865 with stored text); 2,319 chunks.

Migration 035 (applied): adds `access_mode`; restricts the search RPC; sets the 51 external items in
an ingestion state to `ready` (catalog entries); marks pending/processing external versions
`superseded`. **Nothing was deleted**: legacy versions and chunks stay so old citations and History
keep resolving, but they are unreachable from retrieval.

Cleanup after validation (manual, per workspace if wanted):

```sql
delete from public.knowledge_chunks c using public.knowledge_sources s
 where s.id = c.source_id and s.access_mode = 'external_live';
update public.knowledge_versions v set extracted_text = null
  from public.knowledge_items i join public.knowledge_sources s on s.id = i.source_id
 where v.knowledge_item_id = i.id and s.access_mode = 'external_live';
```

## Decision: Google Tasks freshness

Google Tasks remains the source of truth; it is never copied into ELISE Native (ADR-009). The
Tasks API (v1: tasklists and tasks, CRUD + move/clear) has **no watch, push channel or sync
token**, so no realtime mechanism is simulated. Correctness is refresh-on-read:

- **Page open:** the server render reads every enabled account live. The board carries
  `fetchedAt`; a snapshot older than 30 s (e.g. served by the router cache on Back) refreshes at
  once (`useRefreshWhenStale`).
- **Return:** focusing the window/tab after 30 s refreshes it, once per snapshot. No interval
  polling.
- **Live Canvas:** a visible task Surface re-reads on return the same way (plus Realtime for native
  tables, as before).
- **Chat/voice:** the guidance requires `tasks.list` in the same turn for any task question, never
  the list on screen or an earlier turn. Home, Morning Brief, Schedules, planning and meeting tools
  already read through `tasks.list`.
- **Writes** go to Google; the board refreshes after success (optimistic in between) and Surface
  actions return the re-read state.
- A quiet "Actualizado ahora / hace N min" line is the only sync UI.

## Decision: the app boot

- **Identity** (`components/elise/orb/boot.ts`): the JavaScript document. A new tab or a hard
  reload boots; client navigation, Back, a remounted Home, a new chat, the Orb flying into the nav
  never do. Entering on another route means no boot for that document. A remount during the
  sequence continues it (Strict Mode safe).
- **Animation**: same canvas, renderer and rAF loop as always — a cyan point (100-300 ms), the
  wireframe resolving outward (300-850 ms), ring and glow coming online (600-1050 ms), idle by
  1.2 s. Reduced motion: a 350 ms fade. Home is interactive throughout; nothing waits for it.
- **Sound** (`features/boot/startup-sound.ts`): an original Web Audio tone (two soft partials rising
  a fifth, a later shimmer, a lowpass opening; ~0.9 s, peak gain 0.06). No file, no request.
  Setting "Sonido de inicio" (per device, on by default).
- **Autoplay (Chrome)**: an `AudioContext` created before any user gesture starts `suspended` and
  logs a warning; ELISE doesn't create one then. If the document already has user activation
  (`navigator.userActivation.hasBeenActive`, e.g. arriving from the sign-in click by client
  navigation) or the browser reports the policy allowed, it plays with the Orb. Otherwise it waits
  for the first tap/key press for 2 s and is skipped for the session after that — never a late,
  random sound.
- **Cost**: ~2 KB of code, one extra radial gradient for ~1 s, no assets, no network.

## Consequences

- Answers about Drive/Notion reflect the provider now. Measured on real data: "último proyecto de
  la Pipeline" 4.0 s (2.4 s repeated), a named Drive file 3.6 s, four PDFs 10.9 s, a record with
  no named database 10.8 s (four databases asked).
- Content that only exists inside an un-named Notion database page body is found only if its
  title/properties match or it's among the newest; semantic search over external content is gone
  by design. Import the document (upload) for that.
- A Drive folder created after the last catalog refresh (hourly) isn't searched until the next one.
- Deleting legacy chunks is a manual, post-validation step.
