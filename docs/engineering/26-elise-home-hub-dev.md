# ELISE Home Hub: local development

This is an internal guide for running ELISE Home end to end on a development PC. In production,
ELISE Desktop hosts this same service and manages Home Assistant itself (ADR-080). These steps
are the developer path. Never paste real tokens into issues, logs or commits.

## 1. Prepare the database

Apply migration `20261031000049_elise_home.sql`. Until it's applied, Hogar shows the setup
screen and the `home.*` tools answer "ELISE Home needs the latest database update".

## 2. Run Home Assistant locally

Use a [supported installation](https://www.home-assistant.io/installation/), for example the
container image, on the same machine or the local network (`http://localhost:8123`).

1. Add at least one Wi-Fi device through Home Assistant's own integrations.
2. In your Home Assistant profile, create a **long-lived access token** for a user that can read
   states and the entity registry.

## 3. Pair the hub

1. In ELISE, open **Mi ELISE › Hogar**, expand **Vincular un Home Hub de desarrollo** and
   generate a code (`ELISE-XXXX-XXXX`, single-use, valid 10 minutes).
2. Run the setup:

   ```bash
   HA_TOKEN=<token> npm run home-hub -- setup
   ```

   It asks for the ELISE URL, the Home Assistant URL (which must be local) and the code.

The configuration is written to `~/.elise-home/config.json` with `0600` permissions. Prefer the
`HA_TOKEN` environment variable over storing the Home Assistant token in that file.

## 4. Run it

```bash
HA_TOKEN=<token> npm run home-hub -- start
npm run home-hub -- status
HA_TOKEN=<token> npm run home-hub -- doctor
```

| Command | What it does |
|---|---|
| `start` | Heartbeat every 20 s, initial sync, state changes as they happen, commands by long-poll |
| `status` | Shows the configuration, without secrets |
| `doctor` | Checks the ELISE credential, Home Assistant REST and WebSocket, events and discovery |

## 5. Verify

1. Hogar moves from "Preparando ELISE Home…" to the dashboard by itself, through Realtime.
2. Devices appear with their rooms.
3. Toggle a device in Hogar, or ask in chat: "Prendé la luz del escritorio". The agent logs
   `home_command … succeeded`.
4. Stop the agent. After about 75 s, Hogar shows "Home Hub sin conexión" and commands answer
   "nothing was sent".
5. Start it again. Commands queued more than 30 s earlier are `expired` and never run.

## Common failures

| Symptom | Fix |
|---|---|
| `doctor`: ELISE 401 | Pair again (the hub was revoked or replaced) |
| Home Assistant 401 | Create a new long-lived token |
| "Home Assistant must be on this machine or the local network" | Use `localhost` or a LAN address. The hub never contacts other hosts |
| No devices | Check that the token's user can read states. Devices exposing only diagnostic entities are hidden by design |

## Protocol

The hub calls `/api/home/hub/{pair,heartbeat,sync,states,commands,commands/:id}` with its
bearer token. The protocol version is reported on every heartbeat (`HOME_PROTOCOL_VERSION`), so
an incompatible hub shows "ELISE Desktop necesita actualizarse".
