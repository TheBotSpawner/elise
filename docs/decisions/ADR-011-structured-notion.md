# ADR-011 — Structured Data, with Notion as the first provider

**Status:** Accepted (2026-09-30)

## Context

ELISE already reads Notion pages as Knowledge: ingestion, retrieval and citations. People also
keep structured databases in Notion (projects, CRMs, reading lists) and want to query and edit
their records: "what's due this week?", "mark ELISE Website as completed".

Those records are state (status, dates, priority), not documents. They must be read live from
the source, and written back to it.

## Decisions

1. **A provider-independent capability.** `structured` exposes these canonical tools:
   `structured.listSources`, `getSchema`, `query`, `getRecord`, `createRecord`,
   `updateRecord`, `archiveRecord` and `bulkUpdate`. There is no `notion.*` model-facing tool.

   The resolver maps `structured.*` to a binding of a Notion connection, and
   `NotionStructuredProvider` implements the contract. Another provider can implement the same
   contract later.
2. **Same Notion connection, two uses.** One OAuth public connection, the same encrypted vault,
   the same health handling and the same reauthorization serve both Knowledge (pages → text)
   and Structured (databases → fields). The Notion connection gains a `structured` capability
   grant and binding; existing connections were backfilled by migration, with no reconnect
   needed.

   Whether ELISE may insert or update is decided by two things: the integration's
   capabilities in Notion (Read, Update and Insert content; no comments; no email), and the
   per-database permissions in ELISE.
3. **Notion API `2026-03-11`, centralized.** `providers/notion/http.ts` defines one version and
   one error mapping, and Knowledge moved to it too. In this version a database contains data
   sources:
   - schema: `GET /data_sources/{id}`
   - rows: `POST /data_sources/{id}/query`
   - create: `POST /pages` with parent `{type:"data_source_id"}`
   - archive: `PATCH /pages/{id}` with `in_trash: true`

   Filters and writes address properties by id, so they survive renames.
4. **Mapping, not copies.** `structured_sources` stores, per workspace:
   - the connection, database id and data source id;
   - a name, a context hint ("projects, Acme") and a semantic type (`generic`, with `habits`
     reserved for a canonical capability later);
   - a schema fingerprint and snapshot;
   - field mappings (key, label, property id and name, type, writable);
   - per-source permissions (read, create, update, archive), status and schema issues.

   Records are never stored in ELISE. Every read is a live Notion query.
5. **Proposed, then confirmed.** The mapping is proposed by header rules in English and
   Spanish: the title becomes `name`, and Stage→status, Due→due_date, Importance→priority,
   Customer→client, and so on. The AI then suggests keys and labels only for what the rules
   didn't cover, and only valid ones. The user reviews every field and sees real rows before
   anything is active.
6. **Deterministic queries.** Core resolves intent into concrete filters, and the adapter
   compiles them to Notion filter JSON, with pagination capped at 50 per call. Nothing fetches a
   whole database for the model. Resolution covers:
   - status groups (todo, in_progress, complete) expanded to their options;
   - date windows in the user's timezone (this week Mon–Sun, next 7 days, overdue, …);
   - option names checked against the schema.
7. **Safe writes.**
   - Values are validated against the mapping: only writable, intact fields; options must
     exist; creating a record requires the title.
   - Types written: text, number, select, multi-select, status, checkbox, date, URL, email and
     phone.
   - Read-only: formula, rollup, created/edited time and by, unique id, verification and
     button, plus people, relations and files in this MVP.
   - Record resolution by title proceeds only with exactly one match; otherwise ELISE asks.
     Update and archive pin the exact record before approval.
   - Policy: creates and updates follow the usual rules, archive asks when ELISE proposes it,
     and bulk updates always ask. A bulk update is pinned to the exact record ids and shown
     with its count and a sample. Batches over 25 run on Trigger.dev (`structured-bulk`), and a
     job row keeps the approved change while the payload carries ids only.
   - Nothing is confirmed until Notion's response confirms it. A 5xx or a timeout on a write is
     `UNKNOWN_OUTCOME` and is never retried.
8. **Schema changes.** The schema is re-checked when used (at most every 10 minutes), hourly in
   the background, and on "Refresh fields". Detection is by property id:
   - A rename keeps the mapping and updates the name.
   - A removed or retyped property marks the field broken and the source `needs_attention`, and
     is never remapped silently.
   - Added properties are listed as unused.
9. **Knowledge vs Structured.** Chat guidance routes field and state questions to `structured.*`
   and document-content questions to `knowledge.search`. Structured fields are not vectorized.
   Mapped sources (names, ids, context and field keys only) are listed in the chat context so
   the right source is chosen; when two could fit, ELISE asks.
10. **Security.** Record values are data, and the model is told never to follow them. Tokens stay
    server-side. Row-level security and same-workspace, same-provider triggers protect
    mappings. Disconnecting Notion pauses its databases, and reconnecting resumes them.

## Consequences

- Answers reflect Notion at the moment of the question; there is no stale cache to reconcile.
- People, relations and files can't be written yet, and relation targets are never invented.
- One Notion data source per mapping. A database with several data sources is mapped once per
  data source.
