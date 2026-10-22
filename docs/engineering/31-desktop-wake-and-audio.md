# ELISE Desktop: wake word a distancia y pitidos en la voz

- **Fecha:** 2026-10-22.
- **Decisión:** [ADR-108](../decisions/ADR-108-desktop-wake-reliability-and-speech-stream.md). Revisa ADR-095 y la salida de ADR-030.
- **Estado:** implementado, sin commits, Desktop en 0.1.0-beta.27 (sin publicar).

## 1. Resumen

**Pitidos.**
- **Causa encontrada y corregida, con evidencia.** La voz se reproducía como un buffer de audio por cada fragmento que llegaba de la red. Renderizado en el mismo Chromium de ELISE Desktop (Electron 44.9, Chromium 152), ese método genera:
  - **clics en los bordes** entre fragmentos;
  - **a veces un fragmento entero con ~3× de energía aguda**, un "chirrido" corto en medio de una frase.
- **Ahora la voz sale como un único flujo continuo** (AudioWorklet), que en el mismo Chromium reproduce el audio **muestra por muestra igual al original, con 0 clics**.
- **Por qué solo Desktop:** Desktop siempre usa este reproductor, porque la palabra de activación pasa la conversación a la sesión "legacy". En la Web, si el deploy tiene `VOICE_RUNTIME=live`, la voz va por GPT-Live (WebRTC) y nunca pasa por él. No puedo ver las variables de Vercel para confirmarlo.
- **Una fuente más de pitidos, también de ELISE:** el sonido de activación sonaba en **cada candidato** del detector, incluso los que después se descartaban. Tu exportación del 21/10 muestra 3 sonidos de activación seguidos antes de la respuesta. Ahora solo suena en una activación validada.

**Wake word.**
- **Mejoras en la misma prueba (corpus sintético, modelo real):**
  - detección de **56,7 % a 70,8 %**;
  - falsas activaciones audibles de **60/h a 2/h**;
  - la misma latencia;
  - el principio del pedido se conserva en el 100 % de los casos.
- **Lo que sigue difícil:** voces a distancia con otra gente hablando (detalle en §4).

## 2. Arquitectura real del audio

```text
Micrófono ─ getUserMedia (AEC/NS/AGC de Chromium) ─┬─ Detector "ELISE" (Desktop, renderer)
                                                    │   MediaStreamTrackProcessor → 16 kHz (resampler propio)
                                                    │   → ring 8 s en memoria → compuerta de energía → Vosk (worker WASM)
                                                    │   → WakeArbiter (candidato ≠ activación) → captura (desde el inicio del enunciado)
                                                    │   → /api/voice/transcribe → matchWake → sesión de voz
                                                    └─ Sesión de voz (Web y Desktop): Microphone (MediaRecorder) → STT → chat

Respuesta: /api/chat → texto → /api/voice/speak (ElevenLabs u OpenAI, PCM 24 kHz en streaming)
  → SpeechPlayer → [antes] un AudioBufferSourceNode por fragmento, en un contexto a la tasa del dispositivo
                   [ahora] AudioWorklet "pcm-stream" en un contexto a 24 kHz → ganancia → salida
Sonidos propios: chime de activación (un contexto compartido), tono de completado, alarmas.
GPT-Live (Web): WebRTC con OpenAI, sin SpeechPlayer.
```

**Ciclo de vida.** El detector:
- escucha solo en `idle`, `sleeping`, `error` u `offline`;
- durante una conversación queda en "hold": el micrófono sigue abierto, para que un auricular Bluetooth no cambie de modo, pero no escucha;
- al terminar la respuesta (ahora, cuando el flujo realmente se vació) vuelve a escuchar con un reconocedor nuevo.

**Eco y ruido.** La cancelación de eco es la de Chromium, que usa como referencia lo que el propio Chromium reproduce. Eso cubre la voz y la música de ELISE. **No cubre** la música de otra aplicación (Spotify de escritorio, un video en el navegador): eso es ruido para el detector.

## 3. Pitidos: evidencia y corrección

**3.1. Tu exportación del 21/10.** 52 s de audio que ELISE programó:
- sin saturación, sin saltos de muestra, sin tonos ni bordes abruptos;
- con el detector nuevo, 0 eventos.

Es decir, la voz generada estaba limpia y el pitido se agregaba después. Lo único extra registrado fueron 3 sonidos de activación (a los 0 s, 4,9 s y 12,8 s).

**3.2. El reproductor, en el Chromium de ELISE Desktop.** Rendericé offline (con `OfflineAudioContext`) el mismo audio de dos maneras: dividido en fragmentos irregulares como lo hace el reproductor, y como un solo buffer.

| Prueba | 44,1 kHz | 48 kHz |
|---|---|---|
| Señal sintética, por fragmentos | 1 clic en un borde | un fragmento completo (5,27–5,46 s) con 3,3× de energía >12 kHz |
| Tu voz real (ElevenLabs), por fragmentos | clic a 0,62 s, ausente en el buffer único | chirrido agudo a 15,18 s, ausente en el buffer único |
| **Flujo continuo nuevo (worklet), 34 fragmentos irregulares** | — | **idéntico al original (diferencia 0), 0 clics** |

Los scripts del experimento quedaron en el scratchpad de la sesión; se reproducen con el binario de Electron del repo.

**3.3. Corrección.**
- `SpeechPlayer` envía PCM a un AudioWorklet en un contexto a 24 kHz. La única conversión de tasa es la del sistema de audio, sobre un flujo continuo.
- Fundidos cortos: 2 ms al arrancar o quedarse sin audio, 5 ms al interrumpir.
- Los cortes por falta de datos quedan registrados (`audio:underrun`).
- Si el entorno no tiene AudioWorklet, se usa el método anterior.
- El smoke del instalador verifica que el worklet carga a 24 kHz con la CSP real de la app.

**3.4. Lo que no está probado y cómo verificarlo.** No pude escuchar en tus parlantes. Si queda algún pitido:
1. En Configuración › Voz, tocá **"Analizar lo que suena"** mientras ELISE responde.
2. Graba 60 s de lo que suena en la computadora (solo audio del sistema, nunca la pantalla ni el micrófono).
3. Te dice para cada pitido si fue el sonido de activación de ELISE, si ya venía en la voz generada, si se agregó en la salida (después de ELISE) o si no viene de ELISE.

El informe se descarga solo si lo pedís, y la grabación solo si marcás la casilla.

## 4. Wake word

**4.1. Diagnóstico (antes).**
- **Motor:** Vosk (`vosk-browser` 0.0.8), modelo `vosk-model-small-es-0.42`, ambos Apache-2.0.
- **Gramática:** la palabra más unas 250 palabras competidoras.
- **Entrada:** 16 kHz mono, frames de 128 ms, ring de 8 s.
- **Problemas encontrados:**
  - **Compuerta de energía alta:** el reconocedor solo escuchaba por encima de 3× el ambiente y -38 dBFS. Desde 1,5–3 m o con música, muchas veces no llegaba a oír.
  - **Activaba con cualquier resultado parcial que contuviera "elise"**, también en medio de una frase ("le dije a Elise que…"). Esa era la mayoría de las falsas activaciones en reuniones.
  - **El sonido de activación sonaba antes de confirmar.** Si la transcripción descartaba el candidato, quedaba un pitido sin conversación.
  - **Pre-roll fijo de 1,6 s** para los parciales.
  - **Contexto de audio a 16 kHz** y procesador en el hilo principal. Si la página estaba ocupada, se podían perder frames.

**4.2. Cambios.**
- Compuerta: 2× el ambiente y -49 dBFS.
- Árbitro de candidatos: la palabra debe abrir la frase, confianza mínima, modo "guardado" después de falsas alarmas, pausa breve ante ráfagas, parciales ignorados con música de ELISE.
- Sonido de activación solo al validar.
- Captura desde el inicio del enunciado.
- Lectura del micrófono sin contexto de audio, con un resampler propio.
- Reinicio al cambiar de dispositivo.
- Diagnósticos locales.

La pausa después de "ELISE" ayuda (habilita el resultado final), pero no es obligatoria.

**4.3. Medición (antes / después).** 86 clips sintéticos (6 voces, español rioplatense) × distancia (0,5, 1,5 y 3 m simulados con nivel y reverberación) × fondo (silencio, música suave o fuerte, charla de reunión). Mismo modelo que se distribuye. Las reglas son las del código, reproducidas por `tests/unit/voice/wake-eval.test.ts`.

| Condición | v1 | v2 |
|---|---|---|
| 0,5 m: silencio / música suave / música fuerte / reunión | 30, 30, 29, 23 de 30 | 30, 30, 30, 20 de 30 |
| 1,5 m: silencio / música suave / música fuerte / reunión | 30, 28, **0**, 3 de 30 | 30, 30, **21**, 2 de 30 |
| 3 m: silencio / música suave / música fuerte / reunión | 28, **0**, 0, 3 de 30 | 29, **23**, 0, 3 de 30 |
| Detección total | 56,7 % | 70,8 % |
| Candidatos falsos por hora (30 min de charla de reunión, incluida "le dije a Elise") | 60 | 8 |
| Pitidos falsos audibles por hora | 60 | 2 |
| Latencia desde el inicio del habla (mediana / p95) | 0,69 / 1,33 s | 0,69 / 1,20 s |
| Pedidos con el principio conservado | 100 % | 100 % |
| Frames decodificados (costo de CPU) | 45 % | 69 % |

**Los falsos que quedan en v2** son todos la frase trampa "El ISE de la planilla…" (fonéticamente "elise"). La transcripción los rechaza y activan el modo guardado.

**Límites de la medición:**
- voces sintéticas;
- sin el AGC ni la cancelación de eco reales;
- música sin voz cantada;
- la latencia no incluye la transcripción en la nube, que sigue siendo lo más lento.

**No medido:** CPU real en reposo, Bluetooth, suspensión y reanudación.

## 5. Archivos

**Nuevos:**
- `src/core/voice/wake-arbiter.ts` (reglas)
- `src/core/voice/resample.ts`
- `src/core/voice/beep-detect.ts`
- `src/features/voice/output-check.ts`
- `public/audio/pcm-stream-worklet.js`
- `desktop/scripts/wake-eval/` (generador, simulador, README)
- `tests/fixtures/wake-eval-traces.json` (solo texto y tiempos del reconocedor)
- Pruebas: `tests/unit/voice/{wake-arbiter,wake-eval,pcm-stream,beep-detect}.test.ts`

**Modificados:**
- `desktop/src/renderer/wake/{vosk-detector.ts,desktop-wake.tsx,vosk-worker-client.ts}`
- `src/core/voice/wake-detector.ts` (compuerta, `onDetected` con la decisión)
- `src/features/voice/{speech-player.ts,sound-log.ts}`
- Puente: `desktop/src/main/{security.ts,ipc.ts}`, `desktop/src/preload/index.ts`, `desktop/src/shared/channels.ts`, `src/core/platform/platform.ts`
- Configuración › Voz: `src/features/settings/voice-settings.tsx`, i18n
- `desktop/scripts/smoke.mjs` (2 chequeos de audio)
- `tests/unit/desktop/main-security.test.ts`
- `desktop/package.json` (beta.27)
- `.gitignore`, `.prettierignore`
- `package.json`: faltaba el salto de línea final

## 6. Resultados

| Verificación | Resultado |
|---|---|
| Lint, typecheck web y Desktop, build | OK |
| Pruebas | 2556 pasan, 2 omitidas, 0 fallan (incluye 5 de evaluación, 12 del árbitro y el resampler, 5 del flujo, 5 del detector de pitidos, 3 de seguridad de captura) |
| Formato | OK salvo `desktop/voice_exports/*.json`, tu exportación |
| Desktop empaquetado + smoke | 8/8, incluidos "voice output stream loads (worklet, 24 kHz)" y "wake word capture without an extra audio context" |
| Instalador (Squirrel) | No generado (lo hacés al publicar) |

## 7. Pruebas manuales pendientes (en tu computadora, con la beta.27)

1. **Pitidos:** pedí 3 respuestas largas por voz (por ejemplo una ruta o un resumen de noticias), en parlantes y en auriculares. Si escuchás algo, usá "Analizar lo que suena" y mandame el informe.
2. **Distancia:** decí "ELISE" en voz normal a ~0,5, 1,5 y 3 m, 5 veces cada una. Anotá cuántas activan a la primera.
3. **Pedido en una sola frase:** "ELISE, ¿qué tengo hoy?" sin pausa. La transcripción tiene que empezar con "qué".
4. **Música:** con música moderada por los parlantes, decí "ELISE" desde 1,5 m.
5. **Reunión:** dejá ELISE escuchando durante una reunión real de 30 min y contá los sonidos de activación. Lo esperado es 0 o muy pocos, y ninguna conversación iniciada.
6. **Dispositivos:** conectá y desconectá auriculares Bluetooth o USB con ELISE en reposo. Debe seguir respondiendo a "ELISE" con el dispositivo nuevo.
7. **Suspender y reanudar,** e **inicio con Windows,** con la app minimizada en la bandeja.

## 8. Build

```
npm run make:desktop -- --targets @electron-forge/maker-squirrel
node desktop/scripts/publish-release.mjs --channel beta
```

Para repetir la evaluación: `desktop/scripts/wake-eval/README.md`. Requiere `pip install vosk numpy` y gasta unos centavos de OpenAI TTS la primera vez.
