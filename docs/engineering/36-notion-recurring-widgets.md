# Reliable Notion, recurring tasks, relevant widgets — report (ADR-114, ADR-115)

Date: 2026-10-23.

## 1. Notion retrieval: the KB article wasn't found

**Root cause.** For "¿Buscás en la Knowledge Base ese artículo que tiene eficiencia de tokens?":
- `searchTerms` kept the first 6 terms: `buscas, knowledge, base, ese, articulo, tiene`.
- After removing the scope name, the provider was searched for
  `buscas, ese, articulo, tiene`. "eficiencia" and "tokens" never reached Notion.

**Fix:**
- Rioplatense request words are now stop words (`retrieval.ts`).
- The 8 longest terms are kept, in order (`live.ts`).
- Kind words ("artículo", "post"…) are dropped from the subject unless nothing else is left.
- The child databases of a connected page are ranked by name, up to 4 instead of the first 2
  (`application/knowledge-live.ts`).

**Before / after:**

| | Subject terms |
| --- | --- |
| Before | `[buscas, ese, articulo, tiene]` |
| After | includes `eficiencia, tokens` |

Covered by the evaluation suite.

**Verified structure** (the user's Notion, read only through the claude.ai connector):
- "Knowledge Base" holds the child databases "Temas" and "Artículos".
- The article lives in "Artículos".
- The ELISE source "Pipeline de Proyectos +8 · Firbot" has the "Knowledge Base" page among its
  roots.
- Nothing private was copied into fixtures or logs.

## 2. "¿Cuál es mi último post publicado?"

**Root cause.** No tool meant "latest published". The model chained three tools:

| Tool | What it drew |
| --- | --- |
| `structured.listSources` | A giant "Bases de datos" card in the chat. It was already plumbing on the Canvas, but the chat thread drew every display. |
| `structured.analyze` | Pipeline KPIs: the "5", "Ganadas/Perdidas". |
| `structured.query` | Unsorted records. |

`findInDatabase`'s "recent" path sorts by creation, not publication.

**Fix (ADR-114):**
- `structured.latest`: latest by publication date among published records, with the start of the
  winner's body and up to 5 earlier ones. It states its criterion and its fallbacks.
- Lookups no longer draw cards in the chat (`isPlumbing`).
- `latest` supersedes the turn's search, query and analysis cards.
- "post/posteo/publicado" bring the database tools.
- Guidance says "never answer the latest with analyze or a list of databases".

**Before / after:**
- **Before:** three cards, KPIs and no answer.
- **After:** one record card (title, fields, excerpt, "Anteriores"). The answer leads with the
  title, date and summary, in voice too.

## 3. Not found, said precisely

`knowledge.search` with no evidence now distinguishes three cases:
- **No access:** a connected source failed; it's an access problem.
- **Not found:** connected sources were searched live and had no match. The page may need
  sharing with ELISE and adding in Conocimiento.
- **Not in what ELISE has:** no connected source covers the scope; only indexed documents were
  searched.

## 4. Managing sources in Conocimiento

The section is now titled "Fuentes conectadas". Each source's ••• menu offers:
- **Ver en Notion/Drive**, for a single root;
- **Ver qué contiene:** state, last check, next check, last error, and every root with its link;
- **Comprobar/Sincronizar ahora;**
- **Quitar de este espacio:** `purgeSources` deletes the index: items, versions, chunks and
  stored originals;
- **Desconectar cuenta…:** opens Connections, where disconnecting purges that account's
  Knowledge.

Statuses are the existing `sourceState` (up to date, syncing, needs attention, disconnected…).

## 5. Widgets

The answer comes first. One primary card, plus an optional compact secondary list inside it.
- No lookup cards in the chat.
- No KPI analysis for "the latest".
- The record card carries the excerpt and the "Anteriores" list.
- Tool instructions make voice say the substance, not "lo dejé en pantalla".
- Existing presentation discipline still applies: a budget of 4 per turn, consolidation and
  supersede.

## 6. Recurring tasks (ADR-115)

**Core:** `src/core/tasks/recurrence.ts`:
- the `repeatSchema`;
- RRULE to and from the rule;
- `nextOccurrence`, `nextAfterCompletion`;
- `describeRepeat` in Spanish and English.

**Storage:**
- Migration `20261117000066_task_recurrences.sql`: idempotent, with RLS, and a unique active
  series per live task.
- `infrastructure/providers/task-recurrence.ts`.

**Behaviour:** `EnrichedTaskProvider`.
- create/update take `repeat`/`repeatScope`;
- complete creates the next occurrence through an atomic claim;
- outside completions are caught up on full reads;
- archive ends the series.

**UI:** `features/tasks/repeat-field.tsx`:
- the "Repetir" field in task detail, with presets, a custom editor and the scope switch;
- a repeat icon on rows.

**Chat and voice:** `tasks.*` descriptions and the context guidance.

### Applying the migration (production — not done; needs the owner's go-ahead)

1. **Back up** (Supabase dashboard → Database → Backups), or
   `pg_dump --schema=public --table=task_recurrences` if re-applying.
2. **Apply:** `npx supabase db push`. Migrations 062–065 are pending too (see the earlier
   reports).
3. **Verify:** `select count(*) from public.task_recurrences;` returns 0. Then create a task with
   "Repetir → Todas las semanas" and complete it: a new task appears with the next date.
4. **Roll back:** `drop table if exists public.task_recurrences;`. Tasks keep working; series
   stop advancing.

Until it's applied, tasks work exactly as before, and asking for a repeat answers that the
database needs the update.

## 7. Tests

| File | Covers |
| --- | --- |
| `tests/unit/structured-latest.test.ts` (9) | The plan (publication date, published status/checkbox, fallbacks), the tool (one query, excerpt, previous, nothing published), plumbing, supersede, intent. |
| `tests/unit/core/task-recurrence.test.ts` (13) | Daily/N, weekly days, weekdays, monthly day with clamp, last day, ordinals, yearly 29 Feb, UNTIL, dates across DST, skipping the past, COUNT, RRULE round trip and refusal, Spanish wording. |
| `tests/unit/core/task-recurrence-provider.test.ts` (7) | Series stored, completing creates the next once (twice → once), COUNT ends, this/all/following, stop, a first date for an undated task. |
| `tests/integration/task-recurrences.test.ts` (4, PGlite) | Unique live series, atomic claim, cross-workspace denial (RLS), migration re-run. |
| `tests/unit/eval-rioplatense.test.ts` (18) | 17 Rioplatense queries plus one ending check. Notion: subject terms survive, and "último post/posteo/publicado" brings the database tools. Recurrence: the rule each phrase maps to, with its next real dates. |

## 8. Pending live checks (need the deployed app and the owner's data)

- Ask "¿Buscás en la Knowledge Base ese artículo que tiene eficiencia de tokens?" in Web and
  Desktop. It should cite "BP - Claude - Eficiencia de Tokens".
- Ask "¿Cuál es mi último post publicado?" against the real posts database. Check which fields it
  used: the answer states the criterion.
- Create, complete and edit a recurring Google Tasks task, then complete one in the Google Tasks
  app and reopen ELISE's task list.
- The model's natural-language-to-rule mapping across the 11 recurrence phrases, in a live model
  run. The suite checks the rules, not the model.
