# ADR-056: Notes v2 — rich text as Markdown, one note in many Knowledge Spaces

**Status:** Accepted (2026-10-14). Extends Notes (docs/architecture/10 §30-32).
Migration `20261024000043_notes_v2.sql`.

## Context

Notes had two limits:

- **Editor:** a plain textarea.
- **One Space only:** a note lived in one Space (`notes.space_id`), indexed as a Knowledge
  item there.

Users want structured notes (headings, lists, emphasis), and the same note in several Spaces
("Proceso de propuestas" in General Knowledge, Firbot Solutions and Firbot Marketing).
Copying the note per Space would duplicate content, embeddings and citations.

## Decision

### Content and editor

- **Storage:** Markdown, not HTML or editor JSON.
  - Plain text is valid Markdown, so existing notes need no migration.
  - ELISE reads and writes it naturally.
  - Knowledge's existing Markdown parser indexes it with its headings.
  - Search tokenizes on letters and digits, so `**`, `#` and `-` never get in the way.
- **Editor:** TipTap 3 (StarterKit + the official Markdown extension), pinned at 3.31.3.
  - The project had no editor, and writing a WYSIWYG ↔ Markdown editor by hand isn't
    reasonable.
  - StarterKit covers headings 1–3, bold, italic, lists, quote, inline code, code block,
    divider and links (http(s)/mailto only).
- **Toolbar:** compact — text style select, B, I, link, lists, quote, code, code block,
  divider.
  - Shortcuts: Ctrl/Cmd+B, Ctrl/Cmd+I, Ctrl/Cmd+K (link), Ctrl/Cmd+S (save), plus Markdown
    input rules (`# `, `- `, `**…**`).
  - Styles reuse `.prose-elise`.
- **Previews:** lists show `plainText(markdown)`.

### One note, many Spaces

- **`note_knowledge_spaces`:** the canonical membership.
  - Unique (note, Space); both sides same-workspace (trigger); members-only RLS.
  - `notes.space_id` stays and mirrors the first Space, so the change is additive and
    rollback-safe.
  - Backfilled from `space_id`.
- **Sections:** they are child Spaces, so picking "Firbot Solutions › RSFA" files the note in
  that Section. No extra hierarchy.
- **General Knowledge:** an ordinary option; it is never added automatically.
  - "General Knowledge" / "Conocimiento general" resolve to it.

### Indexing once

- **One item per note:** a note is ONE `knowledge_item`, with ONE set of chunks, filed in its
  home Space (the first Space).
- **`knowledge_item_spaces`:** lists every Space that may retrieve it. Written by ELISE's
  indexing only; members can read it.
- **`search_knowledge_chunks` scope:** a chunk is in scope through its own Space OR an item
  membership. Each chunk exists once, so a note in several Spaces in scope comes back once.
- **Hits:** they name every Space the note is in ("Firbot Solutions · Firbot Marketing").
- **Spaces changed only:** membership is updated, with no new version and no re-embedding.
  - If the home Space was removed, the item and its chunks move home by UPDATE.
- **Text changed:** a new version is indexed; the previous one stays current until the new
  one is ready.
- **No Spaces left, or archived:** the item is removed and the note stays in My Elise → Notes.
- **Space screens:** they list member notes too — the same item, so an edit shows
  everywhere.

### Tools

- **`notes.create`:** takes `spaces` (several). `space` still works.
- **`notes.update`:** edits title and content (Markdown) and keeps the note's Spaces.
- **New `notes.setKnowledgeSpaces`:** `add`, `remove` or `spaces` (replace; `[]` = outside
  Knowledge).

### Screen

- **Layout:** wide.
  - The list (search, New note, cards with preview, Spaces and relative time) stays on the
    left.
  - The open note is on the right; on small screens it stacks with a back button.
- **"Conocimiento":** a popover of checkboxes that stays open while picking, with search.
  Chosen Spaces show as removable chips. "Fuera de Conocimiento" when there are none.

## Consequences

- **Easier:**
  - formatted notes for people;
  - Markdown stays easy for ELISE and search;
  - one note can serve several Spaces without copies.
- **Not done:**
  - task-list items (need another TipTap extension);
  - an editor placeholder;
  - per-Space document counts don't include notes shared from another Space (the Space
    screen does list them).
