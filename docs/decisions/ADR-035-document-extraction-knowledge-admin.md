# ADR-035: Shared document extraction with OCR, and Knowledge administration by ELISE

**Status:** Accepted (2026-10-04). Extends ADR-031 (chat attachments), ADR-018/020 (Spaces and
Sections). Migration `20261009000028_document_extraction.sql`.

## Why scanned PDFs failed

- `parsePdf` read only the embedded text layer.
- `parseDocument` then counted characters and, under 40, threw "This PDF has no readable text
  (it may be scanned images)" marked `needs_attention`.
- There was no OCR anywhere.
- Chat attachments used the same parser, so a scanned PDF attached to a message was sent to the
  model as "unreadable".

## Decision: one DocumentExtraction service

The flow is:

1. Type detection.
2. Native text per page (`unpdf`).
3. Page quality check (`needsOcr`: fewer than 25 letters or digits).
4. OCR only for those pages, in page-selected batches.
5. A merged, ordered extraction with a method per page (`native` / `ocr`).
6. The document-level method: `native`, `ocr` or `hybrid`.

**Pages are kept.** Each page becomes a section, so chunks and citations keep "page 27".

**Text is never rewritten.** Only whitespace and line wraps are normalized; no model touches
extraction.

**Layers:**

| Layer | File |
| --- | --- |
| core (pure) | `core/knowledge/extraction.ts`: types, limits, merge, the `OcrProvider` port |
| infrastructure: runner | `infrastructure/knowledge/extraction.ts` |
| infrastructure: provider | `infrastructure/ocr/google-document-ai.ts` |
| application: cache and consumers | `application/extraction-service.ts` |

The application layer exposes `extractDocument` for chat and `readDocument` for Knowledge.

**Consumers:**

- Knowledge ingestion (uploads and Drive files) calls `readDocument` inside the existing
  background job (Trigger.dev, or inline in development). Large scans never block a request.
  While OCR runs, the item shows "Reconociendo texto".
- Chat attachments call `extractDocument` with a smaller page budget. Pages not read are named
  to the model (`pagesNotReadYet`), never treated as empty.
- Images still go straight to the model (multimodal). OCR on an image runs only when it is saved
  to Knowledge.

**Limits** live in one place (`EXTRACTION_LIMITS`):

| Limit | Value |
| --- | --- |
| Pages per OCR request | 15 (Document AI online limit) |
| Pages per Knowledge job | 500 |
| Pages per chat turn | 15 |
| OCR request size | 38 MB |

**Needs attention** is used only for real blockers:

- password-protected;
- corrupt;
- no text even after OCR;
- too large;
- OCR not configured.

Each has a specific message. Lack of a text layer alone no longer causes it.

## OCR provider: Google Document AI, Enterprise Document OCR

**Why this provider:**

- It is Google's recommended OCR for scanned documents.
- Online requests take up to 15 pages and 40 MB, with individual page selection, which is
  exactly what page-level hybrid needs.
- Cloud Vision `files:annotate` takes 5 pages per request, and needs a service account as well,
  since API keys are not accepted for PDF/TIFF.

**Authentication:** a service-account JWT (RS256, `node:crypto`) is exchanged for an OAuth token.
The key and the processor stay server-only. No new dependency.

**Setup** (also in `.env.example`):

1. Enable "Cloud Document AI API" (`documentai.googleapis.com`) in a project with billing.
2. Create an "Enterprise Document OCR" processor (region `us` or `eu`). Set
   `GOOGLE_DOCUMENT_AI_PROCESSOR=projects/P/locations/us/processors/ID`.
3. Create a service account with the role `roles/documentai.apiUser`, add a JSON key, and set
   `GOOGLE_SERVICE_ACCOUNT_JSON` to the raw JSON or its base64.

Without them, scanned pages are reported as "text recognition isn't set up yet". Native PDFs
work as before.

**Cost and usage:**

- About US$1.50 per 1,000 pages. Pages with native text are never sent.
- Usage is recorded as `operation: "ocr"`, `unit: "pages"`. No text is logged.

## Reuse, resume and dedupe

`document_extractions` is keyed by `(workspace_id, sha256(bytes))`:

- A file attached in chat and then saved to Knowledge is OCR'd once.
- After each OCR batch, progress is saved (`complete: false`). A retry continues from the next
  page, with no duplicate pages and no second charge.
- Different versions have different bytes, so they never share a result.
- Other workspaces never see the row (RLS read, server-only writes).
- Indexing stays idempotent through the existing content hash on the extracted text.

## Knowledge administration

**Port:** `core/knowledge/admin.ts` defines `KnowledgeManager`. It is implemented in
`application/knowledge-admin.ts` over the same services as the Knowledge UI, so ownership checks,
validation, audit (`knowledge.space_created`, `knowledge.section_created`,
`knowledge.source_added`, …) and Realtime all apply. It is exposed through the existing
`knowledge` provider. The model never touches tables.

**Tools** (`core/tools/knowledge-admin.ts`):

- `knowledge.listSpaces`
- `knowledge.getSpace`: metadata, Sections, documents with status and reason, connected Drive and
  Notion sources, and parent inheritance
- `knowledge.createSpace`: a Section when `parent` is given; one level deep; no type, icon or
  colour questions
- `knowledge.updateSpace`: name, description, context, or `addToContext`
- `knowledge.moveDocument`: Section ↔ general Space; nothing copied or read again
- `knowledge.retry`: specific documents, or all failed ones in a Space including its Sections
- `knowledge.syncSource`
- `knowledge.saveAttachment`: promotes chat attachments by their ids
- `knowledge.archiveSpace` and `knowledge.remove`

**Approvals** are deterministic and set in the capability registry:

- reads, creates, updates, moves, retries, syncs and saves run automatically;
- archiving and removing are `always_ask`.

A real bug was found and fixed here: an approved action of an ELISE-internal capability was
refused ("no destination"), because internal tools have no provider connection.
`resolveApproval` now uses the internal binding the action was hashed with.

**Destination resolution:**

- Exact name or path first, then a contained match.
- Several matches are a question listing them; one match just proceeds.

**Promotion:**

1. The attachment's bytes are copied into the Knowledge bucket (`saveFileToKnowledge`), with
   `metadata.savedFrom.chatAttachment` as provenance.
2. Normal ingestion runs. The extraction is found by content hash, so there is no second OCR.

The chat attachment and the Knowledge item have separate lifecycles. Archiving a conversation
doesn't remove the Knowledge copy, and removing the document doesn't touch the message.

**Routing:**

- what documents *say* → `knowledge.search`;
- what Knowledge *has* → `listSpaces` / `getSpace`;
- *changing* it → the administration tools.

## Space and Section metadata is Knowledge

**Why descriptions were ignored ("¿Qué es Firbot Solutions?" → "not enough information"):**

1. The Space was resolved correctly; routing was not at fault.
2. The description reached the model only as an *alias* ("other names the user gave them").
3. The per-turn space notes carried only `context`, never `description`.
4. `knowledge.search` returned only chunks. With none, it instructed the model: "does not contain
   enough evidence".

So the cause was context-builder framing plus the tool's output and instructions.

**Now:**

- Once a Space or Section is resolved, its `description` and `context` are read directly from the
  database. They are never fetched through embeddings, so a change is live immediately.
- A Section also brings its parent Space's metadata.
- The data is returned as `scopeMetadata`, labelled `knowledge_space_metadata` or
  `knowledge_section_metadata`, alongside passages.
- "Not enough evidence" is used only when neither documents nor metadata answer.
- Metadata is user-provided context, never evidence of what documents say.
- The active or mentioned scope's description also travels in the per-turn space notes.
- Unrelated Spaces only appear briefly, by context, for scope resolution.
- Descriptions remain aliases for fuzzy matching ("discovery"), but that is supplementary.

## Not built

- OCR layout tables.
- Batch Document AI over 500 pages.
- A Knowledge-specific Canvas Surface for management results (answers are text, approvals use the
  approval Surface).
- Re-copying is used instead of shared storage objects across buckets.
