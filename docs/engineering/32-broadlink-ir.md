# Broadlink infrared (ADR-110)

This covers TVs, air conditioners and fans controlled from ELISE through a Broadlink RM4 mini
or RM4C mini, on the home engine that ELISE Desktop manages.

## Pieces

| Where | What |
|---|---|
| `supabase/migrations/20261114000063_home_infrared.sql` | `ir_controller` type, 16 kB capabilities, insert policy for `ir:` devices |
| `src/core/home/model.ts` | `ir_blaster` / `ir` capabilities, `button` action, `ir` hub action, `validateIr`, `estimateIr`, `IR_BUTTONS`, `presetKey` |
| `src/core/home/discovery.ts` | `lanHost`: the only addresses "agregar por IP" accepts |
| `src/infrastructure/home/home-assistant.ts` | Broadlink `remote` becomes an `ir_controller`; `ir` becomes `remote.send_command` |
| `home-hub/agent.ts` | `learnIr` (lock, turn_on, 45 s), `addBroadlink`, `ir`-only checks in `execute` |
| `home-hub/home-assistant-client.ts` | Per-call timeout, `flowStart("broadlink")` |
| `desktop/src/main/ipc.ts`, `preload`, `runtime/index.ts` | `homeIrLearn` and `homeAddBroadlink`: owner only, zod-validated |
| `src/application/home-service.ts` | `createIrDevice`, `updateIrCommands`, routing to the controller in `hubClaimCommands`, estimated state, sync protection, IR remove |
| `src/features/home/ir-setup.tsx` | The assistant: controller (or diagnostics), kind, buttons |
| `src/features/home/device-discovery.tsx` | `ManualBroadlink` (add by IP) |
| `src/features/home/home-view.tsx` | "Agregar" menu entry, IR controls in the device sheet, controller call-to-action, IR buttons in modes |

## Flows

### Adding the Broadlink

- **Found by the engine:** "Buscar en mi red" (ADR-090) works as for any device.
- **Not found:** "¿No aparece? Agregalo por su IP" in the same dialog and in the assistant. The
  hub starts the `broadlink` flow and submits the host; the remaining steps (unlock, name)
  appear in the same form.
- When it's added, the controller appears under "Controles infrarrojos".

### Adding a TV or an AC

1. In Hogar, choose **Agregar › Equipo infrarrojo**, or **Agregar equipo** in the controller's
   sheet.
2. Pick the controller.
3. Pick the kind, a name and a room. ELISE creates the device.
4. For each button, press **Aprender**. ELISE listens for 30 s, then sends the button once and
   asks "¿El equipo reaccionó?". Choose **Funcionó** or **No funcionó**, and use **Aprender de
   nuevo** if needed.
5. For an AC, choose a mode, temperature and fan, then **Capturar este ajuste**. Set the remote
   to that setting and press any button on it.

### Using it

- **Sheet:** the verified buttons, the note that the state is estimated, and **Gestionar
  botones**.
- **Voice and chat:** the same `home.control` tool.

  | Request | Result |
  |---|---|
  | "silenciá la tele" | Presses `mute` |
  | "subí el volumen de la tele" | Presses `volume_up` 2× |
  | "poné el aire a 24" | Sends the captured 24 °C preset, or explains which presets exist |
  | "apagá la tele" with only a toggle button | ELISE asks before pressing it |

- **Modes:** each infrared device takes one verified button.

## Tests without hardware

- `tests/unit/home/home-ir.test.ts` uses a simulated Broadlink in the engine. It covers:
  - normalization;
  - `send_command`;
  - the honesty rules;
  - `lanHost`;
  - the agent's learn: off → on, timeout, busy, bad names, unavailable;
  - sending to the controller and mixed actions refused;
  - add by IP;
  - the cloud: creation, buttons, routing a command to the controller, estimated state, sync
    never removing infrared devices, removal never touching the Broadlink.
- `tests/integration/home-infrared.test.ts` runs migration 063 on Postgres (PGlite). Only an
  owner can create an infrared device, only on a controller of their own hub.
- `tests/unit/home-discovery-ui.test.tsx` covers add by IP: a public address is refused and the
  setup continues.

## Qué hago mañana cuando llegue el Broadlink

1. **Antes de ELISE**, configurá el Broadlink con la app oficial de Broadlink. Usá la misma red
   Wi‑Fi de 2,4 GHz que la compu donde corre ELISE Desktop.
   - Si la app ofrece "Lock device", dejalo **desbloqueado**.
   - Anotá la IP que muestra la app (o buscala en el router).
   - Conviene reservarle esa IP en el router (DHCP fija).
2. **Actualizá ELISE Desktop** a la versión que incluye esto. Aplicá la migración 063 en
   producción (`npx supabase db push`, junto con la 062 pendiente).
3. En **Hogar › Agregar › Buscar en mi red**, debería aparecer "Broadlink" o "RM4 mini".
   **Agregar**: si pide desbloquear, marcalo; si pide nombre, poné por ejemplo "Broadlink
   living".
   - **Si no aparece:** usá "¿No aparece? Agregalo por su IP" con la IP del paso 1.
   - **Si dice que no pudo conectarse:** revisá que esté enchufado, en la misma red y
     desbloqueado. En Windows, ELISE Home usa red *mirrored* de WSL2; el descubrimiento por
     broadcast puede no llegar y por eso existe el alta por IP.
4. Esperá unos segundos: aparece en **Dispositivos** como control infrarrojo.
5. Abrilo y elegí **Agregar equipo**, por ejemplo la TV:
   1. Aprendé **Encender/apagar**, **Subir volumen**, **Bajar volumen** y **Silencio**.
   2. Apuntá el control al Broadlink, a unos 10 cm, y presioná el botón cuando ELISE escuche.
   3. Confirmá con "Funcionó" solo si la TV reaccionó.
6. Para el **aire**: aprendé **Apagar** y capturá uno o dos ajustes, por ejemplo Frío 24 °C y
   Calor 22 °C.
7. Probá por voz o chat:
   - "silenciá la tele";
   - "subí el volumen de la tele";
   - "poné el aire a 24";
   - "apagá el aire";
   - "apagá la tele": con un solo botón de encendido, ELISE debe preguntar antes.
8. Probá un **modo** que mezcle una luz Wi‑Fi y un botón de la TV.
9. Si algo falla:
   - **Hogar › diagnóstico de ELISE Home:** los registros `home_ir_learned` y
     `home_ir_learn_failed` no incluyen códigos ni tokens.
   - **"No llegó ninguna señal":** acercá el control y reintentá.

## What still needs a real device

- Learning with a real RM4 mini and RM4C mini: timing, range, and the unlock step in the setup.
- Whether the AC remote really sends its full state with each press.
- `num_repeats` behavior on the target TV.
- Discovery on WSL2 mirrored networking with the real router.
