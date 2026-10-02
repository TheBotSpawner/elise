# ADR-024: Object-first routing, self-healing Recall, initiative, honest capability status

**Status:** Accepted (2026-10-02). Refines ADR-012 (Recall), ADR-018/020 (Sections and History
links) and ADR-023 (Location). No migration.

## Context

Four failures came up in real use:

- "El cronograma de análisis matemático 2" went to Calendar and got a clarifying question
  instead of a Knowledge search.
- Recall missed a voice conversation that History showed.
- A route question got two rounds of questions.
- ELISE said it had "no access to maps" while Location existed.

Root causes:

1. **Routing.** The model never saw the user's Spaces and Sections or the names the user gave
   them. It did see a calendar account named after the university, and the core rules told it
   to "ask one short question" when unsure. So "calendario/cronograma de <subject>" looked like
   a calendar question.
2. **Recall.** The index was never built for voice sessions (0 of 14 indexed) or for most text
   conversations. Indexing was queued to the background runtime, which never ran it in that
   deployment. The periodic sweep, which does cover voice, runs on the same runtime. History
   reads the turns directly, so History and Recall disagreed. Two smaller causes:
   - A conversation whose `last_message_at` ran past its last message stayed "behind" forever.
   - The model's reduced keyword query replaced the user's own sentence.
3. **Initiative.** Tool parameters were treated as questions, and nothing stated defaults.
4. **Maps.** Location tools were offered only when `GOOGLE_MAPS_SERVER_API_KEY` was set, and
   only the browser key existed. The tools were therefore absent from the run, and the rule
   "say it isn't connected" produced "no tengo acceso". The single development key is also
   referrer-restricted, so Google refuses it server-side.

## Decision

1. **Object first, tool second.**
   - Before the model runs, `resolveMentioned` resolves a Section the message clearly names. It
     uses the name, the description or context aliases, and Roman numerals read as digits. A
     Space named with one of its Sections resolves to the Section, and two unrelated matches
     resolve to nothing.
   - The resolved Section becomes the default Knowledge scope for the turn.
   - It is linked to the interaction with real ids (evidence `resolved_mention`, confidence
     0.9), even if its Knowledge has no answer.
   - The prompt lists the user's Spaces and Sections with their aliases. It states that nouns
     like calendario, cronograma, agenda, tareas or lista don't choose a capability: the object
     does.
   - Knowledge finding nothing is never a reason to search Calendar.
2. **Recall must not depend on the background runtime.**
   - Before the first Recall read of a request, `catchUpRecall` indexes the user's newest typed
     and voice interactions that are missing or behind (`recallDue`). It is bounded to 8
     interactions and 5 seconds, skips the current thread and skips summaries.
   - It is idempotent (the index is the progress), and concurrent searches of the same user
     share one run.
   - A conversation's index now covers up to its `last_message_at`.
3. **Recall keeps the user's words.**
   - `history.search` searches the model's query and the user's verbatim message (passed as
     `ToolContext.userMessage`), and merges the hits.
   - Exact phrases outrank loose matches: the `phrases` parameter and quoted text get
     `PHRASE_BOOST`.
   - When the user asks to search past conversations, Recall is searched first. Relative dates
     in excerpts are read against that interaction's date.
4. **Initiative policy (all capabilities).** The rule is understand → infer → act → answer →
   refine.
   - Optional parameters are defaulted: now, the natural period, all accounts.
   - Read-only requests run at once, the assumption is stated briefly, and nothing is asked
     twice.
   - Clarification stays for genuinely different targets, values that can't be assumed, and
     risky or irreversible actions. Approvals are unchanged.
5. **Capabilities are what the run has.**
   - The model is told its abilities are its tools, not a generic model's limits.
   - Location is offered whenever a key exists. In development the single browser key is used
     until a server key is set; production requires the server key.
   - Google's refusal reasons become precise setup errors (`setupFailure`): key restricted to
     websites, API disabled, API not allowed for the key, invalid key, billing. Each names the
     API, and the UI shows "configuración incompleta" instead of "no está conectado".
   - With no key at all, the prompt says maps aren't set up, and travel times are never
     estimated from memory.
   - A route with no mode compares driving, transit and walking, leaving now.
6. **Diagnostics without content:**
   - `chat.routing` logs modality, active and resolved Section, Knowledge node count, and Web
     and Location status.
   - `ai_run.finished` logs the tool names used.
   - `recall.search` logs hit counts and `recall.catch_up` logs due and indexed counts.
   - `location.call_failed` logs the setup category and the API.

## Consequences

- The first Recall search after a long unindexed stretch can take a few seconds more, until
  catch-up is done. The background sweep, where it runs, keeps searches fast.
- In development, a referrer-restricted single key still can't calculate routes. ELISE now says
  exactly why. Real routes need a server key, or the development key's website restriction
  removed.
- Resolution only uses names the user wrote. A Section with a bare code name and no description
  is found by that code alone.
