# ADR-139: Lo dictado no es el título: nombres, comas y correcciones de eventos

**Status:** Accepted (2026-11-07). Extiende ADR-065 y ADR-127.

## Context

Una conversación real por voz:

1. «Agregame por favor para el lunes 16 de noviembre, no, mejor para el domingo 15, terminar video, grabar punto AI.»
2. ELISE creó `Terminar video, grabar Punto AI` (la fecha salió bien).
3. Hicieron falta tres correcciones más para llegar a `Terminar video Grabar.ai`.

La auditoría del flujo (STT → `chat-service` → modelo → tool → provider) encontró:

- **ADR-065 no cubría el calendario.** `REPAIR` no tenía `calendar_event`, así que un evento no dejaba referencia, no se resolvía como objetivo y no había pista de turno ni herramienta garantizada. Cada corrección dependía solo de que el modelo encontrara el id en las notas.
- **Las correcciones del caso no se detectaban.** «Me refiero…» (solo existía «me refería»), «sacale la coma», «la G mayúscula», «todo junto».
- **El título de eventos y notas no pasaba por `normalizeEntityTitle`**, a diferencia de tareas, listas, hábitos y objetivos.
- **Un nombre con punto no se reconocía dictado.** El resolver compara palabras: «grabar punto ai» nunca se acercaba a «Grabar.ai».
- **Las instrucciones solo nombraban «punto com»** y nada decía qué hacer con una coma puesta por una pausa.
- **Una orden nueva podía leerse como corrección** («Agendá X, quise decir el jueves» justo después de otra escritura).

## Decision

Sin etapa nueva ni llamada extra al modelo. Interpretar es del modelo; validar y apuntar al objeto es del código.

- **La representación estructurada ya existe.** El turno guardado es la transcripción cruda (ADR-065: nunca se reescribe) y los argumentos de cada tool son la intención con sus campos. No se agrega `interpretedIntent`: sería una segunda fuente de verdad, y solo se podría llenar con otra llamada al modelo.
- **Eventos en la reparación:** `calendar_event` en `REPAIR` y `NOUNS`. Un evento borrado no deja referencia. Con dos eventos del mismo turno, ELISE pregunta.
- **Deshacer una edición nunca borra:** si el nombre no cambió y la escritura no fue una creación, la pista pide restaurar, no eliminar.
- **Detección:** se suman «me refiero», comas, tildes y espacios, mayúscula o minúscula, «todo junto», «es un nombre». Un mensaje que abre con un verbo de creación («agendá», «anotá», «creá»…) es siempre una escritura nueva, no una corrección.
- **Títulos:** eventos y notas usan `normalizeEntityTitle`. El cuerpo de una nota no se normaliza nunca.
- **Marcas:** `BRAND_TERMS` suma YouTube, iPhone, LinkedIn, GitHub y TikTok. Siguen fuera las palabras comunes («Make», «Notion»).
- **Nombres dictados:** `findCanonicalReferences` resuelve una forma con punto («grabar punto ai», «grabar .AI») solo si ese nombre ya existe con esa grafía en el vocabulario del usuario (Espacios, listas, contextos). El vocabulario se arma por workspace, así que no cruza usuarios.
- **Pedidos literales:** «exactamente», «tal cual», «textual» se suman a `LITERAL`. En ese turno no se aplica ningún alias, tampoco los resueltos antes.
- **Comas, puntuación dictada y campos:** los decide el modelo, con reglas en `CORE_INSTRUCTIONS`. No hay limpieza determinística de comas: el código no distingue una coma de pausa de una deliberada, y un texto tipeado tiene que conservarla.
- **Duplicados:** `calendar.createEvent` hace como `tasks.create` (ADR-127). Mismo título y mismo inicio: no crea, avisa y pide `allowDuplicate`. `sameTitle` pasa a `core/text.ts`.
- **Confirmación:** la pista de reparación pide el valor final tal como lo devolvió la tool, también por voz.

## Consequences

- Corregir un evento toma un turno, sobre el mismo id. El `PATCH` de Google ya enviaba solo los campos cambiados.
- Crear un evento suma una lectura al proveedor antes de escribir. Si esa lectura falla, se crea igual.
- Unos 250 tokens más en el prefijo cacheado (ADR-025). Sin llamadas nuevas al modelo. La telemetría sigue siendo `repair.*` y `canonical_reference.*`, sin contenido.
- **Límite, marcas que el usuario nunca escribió:** sin vocabulario, «Grabar.ai» depende de la regla del prompt. La Memoria se le muestra al modelo pero no genera alias.
- **Límite, minúscula inicial:** `normalizeEntityTitle` no ve la instrucción, así que «poné literalmente punto AI» guarda `Punto AI`. Pasa igual en todos los módulos. Respetarla exige un campo nuevo en cada tool de escritura.
- **Límite, «Elise» como persona:** el límite de ADR-065 alcanza ahora a eventos y notas («Reunión con ELISE»).
- **Evaluación:** `tests/unit/eval-voice-titles.test.ts` prueba la mitad determinística. Si el modelo real escribe esos argumentos queda para una evaluación en vivo.
