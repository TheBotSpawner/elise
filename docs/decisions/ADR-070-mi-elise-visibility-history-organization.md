# ADR-070: Mi ELISE modules only hide; organizing History (move, rename, pin, archive)

**Status:** Accepted (2026-10-16). Supersedes the gating parts of ADR-064 (a module that's off
had no tools, no context, no Morning Brief block and a guard page). Refines ADR-020 (History ↔
Knowledge links). No migration: migration 047 was never applied and was removed.

## Context

- Turning off Objetivos in Conexiones failed with "ELISE todavía no está configurada del todo
  en el servidor". The choice was stored in `user_module_preferences` (migration 047), which
  production never got: `setModules` threw `SERVER_NOT_CONFIGURED`.
- "Off" also meant more than hidden:
  - the executor refused the module's tools (`moduleOff`);
  - the chat dropped them, and their accounts, from the turn;
  - the Morning Brief skipped their blocks;
  - every module page sat behind a guard.
- History rows had a tags dialog and a delete button, nothing else.
- "Delete" was the only way to get a conversation out of the way.

## Decision: visibility only

- **Three separate things.**
  - **Module data** is the person's goals, tasks and so on; nothing here touches it.
  - **Module capability** is ELISE's tools for it, always available.
  - **Module visibility** is whether it shows in Mi ELISE.
- **What the choice changes.** The Conexiones › Mi ELISE toggle, onboarding and
  `modules.show` / `modules.hide` change visibility only.
- **What stays.** Hidden modules keep their data, tools, Morning Brief blocks, context and
  pages (bookmarks and links from ELISE keep working).
- **Storage.** `user_preferences` key `my_elise.visibility`: the full effective map, per person
  and workspace, under RLS and in a table every environment already has. It survives reloads,
  sign-ins, devices and deploys.
  - Without a saved choice, the registry defaults apply (all shown).
  - Saving writes the whole map, so modules added later follow `defaultForExistingUsers`.
- **One source.** `application/modules-service` provides `moduleVisibility`, `visibleModules`
  and `setModuleVisibility`. The app layout reads it once and the `ModulesContext` gives the
  same list to the desktop dropdown, the phone sheet and the Mi ELISE page. Conexiones lists
  every module, hidden ones too ("Oculto"), so they can be shown again.
- **Removed:**
  - the executor's `moduleOff` and `ExecutorPorts.moduleStates`;
  - the chat's `disabledCapabilities` filtering and its "modules turned off" context line;
  - the brief's `skipped` blocks;
  - `NativeModuleGuard` and its six layouts;
  - `registry.briefBlocks`, `moduleOfCapability`, `moduleOfBriefBlock` and
    `disabledCapabilities`.
- **Audit and feedback.** Audit events are `module.shown` / `module.hidden`. Toasts say
  "Objetivos se ocultó de Mi ELISE." / "Objetivos volvió a Mi ELISE.", with nothing
  destructive and no confirmation.

## Decision: organizing History

- **One source of truth.** Moving uses the existing `interaction_knowledge_links`, the same
  table History folders, chips and the Knowledge page read. Nothing new is stored.
- **Service.** `application/history-organize-service.ts` checks that the thread is this
  person's and the Space is a non-archived Space of their workspace (an id from anywhere else is
  "not found"). It is the layer the UI and a future ELISE tool share:
  - **moveThread(thread, spaceId | null)**:
    - the target becomes one manual link;
    - every other link becomes a manual removal, so automatic tagging doesn't bring it back;
    - null means "Sin Espacio" (no link; General is a real Space, never assumed);
    - audited as `conversation.space_changed {from, to}`;
    - messages, timestamps, Recall chunks and embeddings are untouched.
  - **renameThread** sets `conversations.title` and the session's title. It also sets
    `interaction_sessions.metadata.titleLocked`, so a later summary never replaces the
    person's title (`recall-service.saveSession`).
  - **pinThread** stores `user_preferences` `history.pinned` (thread keys, at most 50).
    Pinned rows come first wherever they are listed (`historyRows`, `recentThreads`), once.
  - **setConversationArchived** sets `conversations.status`.
    - Archived conversations leave the normal views and appear under "Archivadas"
      (`/chat?view=archived`).
    - Their messages, links and Recall stay.
    - Voice sessions have no archive (archiving one is how it is deleted), so they offer only
      Delete.
- **Delete** stays the existing flow (`archived_at`), which also makes Recall forget the
  conversation. It needs a confirmation that says so.
- **UI.** `features/history/organize.tsx`:
  - **"…" menu (`OverflowMenu`):**
    - Renombrar, Mover a Espacio, Quitar del Espacio (when filed), Fijar/Desfijar,
      Archivar/Desarchivar, Eliminar;
    - an anchored menu on desktop (visible on hover and focus), a sheet on phones;
    - accessible names such as "Opciones de conversación: …".
  - **Mover a Espacio** is a dialog listing Spaces and their Sections with their own Knowledge
    glyphs, with search from 7 Spaces. It is a full-width sheet on phones.
  - **Drag & drop**, with a fine pointer only. A row can be dropped on a Space or Section
    folder, on "Sin Espacio", or on a Space filter chip. Targets show a dashed accent outline
    while dragging and a solid one with "Soltar acá" when hovered. Only real Spaces accept a
    drop.
  - **Optimistic UI.** The row leaves its folder at once (moved, archived, deleted). On success
    History re-reads (`router.refresh`); on failure the row comes back with "No pudimos mover
    la conversación. Probá nuevamente."
- **Replaced.** The tags dialog (`TagEditor`) and the separate delete button. Extra links still
  show as chips.

## Consequences

- Hiding a module can't fail on a missing table, and nothing about it can lose or block data.
- Production needs nothing applied for this; 046 (Slack) is still pending separately.
- Not built:
  - moving a conversation from inside the open conversation, so its breadcrumb updates on the
    next load;
  - an ELISE tool for "mové esta conversación a…" (the service is ready for one).
