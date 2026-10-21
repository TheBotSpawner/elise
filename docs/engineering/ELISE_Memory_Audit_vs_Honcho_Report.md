# ELISE: auditoría de memoria nativa frente a Honcho

- **Fecha:** 2026-10-21.
- **Código auditado:** rama `main`, último commit `c84d13b` más los cambios locales de Tiempos (no tocan memoria). Hay 61 migraciones; la última es `20261112000061`.
- **Benchmark:** Honcho 3.4.0, publicado el 2026-10-20 y consultado el 2026-10-21.
- **Tipo de trabajo:** auditoría de solo lectura. No se modificó código ni datos y no hubo commits. Este informe es el único artefacto nuevo.

---

## 1. Resumen ejecutivo y veredicto

**Veredicto: No.** ELISE no es equiparable a Honcho hoy en el resultado para el usuario. Tiene una base sólida de *recuerdo episódico* (Universal Recall) y una memoria explícita pequeña y controlable, pero no tiene una memoria que *aprenda sola ni razone* sobre la historia del usuario.

Las tres razones principales:

1. **No hay captura automática.** Memoria crece solo cuando el modelo llama a `memory.remember` en el turno, lo que en la práctica ocurre casi siempre porque el usuario lo pide. No hay extractor en background, ni inferencia de patrones entre sesiones, ni consolidación. ADR-068 lo dice explícitamente: *"Not done: automatic extraction from past conversations"*. Honcho, en cambio, deriva conclusiones de cada mensaje en background y consolida con "dreaming".
2. **No hay representación del usuario ni razonamiento multisesión.** ELISE inyecta hasta 60 pares clave/valor en cada turno y puede buscar fragmentos de conversaciones viejas. No existe nada equivalente a una representación o "peer card" sintetizada, a conclusiones deductivas/inductivas con premisas, ni a un agente dialéctico que responda "¿cómo suelo organizarme?" juntando evidencia de muchas sesiones.
3. **El ciclo de vida de los derivados está incompleto.** Olvidar un hecho no lo saca de Recall, de los resúmenes de sesión ni del historial de versiones guardado. No hay vigencia/caducidad, ni métricas de calidad de memoria, ni evaluaciones.

**Lo que sí está bien y conviene conservar:**

- Recall híbrido (pgvector + full‑text con RRF) privado por usuario, con RLS probada.
- Indexado idempotente con jobs y barrido.
- Borrado en cascada al eliminar una conversación.
- Un modelo de hechos con procedencia, `stated`/`inferred`, versión anterior conservada y bloqueo de secretos.
- Métodos (memoria procedimental) versionados y con trazas de uso.
- Notas de contexto por Space y perfiles de contexto/entidades explícitos.
- Una disciplina de diseño clara: no convertir datos vivos en memoria.

---

## 2. Qué existe hoy realmente

Leyenda de evidencia:

- **Operativo** solo si hay código en el camino de ejecución real *y* pruebas que lo ejercitan.
- **"Implementado"** cuando el código está cableado pero no vi una validación de punta a punta.
- **Producción:** no tuve acceso a la base de producción. No sé cuántos hechos o fragmentos hay ni si los jobs de Trigger.dev corren allí.

| Capacidad | Estado | Evidencia principal |
|---|---|---|
| Memoria explícita (guardar/listar/olvidar por herramienta) | **Operativo** | `src/core/tools/settings.ts` (`memory.list`, `memory.remember`, `memory.forget`). Pruebas en `tests/unit/core/recall.test.ts` ("memory: remember…", "memory never stores secrets"). |
| Modelo de hechos con procedencia, `stated` vs `inferred`, reemplazo y tope de 100 | **Operativo** | `src/core/memory/model.ts:80-133` (`remember`), `:105` (una inferencia no pisa lo dicho), `:27` (`MAX_FACTS`). Pruebas en `tests/unit/core/settings-foundations.test.ts`. |
| Inyección de memoria en cada turno de chat/voz | **Operativo** (la prueba cubre el armado del prompt, no un turno real) | `src/application/chat-service.ts:527` → `memoryForContext` (`src/application/memory-service.ts:87`) → `src/core/agents/context.ts:487-493`. |
| Settings › Memoria (ver, agregar, editar, olvidar, borrar todo, apagar) | **Implementado** (sin prueba de UI encontrada) | `src/features/settings/memory.tsx`, `src/features/settings/actions.ts:202+`. |
| Poda de evidencia de conversaciones borradas | **Implementado** (la función pura está probada) | `prune` en `src/core/memory/model.ts:174`, que se ejecuta en `getMemory` (`memory-service.ts:79`). |
| Universal Recall: indexado de chat y voz | **Operativo** (unitarias + PGlite) | `src/application/recall-service.ts` (`indexConversation`, `indexVoiceSession`, `queueRecallIndex`, `sweepRecall`, `catchUpRecall`), `src/core/recall/indexer.ts`. |
| Búsqueda híbrida semántica + léxica + fechas | **Operativo** | `search_recall_chunks` en `supabase/migrations/20260930000015_recall_self_control.sql:128`. Pruebas en `tests/integration/database.test.ts` › "universal recall" (5 pruebas, todas pasan). |
| Precarga de Recall por intención ("¿qué hablamos…?") | **Operativo** (solo regex) | `recallIntent` en `src/core/recall/model.ts:318`, `chat-service.ts:264-265`. |
| Herramientas de historial (`history.search`, `history.getContext`, `history.getInteraction`, `history.getRecent`) | **Operativo** | `src/core/tools/history.ts`. |
| Resúmenes de sesión (título, resumen, temas) | **Implementado** | `summarizeWithAI` en `src/core/recall/indexer.ts:111`. Recall no los busca; solo los usan `history.getRecent` y la lista de Historial. |
| Jobs: indexar, backfill y barrido cada 15 minutos | **Implementado** (no se pudo verificar en producción) | `src/trigger/recall.ts`. |
| Borrar una conversación borra sus fragmentos y vacía la sesión | **Operativo** | Trigger `forget_archived_conversation` (migración `:106-125`), con prueba PGlite. |
| Métodos (memoria procedimental, versionada, con trazas de uso) | **Operativo** (fuera del alcance profundo de esta auditoría) | ADR-040, `chat-service.ts` (`planTurnMethods`, `recordMethodUse`). |
| Notas de contexto por Space / General Knowledge | **Operativo** | `spaceNotes` en `chat-service.ts:1255`. |
| Perfiles de contexto y entidades (personas/organizaciones) | **Implementado** (los crea el usuario o la IA de forma explícita) | Migración `20261001000019`, `src/core/tools/contexts.ts`. |
| Extracción automática de hechos, preferencias o patrones | **Ausente** | No hay llamadas ni jobs. ADR-068 lo declara pendiente. |
| Consolidación / dreaming / deducción / inducción | **Ausente** | — |
| Representación sintetizada del usuario (perfil, peer card) | **Ausente** | — |
| Agente de razonamiento sobre memoria (estilo dialéctico) | **Ausente** | El modelo del chat puede encadenar `history.search` por sí solo; no hay un agente ni un presupuesto dedicados. |
| Vigencia, caducidad y decaimiento | **Solo diseñado** | `docs/architecture/11-memory-entities-context.md` §20-21, §89. |
| Recuperación por relevancia de *hechos* | **Ausente** | Se inyectan todos los hechos activos (hasta 60), sin ranking. |
| Memoria en GPT‑Live (modelo de voz al frente) | **Parcial** | Las instrucciones de `liveInstructions` no incluyen memoria. Solo la tienen las delegaciones, que pasan por `prepareTurn`. |
| Memoria en tareas programadas (Morning Brief, etc.) | **Ausente** | `buildContextPackage` solo se usa en `chat-service.ts`; el runner de schedules no lee memoria. |
| Métricas y evaluaciones de calidad de memoria | **Ausente** | Solo hay logs operativos (`recall.indexed`, `recall.sweep`, `recall.catch_up`, `memory.remembered` en auditoría). |

---

## 3. Arquitectura actual de ELISE

```text
Captura
  Chat / voz legacy / Desktop ──► /api/chat ──► chat-service.startChatTurn
  GPT-Live ──► live-voice-service.runDelegation ──► chat-service.prepareTurn
      │  messages (texto)          interaction_turns (voz sin hilo)
      ▼
  queueRecallIndex (chat-service.ts:1215)
      ├─ con Trigger.dev: task "recall-index" (reintentos 3, idempotencia por minuto)
      └─ sin Trigger.dev: indexConversation / indexVoiceSession en el mismo proceso
  recall-sweep (cron */15) y recall-backfill ── red de seguridad
      ▼
  indexSession: chunkTurns → embeddings (text-embedding-3-small, 1536)
      → recall_chunks (+ fts)  ·  resumen LLM cada 6 turnos → interaction_sessions

Memoria explícita (sin pipeline)
  Modelo en el turno ──► memory.remember / memory.forget ──► settings-service (auditoría)
      ──► memory-service ──► user_preferences["memory.facts"] (un array JSON)
  Settings › Memoria ──► actions.ts ──► memory-service (mismo almacenamiento)

Respuesta
  chat-service.prepareTurn
      ├─ memoryForContext → todos los hechos activos (≤60) en el prompt dinámico
      ├─ recallIntent? → prefetchRecall (2.5 s máx., 3 resultados) → recallEvidence
      ├─ Métodos (alcance + coincidencia léxica), notas de Space, contexto activo
      └─ el modelo puede llamar a history.search / getContext / memory.list
      ▼
  buildContextPackage (core/agents/context.ts) ──► LLM ──► respuesta
```

**Inventario real.**

- **Tablas:**
  - `interaction_sessions`, `interaction_turns`, `recall_chunks` (vector(1536), HNSW, GIN sobre `fts`), `messages`, `conversations`;
  - `user_preferences` (las claves `memory.enabled` y `memory.facts`);
  - `methods`, `method_versions`, `method_uses`, `method_references`;
  - `context_profiles`, `context_links`, `context_interactions`, `entities`;
  - `knowledge_*` (documentos; no es memoria).
- **RLS:**
  - `recall_chunks`, `interaction_sessions` e `interaction_turns`: solo el autor lee y solo el service role escribe (migración `:199-212`).
  - `user_preferences`: "Users manage their own preferences" (`20260929000001:153`).
- **Jobs:** `recall-index`, `recall-backfill`, `recall-sweep` (`src/trigger/recall.ts`). No hay ningún job de memoria.
- **Contratos:**
  - `MemoryFact` (`src/core/memory/model.ts`);
  - `RecallReader`, `RecallHit`, `RecallResult` (`src/core/recall/model.ts`);
  - `IndexPorts` (`src/core/recall/indexer.ts`).

No existe una tabla `memories`, ni una memoria vectorizada de hechos, ni una cola de derivación.

---

## 4. Honcho: capacidades documentadas y alcance de la comparación

Fuentes oficiales, consultadas el 2026-10-21:

- README (servidor 3.4.0): https://github.com/plastic-labs/honcho/blob/main/README.md
- Reasoning: https://github.com/plastic-labs/honcho/blob/main/docs/v3/documentation/core-concepts/reasoning.mdx
- Skill de integración: https://github.com/plastic-labs/honcho/blob/main/skills/honcho-memory/SKILL.md
- CHANGELOG (3.4.0, 2026-10-20): https://github.com/plastic-labs/honcho/blob/main/CHANGELOG.md
- Arquitectura: https://github.com/plastic-labs/honcho/blob/main/CLAUDE.md

| Hipótesis | Qué dicen las fuentes | Clasificación |
|---|---|---|
| 1. Persistencia entre sesiones | Mensajes en Postgres; una representación por peer que *"accumulates across all of that peer's sessions"* (SKILL). | Documentada |
| 2. Peers y representaciones evolutivas | Peers humanos o agentes; colecciones por par (observador, observado); representación y peer card. | Documentada |
| 3. Ingesta de mensajes | `add_messages`: *"the only way memory grows"* (SKILL). Para la ingesta de "eventos" y señales de uso no encontré un detalle más allá de mensajes. | Documentada (mensajes) |
| 4. Conclusiones explícitas e inferidas con procedencia | El deriver *"extracts explicit and deductive conclusions"*; las conclusiones exponen `source_ids`, `times_derived` y `level` (CHANGELOG 3.0.11 y 3.2.0). | Documentada |
| 5. Procesamiento asíncrono | Cola por sesión; *"Never block HTTP on LLM work"*; las lecturas pueden ir algo atrasadas. | Documentada |
| 6. Dreaming | Consolidación (*"redundant or contradictory information"*); especialistas de deducción e inducción; árboles de premisas; priorización por *surprisal*. La abducción solo se menciona; no se documenta cómo se resuelven las contradicciones. | Documentada en parte |
| 7. Búsqueda híbrida y contexto para el LLM | BM25/FTS + vector (HNSW) + trigramas; `session.context` con límite de tokens. | Documentada |
| 8. Razonamiento multisesión | Agente dialéctico con herramientas (`search_memory`, `search_messages`, `get_reasoning_chain`, rangos de fecha…) y niveles de razonamiento de `minimal` a `max`. | Documentada |
| 9. Consultas con distinto costo y latencia | Representación y contexto: *"near-instant"*; chat dialéctico: segundos. | Documentada |
| 10. Separación captura / derivación / recuperación / inyección | Separación explícita entre mensajes, deriver, dreamer, representación y chat. | Documentada |
| Borrado y derivados | Borrar una sesión hace *"fail-closed cascades to derived documents whose source_ids intersect"* (3.1.0); borrado asíncrono de workspace (3.0.3); `deletion_generation` es solo preparatorio (3.4.0). | Documentada en parte |
| Calidad / benchmarks | *"defined the Pareto Frontier of Agent Memory"* (README) es una afirmación de marketing sin números en la fuente. Hay herramientas de evaluación reales: LongMemEval, LoCoMo, CoverageBench, MolecularBench (CHANGELOG 2.4.0 y 3.0.3). | Herramientas reales; los resultados no los verifiqué |

**Alcance de la comparación.** Comparo el *resultado para el usuario* y los mecanismos que lo producen. No pretendo replicar nombres ni piezas de Honcho como los peers multi‑agente, el observador/observado ni los niveles de razonamiento.

---

## 5. Matriz detallada Honcho ↔ ELISE

Escala 0–4:

- **0:** ausente.
- **1:** esqueleto o propuesta.
- **2:** parcial.
- **3:** funcional y validado.
- **4:** robusto y observable en producción.

El "Esfuerzo" asume el stack actual (Supabase, Trigger.dev, OpenAI).

| Dimensión | Honcho (evidencia oficial) | ELISE (evidencia) | Nota | Impacto para el usuario | Brecha → recomendación | Prioridad / esfuerzo |
|---|---|---|---|---|---|---|
| **Persistencia** | Mensajes, conclusiones y representación durables (README) | Hechos en `user_preferences` (`memory-service.ts`); episodios en `recall_chunks` | **3** | Recuerda lo pedido y encuentra conversaciones | Almacenar hechos en un array JSON por fila: lectura‑modificación‑escritura sin control de versión (`rememberFact`, `forgetFact`), con riesgo de perder escrituras concurrentes. Llevar los hechos a una tabla propia. | P1 / medio |
| **Captura automática** | El deriver procesa cada mensaje (reasoning.mdx) | Ninguna; solo `memory.remember` dentro del turno | **0** | El usuario repite contexto; ELISE no "aprende" | Agregar un extractor en background sobre `queueRecallIndex`, que produzca *candidatos* `inferred` | **P0** / medio |
| **Modelado del usuario** | Representación y peer card | Ninguno; lista plana de claves | **0–1** | No hay "visión de conjunto" de la persona | Un perfil sintetizado y corto, regenerado desde los hechos (no desde los chats crudos) | P1 / medio |
| **Tipos de memoria** | Explícita, deductiva, inductiva; resúmenes | Hechos, episodios (Recall), Métodos, notas de Space, contextos/entidades, datos vivos por herramientas | **3** | Buena separación conceptual (mejor que Honcho en reglas y datos vivos) | Conservarla. Agregar un tipo `observation` / `pattern` acotado. | P2 / bajo |
| **Explícito vs inferido** | `level` y `source_ids` por conclusión | `confidence: stated\|inferred` y `sources` (`model.ts`), pero el prompt los presenta a todos como *"what the user told you to keep"* (`context.ts:489`) y `memoryForContext` descarta `confidence` | **2** | Una inferencia se usaría como si el usuario la hubiera dicho | Inyectar la confianza y la fecha; las inferencias van como hipótesis | **P0** / bajo |
| **Consolidación** | Dreamer: consolidación, deducción, inducción | Solo deduplicación exacta por clave y valor (`same()`) | **0–1** | Duplicados con claves distintas; no hay patrones | Job periódico de consolidación sobre hechos y candidatos (no sobre todos los chats) | P1 / medio-alto |
| **Temporalidad / correcciones** | Fechas por mensaje; contradicciones en dreaming (sin detalle) | Reemplazo con historial `superseded`; `lastConfirmedAt` sin uso; sin caducidad | **2** | Una corrección explícita gana; lo viejo no caduca nunca | Agregar `valid_from`/`valid_to`, revisión de hechos viejos y mostrar "confirmado el…" | P1 / bajo-medio |
| **Razonamiento** | Agente dialéctico con herramientas y niveles | El modelo del chat puede llamar a `history.search` varias veces; 5 resultados × 2 fragmentos (`RECALL`) | **1–2** | "¿Cómo suelo…?" responde con lo que encuentre, sin síntesis fiable | Herramienta `memory.reflect` con presupuesto que combine hechos, resúmenes y Recall | P1 / medio |
| **Recall híbrido** | BM25 + vector + trigramas, filtros | Vector + FTS (`simple`) con RRF, fechas, Space/contexto, frases exactas (`boostPhrases`), umbral de evidencia | **3** | Encuentra decisiones pasadas con fecha y enlace | Hacer buscables los resúmenes de sesión; FTS por idioma (`spanish`) | P2 / bajo |
| **Contexto para el LLM** | `context` con límite de tokens; representación barata | Todos los hechos activos (≤60), siempre, sin ranking; Recall solo por regex o por herramienta | **2** | Costo fijo por turno y ruido cuando crezcan los hechos | Seleccionar hechos por relevancia y presupuesto, con fecha y confianza | P1 / bajo-medio |
| **Multisuperficie** | Un peer ID estable para todo (SKILL) | Mismo usuario y servidor en web, Desktop y voz legacy. GPT‑Live solo tiene memoria al delegar; las tareas programadas no la leen. | **2** | Lo dicho por voz sirve en texto (vía Recall); el Morning Brief ignora preferencias | Pasar la memoria a `liveInstructions` (resumen corto) y al runner de schedules | P1 / bajo |
| **Privacidad / borrado** | Cascada a derivados por `source_ids` al quitar sesiones | Borrar una conversación: cascada en Recall (trigger) y poda de evidencia. "Olvidar" un hecho desde la UI (por id) deja sus versiones `superseded` guardadas (`forget` solo borra el historial si se pasa la *clave*; la UI pasa el id: `memory.tsx:224`). Olvidar no toca Recall ni resúmenes. | **2** | "Olvidá eso" puede reaparecer desde Recall o un resumen; quedan datos ocultos | Olvido con efecto en derivados: borrar el historial de la clave y opcionalmente suprimirla en Recall | **P0** / bajo-medio |
| **Aislamiento / seguridad** | Workspaces; claves foráneas compuestas | RLS por autor en Recall y en `user_preferences`; RPC `security invoker`; probado con PGlite (Bob no ve a Alice) | **3** | Correcto | Agregar una prueba de aislamiento específica de `memory.facts` | P2 / bajo |
| **Confiabilidad** | Cola, reintentos, reconciliador, logs y eventos | Jobs idempotentes con reintentos, barrido y catch‑up acotado; logs | **3** (Recall) / **n/a** (memoria) | Recall se autorrepara | Usar el mismo patrón para el extractor | — |
| **Evaluación** | LongMemEval, LoCoMo, Coverage y MolecularBench (herramientas) | Pruebas unitarias y de integración funcionales; ninguna de calidad de memoria | **1** | No se puede saber si "recuerda bien" | Dataset sintético en español y harness (ver §10) | **P0** / medio |
| **Costo / escala** | Lecturas baratas; el dialéctico cuesta según el nivel | Embeddings baratos (3‑small); resumen con modelo `background`; memoria sin costo de LLM; inyección fija de ≤60 hechos | **2** | Hoy es barato; crecerá con la extracción | Presupuestos por usuario y día, y extracción por lotes | P2 / bajo |

**Puntaje orientativo.** Promedio simple de 16 filas, usando el punto medio de los rangos: 2,0 sobre 4. No lo uso como "% de Honcho". Las filas que más pesan en la experiencia (captura, modelado, consolidación, razonamiento) están en 0–1. La incertidumbre principal es el comportamiento real en producción, que no observé.

---

## 6. Análisis end-to-end

Para cada recorrido, la evidencia ejecutada son las pruebas que corrí. Sin acceso a producción, ningún recorrido completo con un LLM real quedó probado.

1. **Preferencia explícita hoy → otra sesión → personaliza.** *Implementado, sin validar de punta a punta.*
   - Recorrido: `memory.remember` → `settings-service.remember` (auditoría) → `rememberFact` → `user_preferences`. En la sesión nueva, `memoryForContext` → `context.ts:487`.
   - Probado: la herramienta y el armado del prompt (`recall.test.ts`, `settings-foundations.test.ts`).
   - Falta: que el modelo efectivamente llame a `remember` sin que se lo pidan explícitamente, y que use el hecho.
2. **Patrón repetido en varios días → preferencia implícita.** *Ausente.* Solo se guardan los chats (Recall). No hay detección ni consolidación.
3. **Corrección de una preferencia vieja.** *Implementado, con la lógica probada.*
   - Gana la nueva si es `stated` (`model.ts:80-133`); la vieja queda `superseded` y no se inyecta. Una `inferred` no pisa una `stated` (`:105`).
   - Limitación: depende de que el modelo use la *misma clave*. Con otra clave conviven dos hechos contradictorios.
4. **"¿Qué dijimos hace dos semanas sobre X?"** *Operativo* en búsqueda y ranking (PGlite + unitarias).
   - Recorrido: `recallIntent` → `prefetchRecall` (3 resultados, 2,5 s) y/o `history.search` (fechas en la zona del usuario, umbral `minSimilarity` 0,32) → fragmentos con fecha y enlace.
   - La respuesta con fuentes depende del modelo.
5. **"¿Cómo suelo organizarme?"** *Parcial.*
   - No coincide con `recallIntent`. El modelo puede llamar a `history.search` con una consulta genérica y obtener hasta 5 sesiones × 2 fragmentos, más los hechos inyectados.
   - No hay síntesis transversal dedicada ni evidencia agregada.
6. **Voz → persistencia → recuperación desde texto o Desktop.** *Operativo* en el almacenamiento.
   - Voz legacy y GPT‑Live terminan en `messages` o `interaction_turns`, y Recall indexa ambos (prueba PGlite "voice sessions … are found like typed ones"). Desktop usa el mismo servidor.
   - Parcial en uso: el modelo de GPT‑Live que contesta directamente no ve la memoria.
7. **Olvidar o corregir un recuerdo.** *Parcial.*
   - `memory.forget` por clave borra también el historial. Por id (como hace la UI) solo borra esa fila y quedan versiones `superseded`.
   - Recall y los resúmenes de sesión que mencionan el dato no se tocan. Si el usuario pregunta, el modelo puede "recordarlo" por Recall.
   - No hay caché de contexto que invalidar: la memoria se lee en cada turno.
   - Borrar la conversación sí limpia Recall y la evidencia de los hechos.
8. **Dato estructurado (Calendar/Gmail/Finanzas).** *Operativo como dato vivo.*
   - Las salidas de herramientas no se indexan: Recall filtra roles `user`/`assistant` (`recall-service.ts:70-85`). Las instrucciones prohíben copiar a memoria.
   - Matiz: la *respuesta de ELISE* que resume correos sí queda en Recall como episodio. Es aceptable, pero puede volverse obsoleta y no se marca como tal.

**Pruebas ejecutadas:**

- `tests/unit/core/recall.test.ts`, `settings-foundations.test.ts`, `contexts.test.ts`, `history-links.test.ts`: **86/86 pasaron**.
- `tests/integration/database.test.ts -t recall` (PGlite en memoria): **5/5 pasaron**.

**Pendiente de verificar:**

- Volumen real de hechos y fragmentos en producción.
- Que `recall-sweep` corra en Trigger.dev.
- Tasa de llamadas a `memory.remember` por turno (no hay métrica).
- Latencia real de `perf.time("memory")`.

---

## 7. Brechas ordenadas por impacto

**P0 (bloquean una memoria "que aprende" confiable):**

1. **No hay captura automática.** Falta un extractor de candidatos (`inferred`, revisables) a partir de las conversaciones.
2. **Las inferencias se presentan como dichas por el usuario.** Hay que inyectar la confianza y la fecha, y redactar las inferencias como hipótesis.
3. **El olvido no alcanza a los derivados.** Hay que borrar el historial `superseded` al olvidar y decidir el tratamiento en Recall y los resúmenes.
4. **No hay evaluación de calidad de memoria.** Sin ella, cualquier extractor nuevo es a ciegas.

**P1 (importantes):**

5. Hechos en un único JSON: riesgo de concurrencia, sin índice ni búsqueda. Llevarlos a una tabla dedicada.
6. Sin perfil o representación sintetizada.
7. Sin consolidación ni detección de contradicciones entre claves distintas.
8. Sin razonamiento multisesión dedicado (`memory.reflect`).
9. Sin vigencia ni caducidad; `lastConfirmedAt` no se usa.
10. Memoria ausente en GPT‑Live (respuestas directas) y en tareas programadas.
11. Inyección de todos los hechos sin relevancia ni presupuesto.

**P2 (mejoras):**

12. Hacer buscables los resúmenes de sesión.
13. FTS con diccionario `spanish`.
14. Prueba de aislamiento de `memory.facts`.
15. Presupuestos de costo por usuario.

**P3 (opcionales):**

16. Grafo de entidades y relaciones inferidas.
17. Abducción.
18. Niveles de razonamiento configurables.

---

## 8. Plan incremental recomendado

Camino elegido: **A + B**. Primero fortalecer lo que existe; después una reestructuración incremental de la memoria nativa reutilizando Recall, los jobs y los patrones de Métodos. Honcho queda como benchmark (camino **C**). No hace falta instalarlo.

**Fase 0: evaluar antes de construir (P0-4)**

- **Entregables:**
  - Dataset sintético en español con los 12 casos de §10.
  - Harness que ejecute `prepareTurn` con fakes, o un LLM real en un entorno aislado.
  - Métricas.
- **Reutiliza:** `tests/fixtures/core-fakes.ts`, PGlite (`db-harness.ts`).
- **Criterio de aceptación:** una línea base medida de la versión actual.

**Fase 1: correcciones baratas (P0-2, P0-3, P1-10, P1-11)**

- **Cambios propuestos:**
  - `memoryForContext` devuelve `confidence` y `lastConfirmedAt`; el prompt distingue "dijiste" de "creo que".
  - `forget` por id borra también las versiones `superseded` de la clave.
  - Memoria corta en `liveInstructions` y en el runner de schedules.
  - Tope de hechos inyectados por relevancia léxica simple.
- **Riesgo:** bajo.
- **Criterio de aceptación:** los casos 3, 7, 8 y 12 pasan.

**Fase 2: tabla de memoria canónica (P1-5, P1-9)**

- **Cambio propuesto:** tabla `memory_items` con:
  - `workspace_id`, `user_id`, `kind` (`fact|preference|pattern`), `key`, `value`;
  - `confidence` (`stated|inferred|confirmed`), `status` (`candidate|active|superseded|rejected`);
  - `valid_from`/`valid_to`, `sources` (ids de sesión y turno), `last_confirmed_at`;
  - `embedding` opcional.
- **Seguridad:** RLS por autor, igual que `recall_chunks`.
- **Migración:** desde `user_preferences.memory.facts` (aditiva; la clave vieja queda de solo lectura).
- **Reutiliza:** `core/memory/model.ts` (las reglas no cambian, cambia el almacenamiento).
- **Criterio de aceptación:** paridad de pruebas y sin pérdidas en escrituras concurrentes.

**Fase 3: extractor de candidatos (P0-1)**

- **Cambio propuesto:**
  - Un paso más en la task `recall-index`: después de indexar, si hubo ≥N turnos nuevos del usuario, una llamada LLM `background` produce candidatos con evidencia (ids de turnos).
  - Solo se crean `candidate`/`inferred`; nunca pisan `stated`.
  - Deduplicación por clave y similitud.
- **UX:** Settings › Memoria muestra "ELISE cree que…" con Confirmar / Descartar, y un interruptor "aprender de mis conversaciones" (por defecto apagado o con consentimiento; decisión de Leonardo).
- **Reutiliza:** `queueRecallIndex`, idempotencia, `withUsageScope`, el `SECRET` filter.
- **Riesgos:** falsos recuerdos y privacidad. Se mitigan con umbrales y revisión humana.
- **Criterio de aceptación:** casos 2 y 10 con tasa de falsos recuerdos menor al umbral acordado.

**Fase 4: consolidación y perfil (P1-6, P1-7)**

- **Cambios propuestos:**
  - Job semanal o por umbral: fusiona duplicados, detecta contradicciones (pregunta al usuario, no decide sola) y promueve patrones repetidos en ≥3 sesiones.
  - Genera un perfil breve (≤800 tokens) a partir de los ítems activos.
- **Reutiliza:** el patrón de `recall-sweep` y los resúmenes de sesión.
- **Criterio de aceptación:** casos 4, 6 y 11.

**Fase 5: razonamiento sobre memoria (P1-8)**

- **Cambio propuesto:** herramienta `memory.reflect(question)` que combine:
  - ítems activos;
  - resúmenes de sesión (buscables);
  - `history.search` con varias consultas y un presupuesto de tiempo y tokens.
- **Salida:** una respuesta con citas.
- **Criterio de aceptación:** caso 6 con trazabilidad de fuentes.

---

## 9. Estimaciones cualitativas de esfuerzo, costo y riesgo

*Todo lo de esta sección son hipótesis; nada está medido.*

| Fase | Esfuerzo | Costo de ejecución | Riesgo |
|---|---|---|---|
| 0 | Medio (2–4 días) | Bajo | Bajo |
| 1 | Bajo (1–2 días) | Nulo | Bajo |
| 2 | Medio (3–5 días con la migración de datos) | Nulo | Medio: migración de datos reales |
| 3 | Medio (4–6 días) | Una llamada `background` cada N turnos: centavos por usuario activo y mes con modelos pequeños (verificar con `src/config/pricing.ts` y los logs reales) | Alto: calidad y privacidad |
| 4 | Medio-alto | Una llamada por usuario y semana | Medio |
| 5 | Medio | Por consulta; segundos de latencia | Medio |

---

## 10. Estrategia de validación

**Dataset sintético en español** (personas ficticias, sin datos reales). Los resultados esperados están definidos; ninguno fue observado todavía.

| # | Caso | Resultado esperado |
|---|---|---|
| 1 | "Prefiero reuniones a la tarde" → sesión nueva | Lo usa al proponer horarios |
| 2 | El mismo patrón en 3 sesiones | Un candidato `inferred` revisable, nunca un hecho categórico |
| 3 | "Ya no prefiero la tarde; ahora mañana" | Solo "mañana" activo; "tarde" queda como historial |
| 4 | Preferencia distinta por proyecto o día | Dos ítems con alcance o condición, no fusionados |
| 5 | Decisión antigua | Fecha, quién lo dijo y enlace a la sesión |
| 6 | Pregunta que necesita 3 sesiones | Respuesta con ≥3 citas correctas |
| 7 | Olvidar una preferencia | No reaparece en el prompt, en el perfil ni en los candidatos; Recall según la política decidida |
| 8 | Método explícito contra inferencia | Gana el Método |
| 9 | Aislamiento | Usuario A y workspace A nunca ven datos de B (PGlite, como en Recall) |
| 10 | Mención casual única | Sin candidato |
| 11 | Frescor | Lo reciente y confirmado gana a lo viejo |
| 12 | Voz ↔ texto | Lo dicho por voz aparece en texto y viceversa |

**Métricas:**

- Precisión y recall de extracción contra hechos de referencia (estilo CoverageBench, adaptado).
- Tasa de falsos recuerdos.
- Contradicciones activas por usuario.
- No‑hit honesto de Recall ("no encontré" cuando corresponde).
- Latencia p50/p95 de `memory` y `preload.recall` (ya se miden con `perf.time`).
- Costo por usuario y mes (`usage_events`).
- Hechos obsoletos sin confirmar durante más de 180 días.

**Niveles de prueba:**

- Unitarias de las reglas puras (`core/memory`).
- Integración PGlite para RLS y borrado.
- Harness de turnos con un LLM real en un entorno aislado para los casos 1–12 (ejecución manual o nocturna, no en CI por costo).

**"Calidad comparable":** casos 1–12 al 100 % en lo determinístico, falsos recuerdos por debajo de un umbral acordado (propuesta: ≤5 % de los candidatos *confirmados* resultan incorrectos) y el caso 6 con citas verificables. No propongo comparar números contra LongMemEval sin replicar sus condiciones.

---

## 11. Decisiones que requieren intervención de Leonardo

1. **¿Aprender solo de las conversaciones?** Recomendación: sí, pero en modo "candidatos a confirmar" y con un interruptor en Settings, apagado hasta que el usuario lo active.
2. **¿"Olvidar" también suprime en Recall?** Recomendación: olvidar un hecho borra el hecho y su historial. Para Recall, ofrecer "borrar también las conversaciones donde lo dije" en lugar de editar fragmentos.
3. **Ítems por workspace o por persona.** Recomendación: por persona dentro del workspace, como hoy y como Recall.
4. **Presupuesto mensual de LLM para memoria por usuario.** Recomendación: fijar un tope antes de la Fase 3.

---

## 12. Próximo paso recomendado

Un prompt de implementación con este alcance:

> **Fase 0 + Fase 1.**
> - Dataset sintético y harness de memoria (casos 1, 3, 7, 8, 9, 10, 12).
> - `memoryForContext` con confianza y fecha, y un prompt que trate las inferencias como hipótesis.
> - `forget` por id que borre el historial de la clave.
> - Memoria resumida en `liveInstructions` y en el runner de tareas programadas.
> - Tope de hechos inyectados por relevancia.
>
> Sin tablas nuevas ni extracción automática. Con ADR, pruebas y la puerta de calidad completa.

Con esa línea base medida, decidir la Fase 2–3 (tabla canónica + extractor de candidatos).

---

## Nota posterior (2026-10-21): implementación

Este informe se conserva tal como se escribió: describe el estado *antes* de la implementación. Las brechas P0/P1 se trabajaron el mismo día en [ADR-107](../decisions/ADR-107-native-continuous-memory.md). El detalle de qué cambió, qué quedó pendiente y cómo se validó está en [30-native-memory-implementation.md](30-native-memory-implementation.md).
