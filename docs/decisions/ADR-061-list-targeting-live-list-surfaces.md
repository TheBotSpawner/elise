# ADR-061: List targeting and live list Surfaces

**Status:** Accepted (2026-10-14). Refines ADR-051 (Lists) and ADR-060 (vision). No migration.

## Context

A voice turn with a photo of a whiteboard titled "Learning Paths" came in garbled ("me harías…
la lista de aprendizajes"). The model called `lists.create("Learning Paths")`, naming a new list
after the image's heading, instead of resolving the user's existing "📚 Aprendizaje". A later turn
added to "📚 Aprendizaje" correctly, so the user saw the items in two lists.

What allowed it:

- `lists.create` had no rule about when creating is right;
- its description said nothing against creating from content;
- an unresolved name was a bare "not found", which reads like an invitation to create.

The list Surface already re-read the whole list after a change, but showed "LISTA" without the
list's name.

## Decision

- **The destination is what the user said.** Attachments bring content, never a destination.
  Resolution, in order:
  1. id;
  2. the name the user said, matched against their real lists (emoji, case, accents, singular or
     plural, "la lista de" aside; never by meaning or translation);
  3. a list on screen, through the Live Workspace context;
  4. nothing else.
  - Several matches → "ask which; change nothing".
  - None → "ask whether to use one of [their lists] or create it; never create without their
    answer".
- **Guardrails in `lists.create`** (deterministic, in the tool, not only the prompt):
  - A list with the same name already exists → `CONFLICT` ("add to it with `lists.addItem`").
    This also stops synonyms spelled the same and a second create in a confused plan.
  - In a conversation turn, the user's message must ask for a new list (`createListIntent`:
    "creame/hacé/armá… una lista", "lista nueva", "necesito una lista", "make a new list").
    Otherwise creation is refused and the model is told:
    - if a list was named, add there;
    - otherwise ask where.
    - Logged as `list.unexpected_create_blocked`, with `explicit_target`, `attachment_present`
      and `existing_lists`.
  - Schedules and the UI (no user message) are not second-guessed.
- **Guidance:**
  - `lists.create`: only for a new list the user asked for; never from a title in an image or
    file, a translation or synonym, or as a fallback.
  - `lists.addItem`: `list` is the list the USER named; one list, unless they ask for several.
  - Vision: a title inside an image is content, never a list to create or a second destination.
- **Retries:** writes keep the executor's idempotency (run + call id). A technical retry returns
  the first result and writes nothing again.
- **Surface:**
  - After any change the tool re-reads the list by id (`provider.get`), and the Surface is that
    canonical state: every item, pending first, then "Completados (n)" collapsed. It is never a
    delta.
  - Its title is the list's real name and icon, with "N pendientes · M completados".
  - Long lists show the first 12 pending items and then "Ver todos (N)".
  - Identity is `checklist:{listId}`: one Surface per list, updated in place; different lists
    get different Surfaces.
  - If the re-read fails, the tool fails; the previous Surface stays, and no state is invented.
- **Telemetry:** `list.target_resolution` (matched id, match type, candidate count, attachment
  present) and `list.unexpected_create_blocked`. Never content.

## Consequences

- A request that names an existing list can't produce a second list. Asking replaces guessing.
- A user who does want a new list says so, which is the natural way to ask for one.
- **Validated end to end with the real model:** image (pasted or attached) plus "agregame estos
  items a la lista de aprendizajes" → only "📚 Aprendizaje" exists afterwards. The Surface reads
  "📚 Aprendizaje · 11 pendientes · 1 completado".
- **Not addressed here:** the live voice model once delegated the same spoken request twice in
  parallel (two voice sessions, same image, same second). The guardrails keep that from creating
  lists, but the double delegation itself belongs to the voice client.
