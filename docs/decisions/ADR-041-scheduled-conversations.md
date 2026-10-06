# ADR-041: A scheduled run is an ELISE-initiated conversation

**Status:** Accepted (2026-10-05). Supersedes the rendering half of ADR-039: the
`ExperienceView` report and narration player are no longer how scheduled results are opened.
They remain only as the fallback for results stored before this change. The narration
(`narrateBrief`) and its deterministic lines are kept. Migration
`20261013000032_scheduled_conversations.sql`.

## Context

ADR-039 turned the Morning Brief into narrated segments with typed cards. That was better, but
it was still its own rendering system: a vertical report page (`/schedules/results/[id]` →
`BriefView` → `ExperienceView`) that ran in parallel to the Live Canvas. In chat, "my brief
now" was a single `result` Surface that embedded the same report. As a result:

- the result was a narrow column of widgets;
- nothing on it could be focused, pinned, refreshed or changed;
- "contame más sobre ese mail" meant leaving it for another conversation.

## Decision

1. **A run is a conversation.**
   - When a scheduled run finishes, the handler creates a normal conversation with
     `origin = 'scheduled'`, `schedule_id` and `schedule_run_id`.
   - There is one conversation per run: a unique index makes a retried run reopen it.
   - The run's `scheduled_results` row keeps its content and points to it (`conversation_id`).
   - Each occurrence is its own conversation ("Morning Brief — 5 oct").
2. **Results are normal Surfaces, presented by the normal path.**
   - The brief is still gathered through the executor. Each read now also keeps its tool,
     arguments and typed display (`gatherBrief(...).reads`).
   - `briefCanvas(brief, reads)` (`core/briefs/canvas.ts`) is the relevance layer:
     - It decides which reads deserve a Surface and how prominent each is, on the registry's
       0–100 scale (≥ 85 leads, < 40 ambient).
     - It curates each one: the important emails, today's and overdue tasks.
     - An empty day keeps a quiet calendar. Empty news, habits, goals and finance are omitted.
   - `focusSurface` adds a "Today's focus" summary only when there is focus. It never holds the
     brief as prose.
   - `presentBriefing` presents each item with `WorkspaceSession.present(tool, …, query,
     priority)`: the same function a chat turn uses. Surfaces get the read as their query and
     dataset, so they:
     - refresh and reconcile after writes ("marcá la primera como hecha");
     - replace rather than duplicate;
     - keep focus, pin, dismiss, compare and representation changes.
   - The model never produces markup; the registry renders typed payloads.
3. **ELISE speaks first.**
   - The conversation's first message is ELISE's, and its text is the spoken synthesis
     (`spokenBrief`): the narration's greeting and the top lines, at most 400 characters, then
     "Te dejé todo en pantalla."
   - The message also stores the presented items (`metadata.scheduled`) and tool notes, so
     follow-ups refer to what is on screen by id.
4. **Opening it** (`/chat/[id]`, via the unchanged link `/schedules/results/[id]`, which
   redirects) is the normal ChatSurface and Live Canvas.
   - If the 12-hour working state expired, the Canvas is rebuilt from the stored items before
     loading. A current workspace, even one the user emptied, is never overwritten.
   - Follow-ups are normal turns in the same conversation and Canvas.
5. **Voice.** "Escuchar el resumen" (`narrate`) speaks the script through the session's own
   runtime:
   - **Legacy controller:** a narration turn on the normal player, with barge-in, then listening
     (continuous) — exactly like a reply.
   - **GPT-Live:** a commentary append the live voice says. The session then keeps listening,
     and its transcript persists to this conversation.

   Audio starts only on a tap (browser policy), so nothing autoplays.
6. **One renderer.**
   - "My brief now" (`briefs.today`) returns the same `present` items, and chat-service presents
     them with `presentBriefing`.
   - The `morning_brief` display no longer becomes a `result` Surface or a report card.
   - `BriefView`/`ExperienceView` render only results stored before this change (no
     `conversation_id`).
7. **Navigation.**
   - Programados keeps managing schedules. It gains **Abrir el último**, and history rows open
     the same conversation.
   - **Run now** waits for the run and opens its conversation.
   - History lists scheduled conversations like any other, with a "Programado" mark and the
     usual Space tags.

## Consequences

- Every Canvas feature (Spatial and Brief composition, Focus, Temporal, mobile stack and
  shelf, voice, approvals, reconciliation) applies to scheduled results without
  scheduled-specific code.
- New kinds of scheduled job only need to produce reads, a relevance function and a spoken
  line.
- **Not progressive yet.** The conversation is created when the run finishes, so "Run now" opens
  it then (typically 10–30 s). The upgrade path is to create the conversation at run start and
  present each read as it lands; the Canvas already follows its workspace in Realtime.
- A rebuilt Canvas shows the run's data as it was (each Surface can refresh itself). Changes
  the user made after the working state expired are not restored.
