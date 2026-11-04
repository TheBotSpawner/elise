# ADR-135: Widgets adapt to their card, and never scroll sideways

**Status:** Accepted (2026-11-04). Extends ADR-021 (Canvas) and `docs/product/05-ui-design-system.md`.

## Context

The owner saw a horizontal scrollbar on the habits widget in a narrow column, and "RESU…" in a header
next to "Puede estar desactualizado". Each widget had its own fixed widths.

## Decision

1. **A widget lays out by its card's width, not the window's** (container queries). The card and its
   body are containers.
2. **No sideways scroll inside a widget.** A test keeps `overflow-x-auto` out of them. The Temporal
   view and the shelf of chips are whole-canvas strips and stay as they are.
3. **Rather than a separate minimized version, each widget has a narrow layout:**
   - **Habits:** name and count on one line, the week below it at full width.
   - **Weather:** as many hours as fit; the full view wraps them all.
   - **Study questions and gallery thumbnails** wrap.
   - **Calendar:** the view switcher takes its own row.
   - **KPI:** the figure scales with the card.
4. **Words:** in a widget, a line that names something wraps to two lines (one rule in `globals.css`).
   Only secondary lines keep "…" on one line. Figures in tables are never cut.
5. **The header keeps the name:** in a narrow card the state stays as a dot, with its words in the
   tooltip and for screen readers.

## How it was checked

All 42 widget types (79 real surfaces) in Chromium at 240–520 px, and the compact ones at 200–260 px:
no scrollbars and nothing outside the card. The page and the data used were temporary and deleted.

## Consequences

- Cards can be taller: habits take two lines per row, and titles up to two lines.
- A very long title is still cut after two lines.
- Checked in Chromium with surfaces that existed that day. Types with no stored example (for example
  `media`, `vision`, `goal`) weren't rendered.
