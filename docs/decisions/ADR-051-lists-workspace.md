# ADR-051: Lists workspace — horizontal checklists

**Status:** Accepted (2026-10-12). Extends ADR-008 (My Elise native) and reuses the label
system of ADR-050. Migration `20261019000038_lists_workspace.sql` (requires 037).

## Context

My Elise → Lists was one narrow column of list cards, and each list opened on its own page.
Lists should work like several checklists side by side.

**Lists are not Tasks.** They have no dates, reminders, priorities, subtasks or provider
sync. They keep their own model, tools and UI. Only the generic label system is shared.

## What existed (kept)

- **Data:**
  - `lists`: name, description, status, archived_at.
  - `list_items`: content, checked, sparse `position`, `notes`, soft delete.
- **Tools:** `lists.list/get/create/rename/addItem` (already a batch), `check/uncheck/updateItem`,
  `removeItem`, `archive`.
- **Other:** CSV import, the chat `native_list` card, and Realtime on `lists` and `list_items`.

Every id, item and checked state is preserved.

## Decision

### Data (migration 038, additive)

- **`lists`:**
  - `position`, backfilled per workspace in creation order, so existing users see the order
    they always had;
  - `icon` (an emoji);
  - `item_sort` (`manual | alpha | recent`, default manual).
- **`list_items.checked_at`:** existing checked items get their `updated_at` as an estimate.
  Completed items are listed most recently checked first.
- **Item description** is the existing `notes` column (up to 1000 chars, multiline).
- **Labels:**
  - `label_assignments.list_item_id` joins the one label system (ADR-050).
  - The target check becomes "exactly one of task / enrichment / list item".
  - RLS checks that every reference is in the same workspace.
- **Before 038 is applied**, the provider reads `select *`:
  - Order falls back to creation order, and lists have no icon or labels.
  - Writes that need the new columns say "needs the latest ELISE database update". Nothing
    breaks.

### Starter lists

🛍️ Lista de Compras and 🛩️ Lista de Viaje ("Shopping List" and "Travel List" in English) are
ordinary user lists, created **once** by `seedStarterLists`:

1. The `user_preferences` marker `lists.starters_seeded` is claimed first. It is unique per
   workspace, user and key, so concurrent page loads can't seed twice.
2. A starter is skipped if an equivalent list exists ("compra/shopping/supermercado/groceri",
   "viaje/travel/trip/packing/equipaje").
3. A workspace with 3 or more lists gets no suggestions.

Starters are never recreated after a delete. This is not a migration that forces defaults.

### Tools (canonical, native)

- **New:**
  - `lists.update` (name, description, icon, sort);
  - `lists.moveItem` (another list, same item, keeps its description and labels);
  - `lists.clearChecked` (soft delete, so no approval prompt);
  - `lists.duplicate` (items copied **unchecked**, with their descriptions and labels).
- **`lists.addItem`** takes every item in one call, each a string or `{content, notes}`. It is
  one insert.
- **`lists.updateItem`** gains `addLabels` and `removeLabels`.
- **`lists.get` / the model output** list open items first and checked ones after, with the
  description and labels only when present.
- **List resolution (`matchLists`):**
  1. id;
  2. exact name;
  3. every meaningful word ("la lista del viaje" → "Lista de Viaje", "compras" → "🛍️ Lista de
     Compras"), ignoring filler words and emoji;
  4. a partial name.

  Several equally good matches are all returned, and ELISE asks.
- **Model guidance:** lists are checklists, not tasks; several items go in one call; the list on
  screen updates itself.

### Live Canvas

A new `checklist` Surface keyed by the list id:

- `lists.get`, `create`, `addItem`, `check`, `move` and the others all update the same window,
  never a new one.
- It always carries the `lists.get` query for its list, so Realtime changes from the Lists page
  or another tab refresh it, even when a write showed it.
- It renders active items above, with "Completados (n)" collapsed below. Check and uncheck run
  `lists.checkItem` and `lists.uncheckItem` through the executor.
- "Open" links to the column on `/my-elise/lists?focus=<id>`.

### UI (`features/native/lists-workspace.tsx`)

- **Layout:** one horizontal board of columns, 300–312 px each, side by side and scrolled
  horizontally.
  - Trackpad, shift-wheel and touch all scroll it. The scrollbar is thin, and edge arrows appear
    on desktop only when there is more to see.
  - The horizontal position is remembered for the session.
  - On mobile, each column is the screen width with snap.
  - A "Ir a la lista" navigator appears with more than 3 lists.
- **Column header:** emoji, name (click to rename inline), open count, and a "⋯" menu:
  - sort (my order / name / most recent);
  - rename, edit description, change icon;
  - move left or right (the accessible alternative to dragging);
  - duplicate;
  - clear completed (with confirmation);
  - delete list ("¿Eliminar 'X' y sus N elementos?").
- **Items:**
  - Quick add stays focused: Enter adds and keeps typing, and commas add several. Esc leaves.
  - Rows are dense: a circle, the title, and a one-line preview of the description and labels.
  - Checking moves the item to the collapsible **Completados (n)** section at the bottom,
    expanded when 3 or fewer. Unchecking moves it back.
- **Drag and drop (HTML5):**
  - Columns reorder by their grip, saved as `position`.
  - Items reorder within a list when its sort is "my order".
  - Dropping on another column moves the item, then orders it there.
  - Every drag is optimistic. A failed save toasts and restores; nothing is faked.
- **Item detail:** a sheet with name, description, labels (reused, with autocomplete), list
  (move), completed and delete. It never shows a date, priority, reminder or provider.
- **Search:**
  - It filters the board in place: columns whose name matches, and items whose title,
    description or labels match.
  - Completed items show while searching.
  - Scroll position and expanded state are untouched.
- **New list** adds an inline column. After it is created, the board scrolls to it and focuses
  its first input.
- **Keyboard:** / search, N add to the first list, Esc closes.
- **Routes:** `/my-elise/lists/[id]` redirects to the column, so old links keep working.

### Home and Morning Brief

Unchanged. Lists are passive and never appear as due work.

## Not done / pending

- **Migration 038** must be applied after 037 (`npx supabase db push`). Until then: creation
  order, no icon, no labels, no persisted column order.
- **Real-browser validation with your real lists and the chat turns** (part AP of the brief).
- **Drag and drop on touch** uses the native HTML5 behavior, which mobile browsers support
  poorly. On mobile, items move through "Lista" in the item detail, and columns move through
  "Mover a la izquierda/derecha".
- **Virtualization** is not needed at the measured sizes (20 lists × 50 items render as about
  1,000 light rows). Revisit if lists grow into the thousands.

## Consequences

- One label system serves Tasks and Lists without coupling the two domains.
- A List Surface in chat and the Lists page are the same data and refresh each other.
