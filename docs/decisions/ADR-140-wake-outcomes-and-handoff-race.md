# ADR-140: Cómo termina cada «ELISE», y lo dicho que no se pierde en el traspaso

**Status:** Accepted (2026-11-14). Desktop 0.1.0-beta.60.

## Context

- **13–14/11.** ELISE se activaba, no escuchaba y volvía a escuchar la palabra, a los 6–7 s. El log solo registraba `in_conversation` → `listening`. No quedaba registrado si la transcripción falló, si el texto no empezaba con «ELISE» o si ninguna sesión tomó el pedido. La causa resultó ser la cuenta de OpenAI sin crédito (`insufficient_quota`): cada captura quedaba como «no leída». Sin transcripción, además, las falsas activaciones no se descartaban y el detector nunca se volvía más exigente.
- **Con la app abierta,** «ELISE» sonaba y no arrancaba si llegaba justo cuando terminaba una respuesta con la conversación continua prendida. La sesión ya había pasado a `listening`, y `deviceWake` ignoraba todo traspaso que no la encontrara en `sleeping`. Las palabras capturadas por el Desktop se perdían.

## Decision

- **`desktop_wake_outcome` en el log local** (`%APPDATA%\ELISE\logs\desktop.log`), uno por cada palabra detectada.
  - Resultados posibles: `offline`, `let_go`, `ignored`, `unread`, `not_a_call`, `command`, `session` o `no_session`.
  - Datos: si el detector estaba en modo cauteloso, la confianza, los segundos capturados, si hubo habla después de la palabra, cuánto tardó la transcripción y cuántas palabras seguían a «ELISE».
  - Nunca el texto ni el audio. El proceso principal valida los campos con zod.
- **Lo que el Desktop capturó no se tira.** Si la sesión ya está escuchando cuando llega el traspaso, toma ese texto como el turno, una sola vez. «ELISE» sola no cambia nada.
- **El header queda en `z-[45]`:** sus menús (perfil, Mi ELISE) se abren sobre los paneles laterales (`z-40`) y debajo de los diálogos (`z-50`).

## Consequences

- Un `unread` repetido apunta a la transcripción: crédito, red o proveedor. Un `not_a_call` repetido son falsas activaciones, o una forma de «ELISE» que no se acepta. `no_session` significa que la página no tomó el pedido.
- **Límite:** un `not_a_call` después del tono sigue sin aviso sonoro.
- **Límite:** nada avisa todavía que un proveedor se quedó sin crédito.
