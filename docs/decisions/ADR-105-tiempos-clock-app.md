# ADR-105: Tiempos as a clock app

Status: accepted (2026-10-21). Extends ADR-045 (timers) and ADR-100 (alarms).

## Context

Mi ELISE → Tiempos showed every sound, every device, and notes on one page. The person
couldn't tell where an alarm would ring. A one-off alarm that already rang still looked
switched on. The Timers tab could not start anything.

## Decision

- **Three tabs, as in a clock app:** Alarmas, Temporizadores, Cronómetro.
- **Alarms list:** each alarm shows its hour, label, days or date, and a switch. Tapping one
  opens the editor.
- **The editor holds the alarm's own settings:** sound (with preview and upload), snooze,
  devices, duplicate and delete.
- **Ajustes holds the defaults:** where alarms ring, the default sound, and the person's
  uploaded sounds.
- **One-offs turn themselves off.** When a one-off fires, the server sets `enabled = false`.
  Rows already in state `done` read as off. Turning a past one-off back on moves it to the
  next time its hour comes (`revivedDate`).
- **An alarm always rings somewhere.** When no device is named, it rings on the saved
  default devices that still exist (`defaultDestinations`). If none of those remain, it
  rings on one device: the Desktop app first, otherwise the device seen most recently.
  The UI won't switch off the last device an alarm or the defaults have. This replaces
  ADR-100's "never a default" for alarms set without naming a device. Naming a device that
  doesn't exist still sets it nowhere, and the response reports it.
- **Timers:** start from presets (1–60 min, Pomodoro with the person's settings) or a
  custom h:m:s. Starting runs `time.start` with origin `user_ui`. Pomodoro and sound
  settings are folded away.
