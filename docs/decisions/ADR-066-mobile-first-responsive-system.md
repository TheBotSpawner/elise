# ADR-066: Mobile-first responsive system

**Status:** Accepted (2026-10-16).

## Context

On phones ELISE worked but read as a compressed desktop:

- a hamburger menu and no bottom navigation;
- five equal buttons per card;
- stacked native selects before content;
- desktop-style dialogs for long forms;
- 24–32 px tap targets;
- `env(safe-area-inset-*)` written in a few places but inert, because the viewport had no
  `viewport-fit=cover`;
- no keyboard handling;
- persistent bars (mini timer, mini player, YouTube corner, dock) all fixed to the same bottom
  edge.

## Decision

### Breakpoints

We map the conceptual compact / medium / expanded classes onto the existing Tailwind breakpoints
instead of redefining them (hundreds of existing `md:` uses):

| Class | Width | Layout |
|---|---|---|
| Compact | < 640 px (`sm`) | Phone layouts |
| Medium | 640–767 px | Phone navigation, wider content (cards may return) |
| Expanded | ≥ 768 px (`md`) | Desktop toolbars and anchored menus; the top navigation from 1024 px (`lg`) |

The Live Canvas keeps its own JS device buckets (`composition.ts`). Its mobile threshold is the
same 768 px.

### Shell

- **Viewport:** `viewportFit: "cover"`, `interactiveWidget: "resizes-content"`, and
  `themeColor` matching `--bg`. Pinch zoom stays available.
- **Header:** compact, under the notch (`pt-[env(safe-area-inset-top)]`).
- **Bottom navigation:** below `lg` (phones and portrait tablets, where the full top bar doesn't
  fit: at 768 px it overflowed by 34 px), five destinations with icon and label:
  - Inicio, Historial, Conocimiento;
  - **Mi ELISE**, which opens a sheet with the person's enabled modules;
  - **Más**, a sheet with Conexiones, Programados, Aprobaciones (with a dot when pending) and
    Configuración, plus account and sign-out.
- The hamburger menu is gone. The bar is never used for actions, and it hides while the keyboard
  is open.

### Bottom-edge coordination

CSS variables on `:root` replace scattered `bottom-4` offsets:

| Variable | Meaning |
|---|---|
| `--bottom-nav-h` | 58 px plus the safe area on phones; 0 on desktop or with the keyboard open |
| `--keyboard-inset` | Part of the layout covered by the on-screen keyboard (iOS), from `visualViewport` |
| `--dock-space` | Room the chat dock takes on phones (published by the Dock) |
| `--activity-music` | Height of the mini player while it shows |
| `--activity-bottom` | `--bottom-nav-h + --dock-space + 16px` |

How the bottom-edge elements use them:

- **Dock:** sits above the navigation, or above the keyboard.
- **Mini player and YouTube corner:** sit at `--activity-bottom`.
- **Mini timer:** stacks above the mini player.
- **Finance's floating "+ Movimiento":** uses the same offset.

### Primitives

All are built on the existing native `<dialog>` and `motion`, with no new dependencies.

- **`Dialog`:**
  - On phones it is a bottom sheet with a drag handle; swipe down to dismiss.
  - `size="form"` is a full-screen editor on phones. It has a sticky header with "Cancelar" and
    the title, the fields scroll, and the form's own action row (marked `data-sheet-actions`)
    stays at the bottom above the home indicator.
  - From `sm` it is the centered dialog, unchanged.
- **`OverflowMenu` / `ActionSheet`:** "⋯" opens an anchored menu from `md`, and an action sheet
  on phones. Destructive actions always go last and in red. The native-ui `Menu` delegates to
  it, so every existing "⋯" got it.
- **`FilterButton` / `FilterSheet`:** a "Filtros · n" trigger, full-width rows, and "Limpiar" /
  "Aplicar".
- **`ChipRail`, `no-scrollbar`:** swipeable rails edge to edge.
- **`touch-hit`:** a 44 px invisible tap area around smaller controls, without changing how they
  look.
- **`SettingsGroup`:** one row per Settings block on phones, opened in place.

### Touch and type

- **Frequent actions:** at least 44 CSS px. Buttons are `h-11` on phones; `sm` buttons, switches
  and InfoTips get `touch-hit`.
- **Rows:** task and list rows are 44 px with 20 px checkboxes.
- **Inputs:** 16 px on phones, so iOS doesn't zoom on focus.
- **Page titles:** 26 px on phones.
- **Page gutter:** `--page-gutter`, 16 px on phones and 40 px from `md`.

### Screens

- **Tasks:**
  - The current view becomes a "Hoy · 2 ▾" switcher that opens the views in a sheet.
  - Account, priority, label, this week and sort go into the filter sheet.
  - Quick add is one row until used.
- **Finance:**
  - The Ámbitos become a rail.
  - Importar moves to "⋯", and a thumb-reach "+ Movimiento" appears once there are movements.
  - The period is one `‹ Octubre de 2026 ›` row; tapping it opens day / week / month / year /
    custom.
  - KPIs are one three-column strip, and filters go into the sheet.
- **Habits:** "Nuevo hábito" and "⋯" (status, import, export) come first. The period is a
  full-width segmented control, the range one row, and the summary three compact columns.
- **Goals:** "Nuevo objetivo" and "⋯" (Nueva visión, import, archived) come first, then the
  status tabs and full-width search. One row holds Filtros and Lista/Timeline; period, vision,
  area, habit and sort go into the sheet.
- **Lists:**
  - One list at a time.
  - A full-width switcher names the list in view and opens all lists in a sheet.
  - "+" for a new list, and import in "⋯".
  - No board scrollbar.
- **Schedules:** each card keeps its main action ("Ejecutar ahora", "Abrir el último"). Pause,
  edit, history and delete go into "⋯". Ideas become a swipeable rail.
- **Knowledge Space:** "Preguntarle a ELISE" is the primary action. "+" adds a source or a
  section, and "⋯" holds edit and settings. The section, Space, goal, vision, transaction and
  Method editors are form sheets, and the icon/color picker uses 44 px cells.
- **Connections:** Mi ELISE modules and providers are compact grouped rows (a provider row has a
  chevron). Connected accounts are a rail.
- **History:** Spaces and Sections are rails; group and sort go into the filter sheet.
- **Settings:** your ELISE first, then one row per block.
- **Notes:** the formatting toolbar is one swipeable row of 40 px tools.

### Live Workspace on phones

The Canvas already had a mobile composition: the lead Surfaces in a horizontal snap pager with a
peek of the next one, the rest as a micro list and a shelf, and focus as full width. On top of
that:

- the idle Orb is sized for short screens;
- Surface controls are always visible on touch (no hover) with 40 px buttons;
- the transcript is a sheet above the navigation (z-50), 78dvh, that closes with a pull on its
  handle.

## Consequences

- **Desktop is unchanged by construction:** every phone change is `max-md:`/`md:`-scoped or a
  phone-only element.
- **QA matrix:** `e2e/mobile-matrix.spec.ts` screenshots the main routes at 320, 360, 390, 430,
  768 and 1440 px with a seeded throwaway account. It fails on any sideways overflow and lists
  tap targets under 40 px.
- **Limitation, first paint:** both device signals default to desktop on the server
  (`useIsDesktop`, the Canvas width), so a phone may flash the desktop composition for one frame.
- **Limitation, native selects:** native `<select>` stays inside filter sheets (full width,
  48 px), where the platform picker is the right control.
- **Limitation, no Time Tracker:** `/my-elise/time` is settings only, so there is no tracker to
  adapt yet. The mini timer already stacks with the mini player.
