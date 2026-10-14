# ADR-057: Goals refinement — period as a date range, removable fields, My Elise headers

**Status:** Accepted (2026-10-14). Refines ADR-055 and supersedes its "the deadline follows
the period" rule. No migration.

## Context

- **Period picker:** the Goals form offered the period as a preset dropdown (Este
  trimestre, T1…), which reads as if the preset were the period.
- **Deadline:** it was copied from the period end.
- **Optional fields:** once revealed, they couldn't be removed.
- **Nueva visión:** hidden in the ⋯ menu.
- **My Elise headers:** each had a generic subtitle, and only Finance had an icon.

## Decision

### The period is a date range

- **Schema:** none needed. Goals already store `period_start` / `period_end` (ADR-055);
  existing goals keep their dates. Nothing stores a preset, so there is nothing to convert.
- **The form:** two dates (Desde → Hasta).
  - "Atajos" fills them: este / próximo trimestre, este año, hasta fin de año, próximo año,
    3 / 6 / 12 meses. The dates stay editable.
  - × clears the period ("Sin período").
- **`durationLabel` (deterministic):**
  - a familiar unit when the range is one: N months whether the end is the same day or the
    day before (14 oct → 13 ene / → 14 abr), 12 months = "1 año";
  - else days under two months ("44 días");
  - else months and days ("5 meses y 12 días").
- **Cards and detail:** show "14 oct 2026 → 13 ene 2027 · 3 meses". A goal without a period
  shows "Sin período"; one with only a deadline shows "Vence …" and no period.
- **Chat:**
  - explicit dates → `from` / `to`;
  - whole months → "YYYY-MM" ("entre enero y abril");
  - shortcuts include `rest_of_year`;
  - "que dure tres meses" → `duration`, from the current start.
  - All dates are computed in code. A half range is refused.

### The deadline is separate

- `target_date` is set only when the user gives one; it never follows the period.
- Health and risk still use deadline ?? period end, as before.

### Filters by overlap

- "Todos los períodos", "Activos ahora", "Este mes", "Este trimestre", "Este año",
  "Próximos", "Finalizados", "Sin período" and "Rango personalizado" all match by overlap with
  the goal's dates (1 oct → 31 dic is in November).
- A goal with only a deadline occupies creation → deadline.
- An undated goal is in no date range but is "active now".

### Form

- **Vision:** a primary field when Visions exist.
- **Optional fields** (Hábitos, Descripción, Fecha límite, Área, Contribuye a, Relacionados):
  each has × on its label. It removes the field and clears its value, so nothing hidden is
  saved.
- **Relations:** removable chips, including "Contribuye a".
- **Suggestions from the name** no longer switch the measure to Sí / No when the name has no
  number. That was weak evidence, and the reflow it caused made the next click miss.

### Header actions and My Elise headers

- **Goals actions:** "+ Nuevo objetivo" (primary) and "Nueva visión" (secondary, eye icon)
  sit side by side. The eye is the Vision icon everywhere, Canvas included.
- **One icon mapping:** `MY_ELISE_ICONS` in nav-items feeds the menu, the My Elise page and
  every module header (Tareas, Hábitos, Objetivos, Listas, Notas, Finanzas, Atajos, Métodos,
  Tiempo).
- **One header pattern:** `PageHeader` with `icon`, no subtitle, the same padding, so titles
  align at the same position across modules. Helper text inside empty states and forms stays.

## Consequences

- **Arbitrary periods** ("entre el 15 de noviembre y el 10 de febrero") work as they are.
- **Deadlines of older goals:** goals created under ADR-055 keep the deadline it copied from
  their period. It now shows as their own deadline and can be removed in the form.
