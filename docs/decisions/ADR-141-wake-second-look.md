# ADR-141: Una segunda mirada local antes del Orb

**Status:** Accepted (2026-11-20). Desktop 0.1.0-beta.63.

## Context

- **Falsas activaciones en reuniones.** Por ejemplo, «Observaciones…» encendía el Orb y sonaba el tono.
- **Lo que mostró el log real** (`desktop_wake_outcome`, 15–20/11):
  - Las 58 activaciones entraron por un resultado *parcial* de Vosk, con `confidence: null`.
  - El umbral de confianza de ADR-108 solo se aplica a resultados finales, así que en la práctica no filtraba nada.
- **Causa de fondo.** El reconocedor de la palabra solo conoce «ELISE» y unas 250 competidoras. Cualquier palabra parecida fuera de esa lista se fuerza a «ELISE», y con confianza alta:
  - «Analice…» y «Realice…»: 0,9–1,0.
  - «Alice…»: 0,6–1,0.
- **La transcripción en la nube no sirve como filtro de lo visible.** Descarta esos casos, pero llega después del Orb y del tono.

## Decision

- **Segunda mirada en el dispositivo antes del Orb y del tono.**
  - Cuando el árbitro (ADR-108) acepta una candidata, la captura sigue en silencio.
  - El inicio de la captura (hasta unos 2,2 s) se decodifica otra vez con el vocabulario completo del mismo modelo, sin gramática.
  - El reconocedor es uno solo, creado una vez y reutilizado.
- **El vocabulario completo no contiene «ELISE».**
  - El nombre real sale como una conjetura dudosa o con forma de nombre: `elis`, `ellis`, `hélice`, `el hice`, `dice`.
  - Una palabra parecida sale como ella misma y con confianza: `analice 1.00`, `realice 1.00`, `elixir 1.00`.
- **Regla, en `secondLook` de `src/core/voice/wake-arbiter.ts`.** Se rechaza la candidata si la primera palabra cumple una de estas condiciones:
  - es otro nombre (`alice`, `alex`, `elena`…);
  - tiene 5 o más letras, confianza ≥ 0,8 y no es una de las formas medidas del nombre.
  - Sin palabras, la candidata se acepta.
- **Una candidata rechazada:**
  - no muestra nada ni suena;
  - no se manda a transcribir;
  - queda en el log local como `second_look`, solo el tipo, sin palabras ni audio.
- **Si falla, la candidata pasa (fail-open).** Si la segunda mirada tarda más de 1,5 s o el worker falla, la candidata sigue como antes.
- **Sobre la respuesta de ELISE no se aplica** (ADR-109). Ahí el audio empieza con su propia voz; esas llamadas las sigue verificando la transcripción.

## Medición

El corpus sintético (`desktop/scripts/wake-eval`) ahora incluye 18 frases trampa que **abren** con una palabra parecida: «Observaciones», «Analice», «Realice», «Alice», «Elixir», «Excelente», «O sea»… En total son 512 enunciados negativos en 4 condiciones.

| | v2 | v2 + segunda mirada |
|---|---|---|
| Frases trampa que muestran el Orb | 9,2 % | **2,3 %** |
| Candidatas falsas por hora de habla | 44 | **12,8** |
| Detección de llamadas reales | 69,4 % | 68,3 % |
| Latencia mediana / p95 (sin el tiempo de decodificación) | 0,69 / 1,33 s | 0,82 / 1,46 s |

- **Detección:** las llamadas perdidas son todas con música fuerte o charla de fondo.
- **Esperar más audio no compensa:** esperar 0,25–0,75 s más bajó las falsas a 1,8 %, a cambio de 0,25–0,75 s más de latencia.
- **Decodificación:** en nativo, unos 100 ms por segundo de audio. En WebAssembly se estima 2–3 veces más.

## Consequences

- **Falsas que quedan:** «El ISE…», que fonéticamente es el nombre, y algunas palabras parecidas dichas con poca claridad. La transcripción las sigue descartando, igual que antes.
- **El Orb aparece unos 0,2–0,6 s más tarde** que antes de este cambio.
- **Medición real:** la proporción `not_a_call` / (`session` + `command` + `not_a_call`) en `desktop.log` es la tasa de falsas visibles. `second_look` cuenta las que se evitaron.
- **Límite:** voces sintéticas, sin AGC ni cancelación de eco reales. La tasa con voces reales hay que confirmarla con el log del uso diario.
