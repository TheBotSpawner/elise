# ADR-021: The Live Canvas

**Status:** Accepted (2026-10-02). Supersedes ADR-013 §13 (Layout) and the "chat stays the main
element on Home" rule in `docs/product/04` §4 and `05` §14 for the Home / current-work
experience. ADR-013's model, registry, presentation tools, lifecycle and safety rules stand.

## Context

ELISE's Home read as chat + cards: the conversation kept its own column and Surfaces sat in a
side pane. The Claude Design exploration (`design-reference/`, "ELISE — Live Canvas") replaced
that with one adaptive canvas where voice or text becomes a visual composition, and the
conversation is a secondary transcript. The design shows three compositions (Spatial, Focus,
Temporal) plus Comparison, a presence dock with the Orb, a 12-state Orb, a chart family and media.
The product decision: these are complementary behaviours of **one** Live Canvas, not modes the
user picks.

## Decision

1. **One Live Canvas** (`features/workspace/canvas`). Home and a reopened conversation render it.
   With no Surfaces it is the idle hero (Orb, "What do you need?", input, quiet ambient lines) or,
   for a conversation without Surfaces, its thread — old conversations stay readable as they were.
2. **A deterministic Composition Resolver** (`canvas/composition.ts`, pure, unit-tested) maps
   workspace state + device class to one predefined composition, in this order:
   pending approval → overlay above the (dimmed, inert) canvas; a focused Surface → **Focus**
   (**Comparison** when a second one is compared); arranged in time order with ≥ 3 dated items →
   **Temporal**; 1–2 Surfaces → **Simple**; a clear lead (priority ≥ 85) → **Brief** (lead,
   its summary under it, supporting column, compact rail); several without a lead → **Spatial**
   (ELISE at the centre, context around her). Surfaces never position themselves and the model
   never sends layout, pixels, CSS or markup. DOM order is the resolver's reading order.
3. **Devices.** Mobile (< 768) never positions: Brief stacks, Spatial is a small Orb + carousel +
   list, Focus is full-width, Temporal is vertical. Tablet (768–1279) uses two columns. Desktop
   and wide (≥ 1800) use the full canvas. Whatever has no room goes to a **shelf** of chips —
   nothing is dropped. Non-Home pages keep their reading widths.
4. **View operations are workspace operations** (click and voice share them):
   `focus {id | null, item?, compareWith?}`, `pin {id, pinned}` and `arrange {order: time |
   relevance}`, persisted inside the existing `surfaces`/`intent` JSON (no migration): Surface
   `pinned`, `compared`, `focusItem`; intent `arrangement`. Tools: `ui.focus` (item, compareWith,
   `"none"` = back), `ui.pin`, `ui.arrange`. Pinned Surfaces survive decay, a new intent, clear
   and eviction; at most 3 (a fourth releases the least recently touched).
5. **Visible cap 8** (was 6): the canvas has room on large screens; smaller screens shelve.
6. **Visualization Surfaces** (`core/workspace/visualization.ts`): typed templates — kpi, line,
   area, bar (single or paired), hbar, distribution, diverging, progress, streak, table —
   validated with Zod. Finance summaries/breakdowns, habits and goals become charts
   deterministically from their own numbers (goal pace = straight line from creation to target
   date); a result that can't be drawn honestly keeps its card. ELISE may `ui.present` a chart
   only as a valid template plus `basis` (the visible Surfaces its numbers come from). Rendering
   is plain SVG/HTML (no chart library), accent for what the chart is about, neutral otherwise,
   a Table view and an aria summary for every series chart.
7. **Media Surfaces** (`core/workspace/media.ts`): image, gallery, video and link preview, only
   from URLs the workspace already holds. Video plays by id in an allow-listed player
   (YouTube no-cookie, Vimeo; CSP `frame-src` lists only those), only after the user presses Play.
   Audio has no provider: the type is ready, nothing fakes playback.
8. **Presence.** The Orb renderer is the reference v2 (adds user speaking, searching, attention,
   sleeping). One Orb at a time: idle hero, Spatial centre, or the dock. The dock is voice-first
   (mic, live caption, type instead, stop, transcript, attach); typing is the default without voice.
   Navigation recedes while the canvas works and returns on hover/focus.
9. **Transcript** is a drawer (desktop) or sheet (phone), remembered per browser, never owning
   workspace state: closing it returns to the same canvas.
10. **Tokens and motion** live in `globals.css` (Surface tiers primary / secondary / arriving /
    ambient / dim / skeleton, dock, drawer, chart grid) and `canvas/motion.ts`. Surfaces keep
    their identity across compositions (`layoutId`, position-only so text never stretches);
    reduced motion keeps meaning with fades only.

## Consequences

- The reference HTML stays in `design-reference/` as development material, excluded from lint
  and formatting, never imported or served.
- Production uses Geist (already shipped) and Lucide; design fixture data never reaches production.
- Not built (no real capability yet): Spotify/music control, maps, a concept-level study mastery
  chart (the core only has counts), document version diffs (no version content in Knowledge),
  a background-job resume board beyond what approvals report.
