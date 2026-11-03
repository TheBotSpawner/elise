# ADR-132: Finding things by resemblance, not exact wording

**Status:** Accepted (2026-11-03).

## Context

"Marcá sacar turnos estudios médicos como completado" found nothing, while "Sacar Turno para los
estudios medicos" was open. Search was "contains the whole phrase", so one plural or one word left
out meant no result, and ELISE said the task didn't exist. The same rule sat behind list items,
lists, finance names, Spaces, Methods and History.

## Decision

1. **One comparison** (`src/core/lexicon.ts`). The words asked for are looked up in the text, in any
   order, ignoring glue words, accents and case. Two words are the same with a different ending, the
   same Spanish sound, or a small typo (words of 5+ letters). Numbers must match exactly.
2. **One word in four may be missing** in a long request. Shorter ones need all their words.
3. **Finding by name: exact, then partial, then resemblance.** Resemblance is the last step and keeps
   only the closest. A tie is returned as a tie, so the existing "which one?" still asks.
4. **Search results are ranked** by resemblance to the title, so a looser filter can't push the right
   task past the limit.

Used by tasks (search box included), task lists, list items, lists, finance and native names, goal
task links, contexts, Methods, schedules, study documents, Knowledge Spaces and History.

## Not changed

- **Notes** already search any word, and **Knowledge** is semantic.
- **Email, calendar and Slack** search inside the provider; **Home** has its own resolver.

## Consequences

- Something can now be found that wasn't meant ("carta" / "carga"). A write acts on it when it's the
  only close match, so a wrong word can reach the wrong item when nothing else resembles it.
- Tasks are compared in memory, over up to 500 per account, as they already were.
