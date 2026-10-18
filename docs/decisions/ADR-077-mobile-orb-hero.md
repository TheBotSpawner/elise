# ADR-077: On phones, the Orb is the Home's centerpiece

**Status:** Accepted (2026-10-18). Refines ADR-066 (phone layout). Desktop and tablets are
unchanged.

## Decision

- **The stage takes the free height.** On phones the idle Home is a flex column. Its first part,
  the stage (Orb, greeting, "¿Qué necesitás?"), grows into all the height between the header
  and the fixed composer and navigation, and centers itself there. There's no fixed margin.
- **The Orb's size follows width and height:**
  `clamp(176px, min(86vw, 100dvh − 380px − safe-area), 480px)`.
  - The 380px reserve covers the header, greeting, question, a context row, composer, navigation
    and safe area.
  - The Orb grows on tall phones (about 335px at 390×844) and stays fully visible on short ones
    (320×568).
  - From `md` up, the previous `clamp(250px, min(42vw, 46dvh), 620px)` applies unchanged.
- **The Orb itself is unchanged:**
  - the same animated canvas and the same states;
  - geometry, glow and rings scale together;
  - `prefers-reduced-motion` is honored as before.
- **Context rows form one compact strip:**
  - rows: Morning Brief, Continuar, Hoy/Vencidas, Aprobaciones;
  - no gaps between rows, and a smaller top margin;
  - each row keeps its 44px tap target;
  - the "Continuar" preview stays on one line with an ellipsis.
