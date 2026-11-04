# ADR-136: "Open Core", the new Orb and logo

**Status:** Accepted (2026-11-04). Replaces the Live Canvas wireframe Orb (ADR-046's boot timing
included) and settles `docs/product/05-ui-design-system.md` §6–9.

## Context

The owner chose a new identity, made in Claude Design from their references. The export is
`design-reference/ELISE-OpenCore.zip`; its `NOTA.md` has the colours, timings and rules.

## Decision

1. **The Orb.** A thin glass sphere, two opposed arcs that hug it without closing it, an S flowing
   through it (the dialogue) and a small core (the presence). Motion carries the state; colour only
   confirms it. In light the contrast comes from the stroke, never from the glow.
2. **The code.** `orb-renderer.ts` is the design's renderer ported to strict TypeScript, with the
   same `frame()` the app used. Canvas 2D, no dependency. The state table stays data at its top.
   States now use the product's names; the old mapping is gone.
3. **Accents.** The app's accents are names ("amber"); the renderer maps them to colours. All five
   stay.
4. **Speed.** The Orb draws at the rate the renderer suggests: 60 fps active, 30 at rest, 20 asleep.
5. **Boot.** 2.6 s, as designed (was 1.2 s): core, sphere, arcs, the S. It delays nothing: the page
   is usable under it. 350 ms with reduced motion.
6. **The logo.** A flat symbol, two crescents and a core, plus the wordmark (`brand.tsx`): navigation
   and login. The wordmark's spacing isn't changed.
7. **Icons.** Web favicon and touch icon. Desktop's window icon and, new, the `.exe` and installer
   icon (`assets/icon.ico`). The tray icon follows the theme: light on a dark bar, dark on a light one.

## Consequences

- The Orb takes 72 % of its canvas, leaving room for the eyelids opening and the attention pulse.
- The tray follows the app's dark/light setting, which on Windows can differ from the taskbar's.
- The installer's entry in Windows' app list keeps Electron's icon: it needs a public `iconUrl`.
- The widget for the background conversation always draws the dark version, as before.

## Addendum (2026-11-04): icons without a background

The owner didn't want a dark tile around the icons, and Claude Design made a transparent set
(`design-reference/ELISE-iconos-sin-fondo/transparent`):

- **Favicon:** `favicon.ico`, and `src/app/icon.svg`, which follows the browser's light or dark mode, so it reads on any tab.
- **Desktop's window, `.exe` and installer:** `app-icon` (`.ico`, `.png`), a mid tone made for both dark and light bars. The set's `.icns` is in `desktop/assets` too, for a macOS build.
- **iPhone icon:** keeps its tile, because iOS fills transparency with black.

## Addendum (2026-11-04): the Orb becomes an eye

The owner updated the design ("Open Core · Ojo"): the sphere works as an eye. The logo's crescents are
its eyelids and the core is its pupil, which looks, dilates with the voice and narrows for attention.
The arcs, the S, the sweep and the satellite are gone. The logo and the tray icons didn't change.

`orb-renderer.ts` matches the design's `elise-orb.js` pixel for pixel (compared in Chromium: every state,
both themes, three sizes, with boot, reduced motion and pointer). The one omission is its blink code,
off in every state of the design: its note says the eye doesn't blink.
