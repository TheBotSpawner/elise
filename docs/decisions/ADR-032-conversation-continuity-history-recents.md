# ADR-032: Conversation continuity per tab, explicit New Chat, History "Recientes"

**Status:** Accepted (2026-10-03). Extends ADR-013 (Live Workspace), ADR-020 (History links) and
ADR-029 (History folders). No migration.

## Why Home lost the active conversation

The active interaction lived only in the URL. After the first turn, the chat replaces `/` with
`/chat/{id}` (or `/?session={id}`). But "Inicio", the logo and History's "Nueva conversación"
all linked to a bare `/`. That URL always rendered a fresh `ChatSurface`, keyed `home`, with no
thread. So any trip away from the conversation and back through Inicio silently started over.

## Decision

**Pointer.**

- `sessionStorage["elise.activeThread"]` holds the tab's active interaction as
  `{ kind: "conversation" | "session", id }`. It stores only the id; contents stay on the server.
- This gives tab semantics:
  - It survives in-app navigation and reloads.
  - It disappears when the tab closes.
  - Each tab has its own, so tabs never compete for it.
- Duplicating a tab copies `sessionStorage` (browser behavior), so the copy starts on the same
  conversation and then diverges.
- No profile state and no database changes.

**Becoming active.**

- Opening any interaction makes it active: a `/chat/{id}` deep link, a History or Recientes row,
  or `/?session={id}`.
- The first turn of a new interaction does the same (`use-elise-chat`, on the `conversation`
  event).

**Routing.**

- Conversation URLs are unchanged and deep links keep working.
- Inicio and the logo resolve on the client to the active interaction's URL (`homeHref`). Normal
  navigation therefore never redirects or flickers.
- A bare `/` visit with an active pointer (typed URL, the error page's link) opens it with
  `router.replace`.
  - On a full load, an inline pre-paint script (`RESUME_SCRIPT`) sets `html[data-resuming]` and
    CSS hides `.elise-home`, so a fresh Home never flashes.
  - Only a bare `/` resumes. `?space=`, `?run=` and `?welcome=` remain explicit fresh starts.
- The arrival rules are one pure function, `homeArrival`, and are tested.

**Missing conversations.** `/chat/{id}` for a conversation that is archived (deleted from
History), not the user's, or missing redirects to `/?gone={id}`. Home forgets the pointer if it
was that id and shows a fresh Home, with no infinite loading. Voice sessions that no longer exist
are handled the same way. `loadConversation` now excludes archived conversations.

**Live Workspace.** It is restored exactly as before, by the conversation page
(`loadWorkspace`). Restoring means navigating to the conversation, so no workspace is duplicated.

**Navigation highlight.** `/chat/{id}` highlights **Inicio**: a conversation is the interaction
in use. `/chat` (the archive) highlights **Historial**.

**New Chat.**

- "+ Nueva conversación" is a quiet pill. On desktop it sits at the right of the Canvas
  breadcrumb row, or above the thread in the conversation composition. On phones it is the
  compose icon in the header. History's header uses the same action.
- It forgets the pointer, discards the draft (including staged attachments) and opens
  `/?new={nonce}`. The nonce remounts Home, and the mark is removed from the URL on arrival.
- Nothing is archived and nothing is created; the next first message creates the conversation.
- The "Continuar" line is hidden right after New Chat, so it doesn't offer the conversation just
  left. With an active pointer the conversation itself is restored, so "Continuar" and the
  restored conversation never show together.

**Draft protection.**

- When there is typed text or draft attachments, the first press turns the pill into
  "Descartar borrador y empezar otra" for 5 seconds. A second press confirms. There is no modal.
- Typed text does not survive leaving Home (unchanged behavior). Draft attachments do survive in
  the tab (ADR-031).

## History "Recientes"

- In the default grouping (Espacio), the page shows two sections: **Espacios** (the folders,
  unchanged) and then **Recientes**.
- **Recientes** lists the 10 most recently active threads, newest first, across every folder:
  - each row shows its title, `Space › Section` or "Sin Espacio", and a compact relative time;
  - a voice thread shows a mic icon;
  - "Ver todas" opens the flat list with the same filter.
- **Ordering** uses activity: `conversations.last_message_at` and voice
  `interaction_sessions.last_activity_at`. The page's sort setting is ignored for this list.
- **Filters.** Recientes uses the rows the current filter already selected:
  - with "Todas" it covers everything;
  - with a Space or Section filter it shows that Space's threads, titled "Recientes en X";
  - with "Sin Espacio" it shows unassigned threads.
- **Search** replaces both sections with the flat global result list, as before.
- **Other groupings.** The Nada (flat, chronological) and Sección groupings don't show
  Recientes, because the flat list is already the same list.
- **Performance.** Only metadata the page already loads is used: titles, summaries, timestamps
  and links. No message bodies are read.
- **Mobile.** The same order applies (search, folders, Recientes), with compact rows.
