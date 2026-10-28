# ADR-126: A progress bar for goals worked through in the conversation

**Status:** Accepted (2026-10-28). Extends ADR-013 (Live Workspace).

## Context

Some conversations work toward a goal in known steps: reviewing 13 chapters one by one, going
through a setup checklist, a list of topics to cover. The owner liked seeing how far along such a
plan is (an idea from another assistant). It is meant for those cases only, decided by ELISE, not
as a feature of every conversation.

## Decision

- **`ui.progress`** (workspace capability, presentation only) shows a `progress` Surface. It takes
  the goal's title, the steps done, the total, the unit ("capítulos") and optionally the step
  being worked on, the steps by name and a note.
- **The same title updates the same bar.** ELISE shows it when the plan starts (done 0) and calls
  it again each time a step is completed.
- Steps are marked done, current or pending from `done`. Their names come from the model; the
  counts are bounded (at most 500, steps at most 30), and `done` is clamped to the total.
- The model is told to use it only when such a goal is explicit and the bar helps — never for
  ordinary answers, single tasks or chit-chat.

## Consequences

- No persistence beyond the Surface itself: the bar is part of the conversation's workspace,
  like any other Surface.
- Whether it shows depends on the model's judgment. It isn't measured yet.
