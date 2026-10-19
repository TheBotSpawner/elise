# ADR-088: Note tags and the note menu

**Status:** Accepted (2026-10-19). Extends ADR-056 (Notes v2).

## Decision

- **Model (migration 054):** `note_tags` (workspace, name unique case-insensitively, color) and
  `note_tag_links` (note ↔ tag, primary key per pair). Both sides of a link must belong to its
  workspace (trigger). Members manage both under RLS. Deleting a tag removes the label from every
  note; the notes themselves are never touched.
- **Colors:** a fixed palette (gray, red, orange, amber, green, teal, blue, violet, pink), checked
  in the database. The screen draws each one from `--tag-*` variables that are readable in light
  and dark themes. No arbitrary hex values.
- **Tools** (the same path for chat and screen): `notes.listTags`, `notes.tag` (add / remove /
  exact set; missing tags are created when adding), `notes.saveTag` (create, rename, recolor),
  `notes.deleteTag`. `notes.list` and `notes.search` take `tags`: only notes with every one of
  them. In search, a word that names a tag also finds the notes carrying it. All are plain writes:
  every one is reversible, and none deletes a note.
- **Screen:**
  - Every note card has a ⋯ menu in its top-right corner: Editar, Etiquetas (a picker to check
    tags or create one by typing), and Eliminar. Eliminar archives the note, after confirming;
    nothing is hard-deleted.
  - Cards show their tags as colored chips.
  - Tag chips under the search filter the list (`?tags=`, all must match).
  - "Administrar etiquetas" lists every tag to rename, recolor, delete or create.
- **Rollout:** before migration 054 the provider reports no tags, and tag actions say the
  database needs its update. Notes keep working.
