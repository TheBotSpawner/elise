# ADR-063: Notification delivery choice postponed

**Status:** Accepted (2026-10-15).

## Context

Schedules (Morning Brief, weekly planning, other presets) asked "Cuando esté listo / When it's
ready": En ELISE, Notificación del navegador or Sin aviso. ELISE was also able to change that
choice from chat (`notifications.getPreferences` / `notifications.updatePreferences`).

In the web-only ELISE of today, the choice adds friction and confusion without real value. A
browser notification needs the tab's permission and an open browser; "Sin aviso" hides results
the user scheduled on purpose.

## Decision

- **No delivery choice in the product:** not in the schedule form (new, edit, presets), not in
  the chat proposal card, not as a chat tool.
- **Every result is delivered in ELISE:**
  - the run's result and conversation, exactly as before;
  - an in-app notice with a link to it.
- **Behavior is `in_app`, whatever a schedule stored:**
  - the runner always creates the in-app notice;
  - nothing turns a notice into a browser notification;
  - no permission is requested.
- **Kept for compatibility:** `delivery_config` and `deliverySchema` still exist and accept
  `none` / `in_app` / `browser`, so older schedules load unchanged.
  - Creating or editing a schedule stores `in_app`. Every other setting is kept.
  - No data migration.
- **Kept for later:** the browser-notification plumbing (`ResultNotifier`, the `metadata.browser`
  flag) and the settings store's per-schedule notify methods remain, unused.

## Consequences

- **Later:** choosing where results are delivered is a decision for when ELISE has desktop or
  mobile clients and real push or system notifications. It will be designed then, on top of the
  kept fields.
- **"Sin aviso" schedules:** schedules that had "Sin aviso" now show the in-app notice when a
  result is ready.
