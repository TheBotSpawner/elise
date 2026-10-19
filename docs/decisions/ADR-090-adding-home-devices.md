# ADR-090: Adding home devices from Hogar

**Status:** Accepted (2026-10-19). Extends ADR-079 (ELISE Home) and ADR-082 (managed runtime).

## Context

After the Home Hub came up, Hogar's step 3 waited for devices with "Buscando dispositivos…" and
never moved. Home Assistant finds devices on the network by itself (mDNS, SSDP, DHCP), but each
discovery stays a *pending setup* until someone confirms it. Nobody did, so no device ever
appeared. ADR-079 left pairing to the engine without saying how ELISE starts it.

## Decision

- **Hogar lists what the engine found and lets the person pick.** Each device can be added
  ("Agregar"), skipped ("No, gracias", and the engine stops offering it), or set aside. The step
  can always be left ("Continuar" / "Omitir por ahora"). "Buscar dispositivos" is in Hogar's
  "Agregar" menu for later.
- **Each setup's steps, in ELISE's terms** (`src/core/home/discovery.ts`, pure and tested):
  - an empty form is a confirmation;
  - text, number, yes/no and choice fields are rendered; code, PIN, password and token fields
    are masked;
  - anything else (a browser sign-in, a progress screen, a menu, a field kind ELISE doesn't
    know) says "needs a step ELISE can't show yet" instead of half-working.

  Provider handler names and payloads never reach the screen.
- **Local only, through the Desktop.** The engine's admin token never leaves the computer (ADR-082).
  The chain is renderer → main (named IPC channels, zod-validated, signed-in owner only) →
  local runtime → Hub agent → engine. The actions are fixed: list, open, answer, ignore. Flow
  ids are validated, and only the step's own fields are sent. There is no URL, generic request
  or network scan from ELISE. On the web, Hogar says to open ELISE Desktop.
- **Engine APIs.** These are the ones Home Assistant's own frontend uses, verified in its
  source on 2026-10-19:
  - WebSocket `config_entries/flow/progress`, which lists the setups the engine started itself
    and excludes the ones a person started;
  - REST `GET` and `POST /api/config/config_entries/flow/{flow_id}` to read and answer a step;
  - WebSocket `config_entries/ignore_flow`.

  They aren't on the public WebSocket documentation page that ADR-079 restricted ELISE to. This
  is a deliberate, narrow exception: there is no documented alternative for confirming a
  discovery.
- **Picking up new devices.** After a device is added, the agent resyncs the registry (after 4 s
  and again after 20 s), so it appears in Hogar without a restart.
- **The "step done" flag** is per browser (`localStorage`). Without it, Hogar still opens as soon
  as one device exists.

## Validation owed

The unit tests cover the normalization and the screen. Still owed: a real discovery on a home
network (for example a Chromecast or a TP-Link plug) through the managed engine, which also
closes ADR-082's open "LAN discovery with a real Wi-Fi device" item.
