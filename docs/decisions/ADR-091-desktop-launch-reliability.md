# ADR-091: Desktop launch reliability

**Status:** Accepted (2026-10-19). Amends ADR-081/082/084.

## Context (what actually failed)

On the owner's PC, "Abrir ELISE Desktop" on the web never reliably opened the app, reopening
showed a black window, and only reinstalling helped. The logs, the registry and the packaged
builds showed four separate causes:

1. **A cold start from a link hung.** `main()` ran at the top of the main module, before the
   module-level bindings below it existed. Started as `elise.exe elise://home/setup`, it called
   `pendingLinks.push` on an uninitialized binding (the minified `TypeError: … reading 'push'`).
   The promise rejected unobserved, so the processes stayed alive with no window and no
   heartbeat. A shortcut start has no link, so it worked. That's why "Abrir" failed only when
   ELISE was closed.
2. **Local builds stood in for the installed app.** Unpacked builds in `desktop/out` (QA and
   `make`) registered themselves at login (`electron.app.ELISE`) and as the `elise://` handler,
   with the same profile and single-instance lock. After a reboot the local build could win,
   capture links, and then lose its files to the next rebuild. The log shows
   `ERR_FAILED loading elise-app://app/my-elise/home` six times: the black window.
3. **Hub registration race.** `registerHub` ran on every runtime event with no in-flight guard.
   Two overlapping calls created two hubs (300 ms apart) and the second revoked the first.
   Nothing healed a revoked credential, so Hogar showed "ELISE Desktop está sin conexión" with
   ELISE open.
4. **Presence wording.** "Sin conexión" came from the hub's presence alone, even while this
   person's Desktop was online.

## Decision

- The main-module bootstrap runs **last**. A failing `main()` shows an error and exits; it never
  hangs silently and never relaunches in a loop.
- A cold start from a link opens the window **on that page**. A page still loading is loaded at
  the asked page rather than sent a message it can't hear yet. A start with only rejected links
  still opens the usual window.
- Installed-only registration and a separate profile for local builds (see doc 27). The installed
  app removes the stale `electron.app.ELISE` login entry.
- **Hub link:**
  - registration is single-flight;
  - a 401 on the hub's heartbeat (revoked or missing credential) makes the runtime tell
    Desktop, which forgets the credential and links again, at most once a minute.
- **Presence:**
  - a deep link sends a heartbeat at once, so the web notices within seconds;
  - when the hub is stale but this person's Desktop is online, Hogar says "Preparando ELISE
    Home…", not "sin conexión".
- **Loads that keep failing:** after the retries, a dialog offers Reintentar, Reiniciar and
  Salir instead of a dark window.
- **Smoke test:** the package smoke test (CI on every main push) now also checks a cold start
  from `elise://home/setup`.

## Consequences

Code changes don't repair an installed binary. Each computer needs the fixed release once,
installed over the old one or through the updater; data, sign-in and ELISE Home are kept.
Already-installed builds without this fix still hang on a cold "Abrir" until they're updated.
