# ADR-065: Conversational repair and canonical entities

**Status:** Accepted (2026-10-15).

## Context

A real conversation:

1. "Agregame una tarea: cargar finanzas en Mielist." Speech recognition heard "Mi ELISE" as
   "Mielist".
2. ELISE created "Cargar finanzas en Mielist".
3. "No, no, ahí te lo escribiste mal. Mielist como tu nombre, mi Elise."
4. ELISE asked whether to correct it, and the user had to explain twice more.

Root causes:

- **The correction was read as Method teaching.** "No, no…" matches the Methods `CORRECTION`
  signal, so `followsUp` kept the previous turn's Method ("Planificación diaria en bloques").
  `teachingHint` then told the model to "ask in one short sentence whether to update the Method":
  that was the extra question.
- **Nothing pointed at the object just written.** Only task, event and email writes left an id in
  the turn's notes. Lists, habits, goals, notes and finance left only `name succeeded`.
- **No rule said a correction is the go-ahead.** The instructions said to ask when unsure, and
  nothing marked a correction as an instruction to act on.
- **ELISE didn't know its own names.** The STT hint was "Assistant: ELISE". Nothing related
  "Mielist" to "Mi ELISE", and titles wrote "Mi elise".

## Decision

### Repair intent

- `src/core/agents/repair.ts` detects corrections in Spanish and English:
  - "lo escribiste mal", "no, era…", "quise decir", "en realidad", "cambialo por", "mejor 15",
    "Marcos con s", "no, leche";
  - "I meant", "you spelled that wrong", "actually, make that…".
- Reverts are detected too: "dejalo como estaba", "deshacelo", "undo that".
- Tentative messages ("capaz…", "maybe") and additions ("además agregá…") are not repairs.
- Detection is regex-based: no extra model call.

### Entity references

- Every successful write leaves a reference in its tool note, for example
  `(ref task:<id> "Cargar finanzas en Mielist" by tasks.create)`.
- The reference is built from the executor's `target` and the tool's display: an
  `EntityReference` with type, id, display name, parent and source action.
- A list item is referenced by its list and its text. `lists.updateItem` now reports the item's
  final text, so chained corrections keep pointing at it.

### Target resolution (deterministic)

- A repair targets what the previous turn wrote.
- If the user names a kind ("la tarea", "el gasto"), only objects of that kind count.
- One object: ELISE fixes it. Several: ELISE asks which, naming them ("¿La tarea o el
  movimiento?"). None: ordinary conversation.
- The model never supplies the id. The turn hint carries the id and the update tool:
  - `tasks.update`, `lists.updateItem`, `habits.update`, `goals.update`, `notes.update`,
    `finance.updateTransaction`.
- For reverts, the previous value comes from the earlier reference to the same id. Undoing a
  creation uses that kind's own delete or archive tool, whose approvals still apply.

### Initiative policy

The core instructions now say:

- A correction of a recent low-risk action is the permission to fix it.
- Fix the same object with its update tool and report in one line ("Corregido: ahora dice …";
  by voice "Listo, corregido.").
- Never ask "¿querés que lo corrija?", never create a duplicate, never contradict the user, and
  don't apologize at length.
- Ask only when several objects fit, or when the change needs approval. The approval policy is
  unchanged: the executor still decides.

### Methods give way

- When a repair has a target, `planTurnMethods({ repair: true })` loads no Method and keeps
  none from the previous turn.
- No teaching hint and no "ask which Method" hint is added. The index stays available.
- Tool selection always includes the repair's update tool.

### Canonical lexicon

`src/core/lexicon.ts` holds:

- **Product terms:** ELISE and Mi ELISE.
- **Unambiguous brands:** ChatGPT, OpenAI, WhatsApp, Power Automate, UiPath, RSFA, UTN, GPT.
  "Make" and "Notion" are everyday words, so they are never re-cased.
- **`applyCanonicalCasing`:** runs inside `normalizeEntityTitle`, so every module's titles follow
  it. "cargar finanzas en mi elise" becomes "Cargar finanzas en Mi ELISE".
- **`findCanonicalReferences`:** compares the message's words with the known names. Those are
  the product terms plus the user's own Knowledge Spaces and Sections, lists and contexts
  (Firbot Solutions, Firbot Academy, UTN… come from these).
  - Matching uses a Spanish-first sound key (silent h, b/v, s/z/soft c, k/qu/hard c, ll/y,
    doubled letters), combined with plain spelling similarity.
  - **Resolved** at confidence 0.9 or more, which needs both sound and context ("como tu
    nombre"). Example: "mielist, como tu nombre" → Mi ELISE.
  - **Suggested** from 0.85 to 0.9: a hint the model weighs, for example a bare "Mielist".
  - **Ambiguous** when one word starts several names ("Firbot"): ask.
  - **Literal** names are kept: "se llama Mielist", "con T al final", "una app externa".
  - Similar real names stay as they are: "Elisa", "mieles".

### Normalization before writes

- Resolved names from this message and from the conversation's last 10 user messages become
  `ToolContext.aliases`.
- The executor applies them, whole words only, to every text argument of a write before
  validation. Reads keep the user's wording.
- The stored transcript is never rewritten: the raw words stay as provenance, and the
  interpretation lives in the turn hint and the write.

### Speech-to-text hints

- The transcription prompt lists the canonical names. The resolver still runs afterwards.
- The GPT-Live session has no transcription hint field in this integration, so it relies on the
  resolver.

### Observability

The logger records these events, with types, confidence buckets and tool names, never content:

- `repair.detected`, `repair.ambiguous`, `repair.target_resolved`;
- `repair.executed`: tool, status, error code, tools called, aliases used, whether a Method
  loaded;
- `canonical_reference.resolved`, `canonical_reference.unresolved`.

## Consequences

- Corrections take one turn and change the same object. The Live Canvas updates through the
  existing target reconciliation; no new refresh path was added.
- No migration: references live in the existing tool notes, and aliases are derived from the
  conversation each turn.
- **Limitation, no undo button:** there is no "Deshacer" button on chat corrections yet. The
  only general undo surfaces are Settings, Methods and Finance. A spoken or written "dejalo como
  estaba" reverts through the same framework.
- **Limitation, one turn back:** repairs reach only the previous turn's writes, plus the earlier
  value of the same object. Older objects are found by name as before.
- **Limitation, aliases per conversation:** aliases last within one conversation and are not
  saved as Memory.
- **Limitation, "Elise" as a person's name:** a contact really called "Elise" is written
  "ELISE" in titles. This needs per-user exceptions if it matters.
