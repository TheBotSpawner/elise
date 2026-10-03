# ADR-031: Canvas working set, habit history, chat attachments

**Status:** Accepted (2026-10-03). Extends ADR-021 (Live Canvas), ADR-029 (Surface lifecycle)
and ADR-013 (Live Workspace). Migration `20261008000027_chat_attachments.sql`.

## 1. The Live Canvas is current work, not a history

**Root causes.** Presenting was additive: a Surface had no identity for *which data* it showed,
so "show those tasks as a timeline" added a timeline next to the list. A created task's card was
dropped whenever any collection refreshed. "Mostramelo" and "mostralas" were left to the model,
which guessed from conversation text. Timelines were built from dates the model remembered, not
from the collection.

**Decision.**

- A Surface carries `dataset` (the read's query key, or `resource:id` for a single resource),
  `presentation` (`list` / `timeline` / `table`) and `changedAt`. All three persist in the
  envelope, so a reload restores the current form only.
- Presenting a Surface whose `dataset` is already on screen **replaces** that Surface. The new
  one inherits its handle and position. Exceptions: pinned Surfaces, approvals, and `keep: true`
  (the user asked to keep both).
- **Working set.** `lastAffected` is the Surface most recently changed by a write. The *active
  collection* is the focused collection, or else the most recent one. `describeWorkspace` tells
  the model both.
- `ui.show { what: last_changed | collection, as?, keep? }` resolves "mostramelo" and "mostralas"
  in the core, with no extra model round trip. A change of form is built from the collection's
  own items (re-read if needed) and replaces the old view. Timelines and visualizations built
  from one handle inherit its dataset (`inheritedFrom`).
- **Create, update, delete.** A write first refreshes the affected collections (ADR-029). If the
  written resource is already shown in a refreshed collection, that collection becomes the last
  affected Surface, and no extra card is added. A deleted resource gets no card. A collection
  shown as a timeline or table keeps that form when it refreshes.
- Timeline and table rows carry no ids, so those forms record their `members` (the collection's
  resource ids, persisted). That is how "is the new task already on screen?" is answered in
  every form.

## 2. Habit history belongs to the user

**Root cause.** A habit's `startDate` (its creation day by default) acted as a hard boundary for
whether a day was scheduled, and for counts and streaks. Neither the UI nor the database stopped
past check-ins; they simply didn't count.

**Decision.**

- Today and every past day can be edited, including days before the habit was created
  (backfill). Future days are rejected server-side.
- A day before `startDate` counts when it has a `done` entry. Streak and counts compute from the
  earliest of `startDate` and the first done entry. Recomputation always uses the user's
  timezone (`todayIn`).
- `habits.checkIn` takes `date`, `daysAgo` ("ayer") or `weekday` ("el miércoles": the most recent
  one, today included), resolved by `checkInDate`. Undo and numeric set reuse the same path.
- The Habits page navigates by week (`?week=`). Past unscheduled days stay editable, and each
  day button has an accessible label.

## 3. Chat attachments (global drag & drop)

**Product rule.** A chat attachment is not a Knowledge source. Dropping a file means "use this
in this message". It is never indexed or added to a Space unless the user chooses Knowledge in
the paperclip dialog.

**Lifecycle.** Each attachment moves through LOCAL → UPLOADING → READY, or ends as FAILED
(retry) or REMOVED.

- **Client.** One draft per tab (`features/chat/draft-attachments.ts`). Every entry point adds
  there: a drop anywhere on the window and the paperclip's "Adjuntar a este mensaje". Uploading
  starts at once, but uploading is not sending.
- **Server.** A `chat_attachments` row is `uploading`, then `ready` after its bytes are verified,
  then `sent` once it belongs to one user turn (`conversation_id` or `session_id`).

**Storage.** The private bucket is `chat-attachments`, with paths
`workspace/{ws}/chat/{id}/{file}`. The server issues one-time signed upload URLs, the same
pattern as Knowledge and Finance imports. Every path is checked against the caller's workspace.
RLS limits rows to their author.

**Validation.** The server is authoritative. Type comes from the extension against one allowlist
(`core/attachments/model.ts`, shared with the browser). Then the stored bytes must match that
type (magic bytes for PDF, DOCX and images; no NUL bytes for text). A mismatch, an oversized file
or a missing upload is discarded, both the row and the file.

**Limits.** All limits live in `ATTACHMENT_LIMITS`. The browser pre-checks them for friendly
errors; the server enforces them.

| Limit | Value |
| --- | --- |
| Documents (PDF, DOCX, TXT, MD, CSV) | 20 MB |
| Images (PNG, JPEG, WEBP, GIF) | 8 MB |
| Files per message | 8 |
| Text read per document | 40 000 characters |

**Sending.**

- `send()` takes the draft for the next turn, typed or spoken. If uploads are still running, it
  waits and shows a pending state. If any upload failed, the turn is not sent: the text returns
  to the composer and the chip offers retry.
- The request carries attachment **ids**. `prepareTurn` verifies them before anything is
  written: they must be the author's own, in this workspace, and `ready`. So a refused turn
  creates no conversation.
- The user turn stores `metadata.attachments` (id, name, type, size). The files are marked
  `sent` with the thread.
- If the server refuses the turn, the files go back to the draft.

**Model context.**

- Document text goes into the user message inside `<attached_files>`, as untrusted data with the
  attachment id and name.
- Images go as `input_image` parts on the same message, so multimodal analysis works.
- Later turns see `[attached to this message: "name" (attachment id)]` in history.
- Provenance is the attachment id and name. No Surface opens on drop.

**Voice.**

- Legacy voice turns go through the same `send()`.
- GPT-Live delegations send the ids to `/api/voice/live/delegate`.
- The Live model is told quietly that files were attached, so it hands requests about them to
  ELISE.

**Drop target.** Listeners sit on `window` and react only to drags whose types include `Files`;
text selections and internal drags are ignored. A depth counter keeps one stable state across
child elements, so there is no flicker. The overlay is non-interactive, so Surfaces, buttons and
selection keep working, and it respects reduced motion. On touch devices drag events don't fire,
so mobile uses the paperclip and the photo picker (`accept` includes images).

**Cleanup.**

- Removing a chip deletes the staged row and file. If an upload is in flight, removal happens
  when the upload lands, so no orphan object is left.
- Staged attachments older than 24 hours are deleted the next time the user stages a file.
- Sent attachments live as long as their conversation.
- A full reload clears the in-memory draft. `File` handles are never persisted; anything already
  staged expires.
