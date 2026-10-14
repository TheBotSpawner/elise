# ADR-059: Knowledge and Methods UX refinement

**Status:** Accepted (2026-10-14). Refines ADR-040 (Methods) and ADR-047 (General). No migration.

## Context

- **Helper copy:** Knowledge pages carried several permanent helper sentences (General's intro,
  context and sources hints, the Methods hierarchy and its examples). They competed with the
  user's own content.
- **Vocabulary:** source actions mixed "Sumar" and "Agregar".
- **Back control:** a plain "Conocimiento" text that didn't look like navigation.
- **"Armar el método":** it put the user's opening sentence into Name and "¿Qué tiene que saber
  hacer ELISE?" and the raw text into Instructions.
  - Root cause: the model answer was parsed from free prose, and any unusable answer silently
    fell back to "first sentence everywhere".
- **"Dónde aplica":** the new Method form asked for scope again, although it was opened inside
  a scope.

## Decision

- **ⓘ instead of permanent helper copy:** `InfoTip`, a compact card next to a title or heading.
  - Opens on hover (mouse) and on click/tap. Esc, a click outside or scrolling closes it.
  - It is kept on screen, has an accessible label ("Acerca de los Métodos") and works in light
    and dark.
  - Used for: General (title), Contexto, Métodos (hierarchy + examples) and Fuentes.
  - Warnings, errors, counts and statuses stay on the page.
  - **General's description:** the default one written by the database
    (`GENERAL_DEFAULT_DESCRIPTION`) is product copy and moves behind ⓘ. A description the user
    wrote always shows.
- **Vocabulary:** "Agregar fuente", "Subir documentos", "Nueva sección", "Nuevo método",
  "Importar método". Only the Knowledge context changed.
- **Back:** `BackLink` ("‹ Conocimiento", "‹ Firbot Marketing"). Section → its Space, Space →
  Knowledge, document → its Space. The whole control is the link, with an accessible label.
- **Methods:**
  - **Empty state:** "Todavía no hay métodos." plus a subtle "Creá uno…".
  - **Actions:** "Nuevo método" is a secondary button at the size of the page's other actions.
  - **Import:** only `.md` / `.txt`, checked by name, type and text content (no NUL bytes) in
    the browser and again in the server action. Anything else gets one clear message.
- **Scope is where the form was opened:**
  - The new Method form has no "Dónde aplica". General → workspace-wide (`space_id` null);
    a Space → that Space; a Section → that Section.
  - A non-editable hint says where it will be saved ("Se guardará en General.").
  - Editing a saved Method keeps its selector, so it can still be moved.
  - Precedence is unchanged: Section > Space > General. The model never decides scope.
- **"Armar el método" (`core/skills/draft.ts`):**
  - **Structured output:** the AI port gains an optional `output` JSON schema (OpenAI:
    `text.format = json_schema`, strict). The fields are `name`, `capability`, `instructions`,
    `hints`; there is no scope or permission field.
  - **Prompt:**
    - name: 2–7 words, a label, not the opening words;
    - capability: one sentence about the result;
    - instructions: numbered imperative steps plus rules, keeping every constraint, dropping
      filler, inventing nothing. An already good procedure is kept nearly as is.
  - **Deterministic checks (`draftProblems`)** flag:
    - a name that is too long or copies the opening words;
    - a name ≈ the capability (word overlap);
    - a capability ≈ the instructions or that lists steps.
  - **On a malformed or unparseable answer:** one retry, given the reasons.
  - **Then the safe result:** the user's text goes to Instructions only, Name and capability
    stay empty for the user, and a toast says so. The three fields are never filled with the
    same text.
  - **Model:** the standard tier with low reasoning (rare, user-requested, quality-sensitive).
- **Connections (same release):**
  - Provider descriptions show whole, in up to two lines.
  - The Google/Microsoft connect action is a regular button beside the title instead of a
    dashed tile that could clip.

## Consequences

- Knowledge pages show content, actions and state; explanations are one tap away.
- Method drafts come out as three distinct fields, or the user is told clearly that the text
  couldn't be structured. Validated with the real model on the user's planning procedure.
- Any side task can now request structured output through the AI port.
