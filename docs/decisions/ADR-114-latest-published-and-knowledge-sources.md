# ADR-114: "The latest published", honest not-found, and managing Knowledge sources

**Status:** Accepted (2026-10-23). Extends ADR-046 (live Knowledge), ADR-048 (presentation
discipline) and ADR-011 (structured data).

## Context

Three failures were reported:

1. **"¿Buscás en la Knowledge Base ese artículo que tiene eficiencia de tokens?"** didn't find
   "BP - Claude - Eficiencia de Tokens".
2. **"¿Cuál es mi último post publicado?"** got the wrong answer, made of three tool results:
   - a giant "Bases de datos" list (`structured.listSources`);
   - pipeline KPIs (`structured.analyze`: a "5", "Ganadas/Perdidas");
   - unsorted records (`structured.query`).

   There was no notion of "latest by publication date among published".
3. **Conocimiento** had no way to see what a connected source covers or to open it in Notion. It
   also never said whether "not found" meant no access, not indexed, or really absent.

## Decision

1. **Retrieval terms keep the subject.** These changes are in `core/knowledge/live.ts` and
   `retrieval.ts`:
   - Rioplatense request words are stop words ("buscás, ese, tiene, mostrame…").
   - A long question keeps its 8 longest terms, in order, instead of the first 6.
   - Kind words ("artículo, post, página…") narrow the search only when nothing else is left.
   - A connected page's child databases are ranked by name against the question. Up to four
     are queried (it was the first two).
2. **`structured.latest`** (core `structured/latest.ts` + tool) is defined from the mapped
   schema, deterministically:
   - **Publication date:** a date field (or created-time) whose name says publication
     ("Fecha de publicación", "Published", "Lanzamiento"…).
   - **Published:** a status/select option ("Publicado", "Published", "Live", "Subido"…), or a
     checkbox named "Publicado".
   - **Query:** one query filtered to published records with a publication date, sorted by that
     date (descending), then by last edit.
   - **Without a publication date,** the last edit is used, and ELISE says it is not a
     publication date.
   - **Without a published status,** ELISE says it can't tell published from drafts.
   - **The winner's body** is read: one request for the first 100 top-level blocks, bounded to
     1,500 characters. Optionally up to 5 earlier records are returned, in order.
3. **One answer object, not plumbing.**
   - `structured.listSources` / `getSchema` (lookups) no longer draw a card in the chat thread,
     as they already didn't on the Canvas (`isPlumbing`).
   - `structured.latest` shows one record card: the start of its body plus a compact "Anteriores"
     list.
   - It supersedes the turn's `knowledge.search`, `structured.query` and `structured.analyze`.
   - `structured.analyze` says it is not for "the latest" or for one record.
   - Its instructions are voice-first: title, date and summary, never "te lo dejé en pantalla".
4. **Not found is said precisely.** `knowledge.search` with no evidence tells the model which
   case it is:
   - **An access problem:** a connected source couldn't be read.
   - **Not found:** the connected sources were searched live and had no match. The page may
     need to be shared with ELISE and added in Conocimiento.
   - **Not in what ELISE has:** no connected source covers the scope, so only indexed documents
     were searched.
5. **Conocimiento → Fuentes conectadas.** Each source's ••• menu offers:
   - **Ver en Notion/Drive:** shown when it follows one root.
   - **Ver qué contiene:** the state plus every root, each with its link.
   - **Comprobar/Sincronizar ahora.**
   - **Quitar de este espacio:** it already deleted what ELISE indexed from that source (items,
     versions, chunks, originals) and never touches the original.
   - **Desconectar cuenta…:** opens Connections, where disconnecting purges that account's
     Knowledge.

   Root links are built from the stored selection. No token or other workspace is involved.

## Consequences

- No migration. "The latest" is one Notion query and one block read per question.
- Databases without a publication date, or without a published state, get a stated fallback,
  never a silent guess.
- Live behaviour against the user's real Notion is to be checked after deploy (report §Live).
