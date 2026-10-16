# ADR-067: Communication per email account, balanced Canvas packing, Programados hub

**Status:** Accepted (2026-10-16). Refines ADR-041 (scheduled conversations), ADR-021
(composition), ADR-037 (Scheduled hub) and ADR-066 (responsive dialogs). No migration: the new
fields are optional, so briefs and Canvases stored before this still read.

## Context

In production the Morning Brief showed two generic "Comunicación" widgets:

- one was `email.findFollowUps` (needs reply), the other `email.listRecent` (unread);
- each mixed every account, because multi-account reads are merged into one newest-first list;
- the only noise filter was `noiseSignals` (list headers, non-primary tab, no-reply sender), so
  weekly digests, policy notices and `hello@` marketing still got in;
- order was by date (and provider "important"), not by what needs attention.

The Brief composition put the lead (a tall calendar) alone in the left column and every other
Surface in the right one. The left column ended under the calendar, while the right kept growing
and the user had to scroll.

A focused Surface reserved a "Vuelve acá" placeholder in the left rail.

Programados used a narrow column. The create and edit form opened inline above the list, and each
card showed six competing buttons.

## Decision: email triage, per account

**`email.triage`** is a new read tool (capability Email, operation `triage`, read/low). It is
model-facing too ("¿algún mail importante?"). Per account it reads:

- unread inbox mail from the last `days` days (3);
- inbox threads from the last 7 days (needs reply, via `classifyFollowUp`);
- with `waiting: true`, sent threads from the last 14 days (waiting on others, 48 h).

Then `core/capabilities/email-triage.ts` decides deterministically. The model never filters,
ranks or caps.

- **Noise.** Promotions/social tab mail is noise unless it is about security. Promo or digest
  wording ("20% OFF", "newsletter", "resumen semanal", "sub-processors", "privacy policy") is
  noise too. Automated mail is noise only when nothing operational is in it. Automated means list
  headers, a no-reply sender, a marketing local part (`hello@`, `news@`, `info@`…) or promo
  wording. Operational means security, an unpaid payment, urgency or a problem, a deadline, or a
  change or cancellation.
- **Score.** Points per signal:

  | Signal | Points |
  | --- | --- |
  | needs reply | +40 (+10 high / +5 medium confidence, +5 waiting ≥ 48 h) |
  | security | +25 |
  | payment | +20 (a payment already made: +5) |
  | urgent / problem | +20 |
  | deadline | +15 |
  | change / cancel | +15 |
  | waiting on others | +15 |
  | important sender | +10 |
  | known contact | +10 |
  | direct mail | +10 |
  | meeting | +8 |
  | recent | +8 / +4 |
  | unread | +5 |

  Below 20 an email is left out. The level is `high` at 60 or more, `medium` at 35 or more,
  otherwise `normal`. Reason codes are kept. The score itself is never shown.
- **Dedupe.** One candidate per thread: the follow-up wins over the bare unread message. Then
  one row per (sender, normalized subject), so a repeated alert is one row.
- **Caps.** At most 10 per account. `normal` rows only fill up to 5. Nothing is padded: two
  relevant emails stay two.
- **Status.** One status per row: needs reply › urgent (problem or security) › payment ›
  waiting.

The result is an ordinary `email_list` display plus `triage`: per account, its identity
(`connectionId`, `providerKey`, label, address — the binding's own, no parallel alias system)
and per message `{level, status, reasons}`. The executor's multi-account read runs the accounts
in parallel. One that fails is named in `unavailable`; the others still answer. The merge keeps
accounts separate.

## Decision: the Morning Brief

- **One read.** The `email` and `needs_reply` blocks are one `email.triage` call
  (`waiting: needs_reply`). The two follow-up reads are gone.
- **Persisted.** `MorningBrief.communication[]` is
  `{type: "communication", account: {connectionId, provider, alias, email}, messages, generatedAt}`.
  Messages carry `priority` and `status`. No tokens. The legacy `attention.emails`,
  `waitingOnYou.replies` and `waitingOnOthers` are derived from the same triage, so the
  narration, the experience view and older readers keep working.
- **One Surface per account.** `briefCanvas` presents each account with something relevant as
  its own item. Its query is pinned to that account (`destination` = the account address), so a
  refresh after a write re-reads only that account and updates that Surface in place. An account
  with nothing relevant gets no Surface. Account order: `high` 72, `medium` 66, `normal` 60.
- **Surface.** `email_list` gains an optional `mailbox` (label, provider, address) and per item
  `priority` and `status` (max 10 items). The header reads "COMUNICACIÓN · FIRBOT". Under it,
  "Gmail · address · N relevantes". Each row shows a small dot (rose, amber, cyan), one status,
  a clipped snippet and the date. Five rows show; "Ver N más" expands in place. "Puede estar
  desactualizado" stays, but faint.
- Clicking a row focuses it and loads the thread, as before. Replying goes through the existing
  draft and approval policy. Nothing new happens automatically.

Not done: per-account settings in the schedule. "Mails importantes" means every enabled Email
account (or the one pinned in `sources.email`).

## Decision: balanced packing on the Canvas

`composition.ts` gains `estimateHeight(surface)`: a content-based height (the calendar 560,
email 64 + 28 + 50 per visible row, tasks 44 per row, charts by rows, and so on). It is never
measured from the DOM, so the same workspace always packs the same way and nothing jumps column
while loading.

- **Brief.** The lead (and the orchestration summary) sit in the left column. Then, in priority
  order, each Surface goes to the shorter column, with ties to the left. Capacity, lead aside, is
  desktop 6, wide 7, tablet 4. Compact types still take the rail; the rest go to the shelf.
- **Spatial.** The same rule replaces left/right alternation (3 per side).
- **Order and devices.** Reading order inside each column stays priority order. Phones keep the
  single stack and carousel (ADR-066).
- **No full-span.** Brief has no Surface spanning both columns, so there is nothing to respect
  there.

**"Vuelve acá" is removed:** the component, its i18n string and its slot in the Focus rail.

## Decision: Programados

- The page uses the wide container. On `lg` and up, "Tus tareas programadas" (7fr) sits beside
  "Ideas para ELISE" (5fr). The ideas are a 2-column template grid, and a swipe rail on phones.
- **Toolbar.** Todos / Activos / Pausados chips with counts (from 2 schedules up), search (from
  5 up), and "Nueva tarea programada".
- **Card.** A preset icon (`features/schedules/icons.ts`: Sunrise, CalendarRange, Moon,
  CalendarClock, ListChecks, Mail, BookOpen, Repeat; one block's icon or Sparkles otherwise),
  plus:
  - name, status, cadence and next run;
  - the instructions (2 lines);
  - block chips and the Method;
  - the last run.

  One primary action ("Ejecutar ahora", or "Cancelar ejecución"). Everything else is in ⋯
  (`OverflowMenu`): Pausar/Reanudar, Editar, Abrir el último, Historial, Eliminar (last, red).
  Duplicate was left out: a duplicated preset would compete with the original for "my brief".
- **Template.** Icon, name, suggested cadence, purpose, block chips. "Agregar" (or
  "Configurar") shows on hover or focus, and always on touch. An idea already in use shows
  "✓ Ya agregada" and opens that schedule.
- **Editor.** Create and edit open `ScheduleEditor`: the shared `Dialog`, `size="form"`. On
  desktop it is centered, `max-w-3xl`, over a darker, blurred backdrop (native `<dialog>`: the
  page is inert, focus is trapped, Escape closes). On phones it is the full-screen sheet with a
  sticky header and action row.
  - Sections: Básico, Cuándo, Qué mira ELISE (icon cards), and "Ajustes de lo que mira", shown
    only for selected blocks that need settings (calendar days, Space, news topics, Slack,
    weather).
  - Closing with unsaved changes shows an inline "Tenés cambios sin guardar" with "Seguir
    editando" and "Descartar cambios". Saving closes the editor.

## Consequences

- Morning Brief email is a single, explainable, testable function. The thresholds are a
  heuristic: keyword lists in Spanish and English. A paid receipt from a marketing sender
  ("Tu factura… se ha pagado" from `hello@`) is left out on purpose: no action is required.
- One fewer provider round per account than before (the two follow-up reads were merged).
- Packing is estimated, not measured. A Surface whose real height differs a lot from the
  estimate (a calendar in Agenda view) can leave a smaller gap. The upgrade path is measured
  heights with hysteresis.
- Older Canvases keep their mixed email Surfaces until the brief runs again.
