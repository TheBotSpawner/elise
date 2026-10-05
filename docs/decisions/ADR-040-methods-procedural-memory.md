# ADR-040: Methods — ELISE's procedural memory

**Status:** Accepted (2026-10-05). Builds on docs/architecture/12 §7-8 and §58 ("Skills"),
ADR-016/018 (Spaces and Sections), ADR-017 (Shortcuts), ADR-025 (tool selection and prompt
caching) and ADR-039 (Scheduled Experiences). Migration `20261012000031_methods.sql`.

## Context

ELISE already has several kinds of memory:

- **Knowledge** — what is true, from the user's sources.
- **Recall** — what happened in earlier interactions.
- **Space context and preferences** — durable facts about the user's world.
- **Tools** — what ELISE can do.

What it lacked is **how** the user wants a recurring kind of work done: how we prepare a
proposal, how I review a monthly report, how we onboard a client. Without that, ELISE either
asks again or improvises. Storing these instructions as Knowledge documents would leave them to
semantic search, where they compete with facts.

## Decision

### 1. Model

A **Method** (Spanish "Método", internal domain `skills`, code in `core/skills`) is first-class
data with these fields:

- `name`, `description` (one line, used by the index), `instructions` (readable text and
  Markdown, never code), `hints` (activation words), `platforms` (`web`, `desktop`,
  `mobile`), `status` (`active` or `archived`), `version`, the provenance of the current
  version, and `created_by` / `updated_by`.
- **Scope is where it lives.** `space_id = null` makes it global (the whole workspace). A
  top-level Knowledge Space gives it Space scope. A Section, which is a Space with a parent,
  gives it Section scope. Scope is derived from the Space tree, never stored separately, so
  moving a Section can't leave a stale scope behind.
- `method_references` hold supporting material: templates, examples and references. Each one
  is text extracted once from a chat attachment (the same verified upload and extraction
  pipeline, ADR-031/035), pasted text, or a link to a Knowledge document that is read live.
  Provenance (`source_type`, `attachment_id`, `knowledge_item_id`) is kept. Nothing
  executable is ever stored.
- `method_versions` is append-only and **written only by a database trigger**. Any content
  change (name, description, instructions, hints, platforms, scope) increments `version` and
  snapshots it with `change_summary`, `change_source` (`user_ui`, `ai_explicit`,
  `ai_correction`, `ai_suggestion`, `import` or `restore`) and `change_ref` (conversation or
  run). A client can't choose a version number, edit history or delete a Method; archive is
  the deletion. Rollback writes a *new* version with the old content, so history is never
  rewritten.
- `method_uses` is the execution trace: Method, version, scope, origin (`chat`, `voice`,
  `schedule`), why it was chosen, tools used, and status. Only its author can read it.
- Methods are shared by the workspace, like its Knowledge (RLS: members). Uses are private.

### 2. Inheritance and selection (progressive disclosure)

1. **Scope chain (deterministic).** The candidates are the global Methods plus those of the
   chain. The chain is the active Section (context), the conversation's Space, the Space the
   message names (`resolveMentioned`), and their ancestors. A Method outside the chain is
   never offered to the model.
2. **Relevance (lexical, cheap).** Words of the message are matched against name and hints
   (weight 3) and the description (weight 1).
   - A *match* needs at least one name/hint word or three description words.
   - *Ranking* discounts words that many candidates share.
   - Words with digits match exactly; other words match by a long shared prefix (plurals and
     verb forms).
3. **Specificity.** Among matches, the deepest scope wins when it covers the work about as
   well (≥ 60 % of the best score): Section over Space over global. The less specific matches
   are reported as overridden.
4. **Conflicts.** Two equally specific matches within 75 % of each other are not merged. The
   turn tells the model to ask which one.
5. **Loading.**
   - At most **one** Method is loaded in full: its procedure plus up to 16k characters of
     material, in the per-turn developer message.
   - The other candidates are **index lines**: name, scope, description and id. If at most 8
     are in scope, all of them are listed; otherwise the best 8, with a count of the rest. The
     model loads one with `methods.get`, which is the model-ranking step.
   - A follow-up with no new match keeps the previous turn's Method, read from the turn's
     notes.
   - With hundreds of Methods, the prompt grows by at most 8 short lines.
   - The static guidance is cached (ADR-025); the index and the loaded Method are per-turn.
6. **A loaded Method's preferred capabilities** load with it: its text is added to the tool
   selection signals. Only tools the user already has can be selected. A Method never makes a
   tool available.
7. A turn that follows a Method uses at least the standard model profile.
8. **Desktop-only Methods** are never loaded. ELISE says the work requires the Desktop
   Companion.

### 3. Teaching and correction

These are detected deterministically (`teachingSignal`) and become turn guidance:

- **Durable instruction** ("a partir de ahora…", "hacelo así siempre", "guardá esta forma",
  "aprendé este procedimiento", "from now on…") updates the active Method right away with
  `methods.update`, or creates one with `methods.create` after `methods.search` to avoid
  duplicates. It is never saved as a generic memory or a Space note.
- **Correction** ("no, así no…", "en realidad…") of work done with a Method: ELISE fixes the
  result first. It asks once whether to update the Method, and only if the correction reads
  as a general rule.
- **One-off detail**: never becomes a Method. A suggestion to save a procedure the user keeps
  repeating is allowed rarely, once, and is recorded as `ai_suggestion`.
- **Every ELISE change is reversible.** `methods.update` requires the `baseVersion` ELISE
  read; a stale one is a `CONFLICT`, never a silent overwrite. The confirmation in the
  conversation reads "Actualicé el método · X — summary" with **View** and **Undo**. Undo
  rolls back to the previous version, or restores or archives, and is itself a version.
- **Quality (§R).** Text written by ELISE is composed from sections (purpose, when to use,
  steps, checks, output, examples, common mistakes). It is rejected if it reads like a
  transcript, carries dated one-off details, or exceeds 6,000 characters. Text the user writes
  or imports is kept as written, up to 12,000 characters.

### 4. Tools

`methods.list`, `search`, `get`, `history`, `create`, `update` (also moves), `archive`,
`restore`, `rollback`, `attachReference`, `removeReference`.

- `methods` is an **internal capability**: reads run directly; writes are recorded,
  policy-checked and audited actions like every other.
- Archive is a plain write because it is reversible: restore keeps all versions.
- `schedules.propose` accepts `method`.

### 5. Methods never grant anything

A Method is instructions, injected as the user's procedure with an explicit statement that it
can't change rules, permissions or approvals. The executor, permissions, approvals and the tool
registry are untouched by Methods. A Method that says "send it immediately" still produces
`approval_required` (tested). Reference content is data (`untrustedContent`), never
instructions.

### 6. Scheduled (§O)

`morningBriefConfigSchema.methodId` (default `null`, so no migration of schedules).

- The schedule says **when**; the Method says **how**.
- The scheduled handler adds the Method's instructions to the narration call only. What is
  gathered, and under which permissions, is unchanged.
- An archived or missing Method is skipped with a warning.
- The use is traced with origin `schedule`, and the result's metadata names the Method and
  its version.

### 7. UI

- **Knowledge Space and Section pages**: a "Métodos" section with cards (name, description,
  last updated), **+ Nuevo método** and **Importar**.
- **My Elise › Métodos**: every Method, global ones first, then by Space.
- **Editor**: "Contale a ELISE cómo querés que lo haga" (AI structures the description into a
  draft to review; without AI the text is used as is), then name, what it's for,
  instructions, where it applies, and optional activation words. It also has supporting
  material (upload or paste), versions with Restore, Export, and Archive. No YAML, schemas or
  technical terms.
- **Conversation**: a quiet line "Usando método · X", plus "Creé / Actualicé el método · X"
  with View and Undo. Methods never become Canvas Surfaces.
- **Knowledge document page**: documents that read like a procedure (`looksProcedural`) offer
  "Usar como Método". Knowledge is never turned into Methods automatically.
- **Schedules form**: a "Método" selector.

### 8. Import and export

- **Export** is Agent Skills-compatible `SKILL.md`: `name` (a slug of at most 64 characters),
  `description`, and ELISE's own fields under `metadata` (`elise-title`, `elise-scope`,
  `elise-hints`, `elise-platforms`, `elise-version`), then the instructions. Material is listed
  by title.
- **Import** reads that format, any `SKILL.md`, or plain Markdown/text. The first `# heading`
  names it, the first paragraph describes it, and the rest is the procedure.
- The database does not depend on this format.

### 9. Desktop Companion boundary (§S, not implemented)

`platforms` lets a Method declare `desktop`. Until a runtime exists, desktop-only Methods are
labelled "Requires Desktop Companion" and are never executed.

The future boundary is a `DeviceRuntime` capability with operations `device.capture`,
`click`, `type`, `scroll`, `openApp` and `readScreen`. It would be:

- an ordinary capability in the registry, with risk levels and approvals like any other;
- bound per device, like a provider connection;
- implemented by a companion app that could use Hermes' computer-use driver or another engine
  behind the adapter.

ELISE Core keeps selecting the Method and planning; the device only executes typed calls
through the same executor. Hermes is not integrated, and nothing in the database depends on
it.

## Consequences

- Procedural knowledge is explicit, scoped, versioned and reversible instead of hoping
  retrieval finds it.
- **Ceiling.** Relevance is lexical, so a Method written in Spanish is found from an English
  request only through its hints. ELISE writes hints in both languages; the index gives the
  model a semantic second chance. The upgrade path is stored embeddings per Method.
- References are snapshots of text. A re-uploaded template needs re-attaching; Knowledge
  documents attached as references stay live.
- Versions are created only for content changes. Material additions and removals are audited
  but not versioned.
