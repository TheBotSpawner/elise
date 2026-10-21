# ELISE: memoria nativa continua (implementación v1)

- **Fecha:** 2026-10-21.
- **Decisión:** [ADR-107](../decisions/ADR-107-native-continuous-memory.md).
- **Punto de partida:** [la auditoría](ELISE_Memory_Audit_vs_Honcho_Report.md). La auditoría queda como estaba; al final tiene una nota que apunta a este informe.
- **Alcance:** código implementado en el repo, sin commits. Todos los números de este informe son de pruebas sintéticas o estimaciones. Ninguno es medición de producción.

---

## 1. Veredicto

**Implementado, con la activación pendiente de configuración.** El aprendizaje no corre hasta completar tres pasos en producción:

1. aplicar la migración 062;
2. poner `MEMORY_LEARNING=on`;
3. configurar el precio verificado del modelo de fondo (`AI_MODEL_PRICES`).

Lo que se nota apenas se despliega, aunque nadie active el aprendizaje:

- **Contexto acotado.** Cada turno recibe solo los datos relevantes (en las pruebas, 3 de 60) y no más la lista entera.
- **Origen visible.**
  - Cada dato llega al modelo y a Configuración con su origen: "lo dijiste vos", "lo escribiste acá" o "ELISE lo infirió · seguridad 70%".
  - Una inferencia ya no se presenta como algo que dijiste.
- **Olvido real.** "Olvidar" borra el dato con sus versiones viejas y las líneas del perfil que lo citan, y deja una huella para no volver a aprenderlo. Las conversaciones de origen siguen en el Historial y ELISE lo dice.
- **Más superficies.** La memoria llega también a la voz directa (GPT-Live) y al Morning Brief.
- **Herramientas al alcance.** "Acordate…", "olvidate…" y "¿cómo suelo…?" llegan a las herramientas de memoria sin pasar por `tools.more`.

Con el aprendizaje activado (opt-in por persona en Configuración › Memoria):

- ELISE guarda sola preferencias, proyectos y rutinas de lo que decís, sin pedirte confirmación.
- Lo aprendido aparece en "Aprendido recientemente".
- Una vez por día consolida y arma un perfil corto donde cada línea cita los datos de los que sale.
- Todo esto con un tope duro de gasto mensual.

**¿Es equiparable a Honcho?** En la experiencia que ELISE necesita (aprender, corregir, olvidar, razonar con evidencia, aislar y acotar el costo), la arquitectura cubre las mismas capacidades. No afirmo equivalencia de *calidad*: falta medir con un modelo real la precisión de lo que el modelo propone (ver §10). Honcho tiene más profundidad en un punto: deducción e inducción multinivel con árboles de premisas. ELISE hace una consolidación más acotada y deja el razonamiento al modelo del turno, con evidencia.

---

## 2. Conciliación con la auditoría

| Hallazgo de la auditoría | Cambio | Estado |
|---|---|---|
| Sin captura automática | Extractor opt-in tras cada interacción (`core/memory/learning.ts`, `application/memory-learning.ts`) con compuerta determinística (`core/memory/extraction.ts`) | **Implementado.** Probado con corpus sintético; con modelo real, pendiente |
| Inferencias presentadas como dichas | `memoryLines` etiqueta origen, seguridad y fecha; el prompt nuevo trata la memoria como datos | **Corregido y probado** |
| Inyección de hasta 60 datos | `selectContextFacts`: relevancia por rareza de palabras más preferencias fijas, con tope 12 + 6 | **Corregido y probado** (3 de 60) |
| Olvidar dejaba versiones viejas | `forget` borra todas las filas de la clave, deja huellas HMAC y recorta el perfil | **Corregido y probado** (unitario + RLS) |
| Olvidar no tocaba Recall | Recall no se edita (decisión de producto). `memory.reflect` omite episodios que mencionan lo olvidado; la UI y la herramienta lo explican | **Implementado**, con el límite documentado |
| JSON único, con riesgo de escrituras perdidas | Tabla `memory_facts` con índice único de valor activo y reintento ante carrera | **Implementado y probado** (PGlite) |
| Sin perfil ni consolidación | `core/memory/consolidation.ts` + tarea diaria `memory-consolidate` | **Implementado.** Validado con propuestas fijas; con modelo real, pendiente |
| Sin razonamiento multisesión | Herramienta `memory.reflect` (hechos, inferencias, cambios, perfil, episodios) | **Implementado**; la respuesta final depende del modelo |
| GPT-Live directo sin memoria | `liveInstructions` recibe datos dichos y el perfil | **Implementado y probado** (prompt) |
| Morning Brief sin memoria | `narrateBrief` recibe los datos relevantes | **Implementado** (sin prueba E2E) |
| Sin evaluación | `tests/unit/core/memory-eval.test.ts` (42 casos) + `tests/integration/memory.test.ts` (10) | **Implementado** |
| `memory.*` inalcanzables sin `tools.more` | Nueva señal "memory" en `tool-selection.ts` | **Corregido** |
| Precio del modelo de fondo desconocido | `AI_MODEL_PRICES` configurable; el aprendizaje no corre sin precio | **Implementado** (requiere configuración) |

---

## 3. Arquitectura

```text
Conversación (chat, voz legacy, GPT-Live delegado, Desktop)
   │  messages / interaction_turns (sin cambios)
   ▼
recall-index (Trigger.dev, o en proceso)
   ├─ Universal Recall (como antes)
   └─ learnFromSession (solo con opt-in)
        consentimiento → claim de la interacción → turnos nuevos desde el consentimiento
        → lote (3 turnos tuyos o 10 min de silencio) → ¿precio conocido? → reserva de presupuesto
        → modelo de fondo propone candidatos (JSON estructurado) → ¿sigue activado?
        → compuerta determinística → ¿no olvidado? → remember() → liquidar costo real
memory-sweep (cada 15 min): conversaciones que quedaron en silencio
memory-consolidate (diaria): fusiona duplicados, retira inferencias viejas, arma el perfil citado

memory_facts ── memory_profiles ── memory_suppressions ── memory_spend   (RLS por persona)

Recuperación (sin costo de IA):
   memoryForContext(auth, mensaje) → datos relevantes + perfil
       ├─ chat-service (web, Desktop, voz legacy, delegaciones de GPT-Live)
       ├─ live-voice-service (respuestas directas de GPT-Live: solo lo dicho + perfil)
       └─ morning-brief-service
   memory.reflect → hechos + inferencias + cambios + perfil + episodios de Recall (filtrados)
```

**Por qué nativa y no Honcho:**

- La memoria de ELISE tiene que respetar sus Métodos, sus reglas, los datos vivos de las herramientas, RLS y el workspace, y la retención de Recall. Integrar un servicio externo duplicaría el almacenamiento de conversaciones y sacaría datos privados de Supabase.
- Lo que Honcho resuelve (cola, extracción, consolidación, búsqueda híbrida) ya tenía base en ELISE: Trigger.dev, Recall, pgvector y RLS.

---

## 4. Archivos, migraciones, políticas, jobs, herramientas y configuración

**Migración `supabase/migrations/20261113000062_native_memory.sql` (aditiva):**

- **Tablas:**
  - `memory_facts`: índice único parcial `(workspace_id, user_id, key) where status='active'`.
  - `memory_suppressions`: solo hashes.
  - `memory_profiles`: una fila por persona.
  - `memory_spend`: único `(user_id, kind, job_ref)`.
- **Columnas:** `interaction_sessions.memory_learned_through` y `memory_learning_at`.
- **Funciones:** `memory_reserve_spend` (lock por workspace, topes por persona y workspace, idempotente) y `memory_settle_spend`. Solo las ejecuta el service role.
- **RLS:** cada persona administra sus propios datos, perfil y huellas, y solo *lee* su gasto. `anon` no tiene acceso.
- **Datos:** copia `user_preferences["memory.facts"]` a filas con procedencia honesta y luego borra esa copia.

**Core (sin dependencias externas):**

- `src/core/memory/model.ts`: reescrito con procedencia, certeza, `remember` como cambio puro, `selectContextFacts`, `memoryLines`, `liveProfile` e `INSTRUCTION_LIKE`.
- `src/core/memory/extraction.ts` (nuevo): prompt, esquema, compuerta y huellas de olvido.
- `src/core/memory/learning.ts` (nuevo): orquestación con puertos.
- `src/core/memory/consolidation.ts` (nuevo): propuesta, validación y orquestación.
- `src/core/capabilities/settings.ts`: contrato `memory` / `remember` / `forget` / `reflect` / `stopLearning`.
- `src/core/capabilities/registry.ts`: `reflectMemory` (READ) y `stopLearning` (WRITE).
- `src/core/tools/settings.ts`: `memory.list`, `memory.remember`, `memory.forget`, más las nuevas `memory.reflect` y `memory.stopLearning`.
- `src/core/agents/context.ts`: bloque de memoria nuevo (perfil + datos etiquetados, como datos).
- `src/core/agents/tool-selection.ts`: señal "memory".
- `src/core/voice/live.ts`: memoria en las instrucciones de GPT-Live.
- `src/core/briefs/morning-brief.ts`: memoria en la narración.

**Aplicación e infraestructura:**

- `src/application/memory-service.ts`: reescrito (repositorio por persona, olvido real, consentimiento, gasto, lectura de respaldo antes de la migración).
- `src/application/memory-learning.ts` (nuevo): aprendizaje, sweep, consolidación y presupuesto.
- `src/application/memory-reflect.ts` (nuevo).
- `src/application/settings-service.ts`: auditoría sin contenido.
- `chat-service.ts`, `live-voice-service.ts`, `morning-brief-service.ts`, `recall-service.ts`: conexión de la memoria.
- `src/infrastructure/observability/usage.ts`: `modelPrice`, `tokenCost` y `AI_MODEL_PRICES`.
- `src/infrastructure/supabase/database.types.ts`: tablas y funciones nuevas.
- `src/config/server-env.ts`: `MEMORY_LEARNING`, `MEMORY_USER_MONTHLY_USD`, `MEMORY_WORKSPACE_MONTHLY_USD`, `MEMORY_FINGERPRINT_KEY`, `AI_MODEL_PRICES`.
- `.env.example`: las mismas variables, documentadas.

**Jobs:**

- `src/trigger/recall.ts`: `recall-index` aprende después de indexar.
- `src/trigger/memory.ts` (nuevo): `memory-sweep` (`*/15 * * * *`) y `memory-consolidate` (`30 6 * * *` UTC).

**Interfaz:**

- `src/features/settings/memory.tsx`:
  - interruptor "Aprender de mis conversaciones" con la explicación de qué lee, cuándo, qué no guarda, el control y el costo;
  - estado y gasto del mes;
  - "Cómo te ve ELISE" y "Aprendido recientemente";
  - etiquetas de origen, seguridad y fecha, y "Ver conversación";
  - olvidar y borrar todo con el diálogo propio de ELISE (ya no `window.confirm`).
- `actions.ts`: `setLearningAction`.
- La carga de la página de Memoria.
- i18n en español e inglés.

**Pruebas:**

- `tests/unit/core/memory-eval.test.ts` (nuevo).
- `tests/integration/memory.test.ts` (nuevo).
- `settings-foundations`, `recall` y `settings-hub` actualizados.

**Documentación:** ADR-107, este informe, la nota al final de la auditoría y el índice de `docs/README.md`.

---

## 5. Contrato de privacidad

- **Consentimiento.**
  - El aprendizaje está apagado por defecto para todos, cuentas nuevas y existentes.
  - Activarlo guarda `since = ahora`; nunca se lee nada anterior. No hay backfill.
  - Apagarlo, desde Configuración o con "dejá de aprender de nuestras conversaciones", corta los trabajos en curso: cada ejecución vuelve a verificar el consentimiento antes de guardar. Lo ya aprendido queda.
  - "Recordá X" funciona siempre, sin necesidad de activar el aprendizaje.
- **Qué no se aprende nunca solo:**
  - lo que dice ELISE, citas, hipotéticos, texto pegado y cosas temporales;
  - secretos;
  - salud, sexualidad, religión, política, etnia, biometría, situación legal o migratoria y finanzas;
  - texto con forma de instrucción.

  Si la persona lo pide explícitamente, se puede guardar, igual que antes.
- **Olvidar.**
  - Borra el valor actual, todas sus versiones anteriores y las líneas del perfil que lo citan.
  - Deja huellas HMAC (clave del servidor, salteadas por persona) de la clave, el valor y las raíces de palabras. No guarda el texto: alcanza para no volver a aprenderlo, no para leerlo.
  - `memory.reflect` omite los episodios de Recall que lo mencionan y avisa cuántos omitió.
  - **No** borra las conversaciones donde se dijo, ni lo que vive en Gmail u otras fuentes, ni backups de la base. La UI y la herramienta lo dicen, y ofrecen borrar las conversaciones desde el Historial. Nunca se borran implícitamente.
  - Si la persona vuelve a pedir que lo recuerde, explícitamente, el bloqueo se levanta.
- **Límites conocidos de las huellas.**
  - Una reformulación con otras palabras, o en otro idioma, no se detecta.
  - Si se cambia `MEMORY_FINGERPRINT_KEY` (o `ELISE_ENCRYPTION_KEY` sin la anterior), las huellas viejas dejan de coincidir.
- **Auditoría.** `memory.remembered` guarda categoría y procedencia; `memory.forgotten` guarda la cantidad; `memory.learning_on/off` y `memory.learning_stopped` también quedan registrados. Ninguno incluye la clave ni el valor. Los logs de aprendizaje registran estados y conteos, nunca contenido.
- **Aislamiento.**
  - RLS por persona y workspace, y el service role filtra siempre por las dos.
  - Las huellas usan una sal por persona.
  - La memoria no se federa entre workspaces.
- **Inyección de instrucciones.**
  - Los valores con forma de instrucción se rechazan en `remember` y en la compuerta.
  - El prompt declara la memoria como datos.
  - El perfil filtra lo sensible y las instrucciones.
- **Retención.** Recall y las conversaciones mantienen su semántica actual. Borrar una conversación poda la evidencia de los datos: una inferencia que se queda sin evidencia se olvida.

---

## 6. Costos

**Precios.**

- El modelo de fondo por defecto es `gpt-6-luna` (`src/infrastructure/ai/profiles.ts`), y no tiene precio en `src/config/pricing.ts`.
- Fuentes de terceros (no la página de OpenAI) lo listan en **USD 0,10 / 0,50 por millón de tokens** de entrada y salida, con la entrada cacheada a 0,01:
  - [eesel.ai](https://www.eesel.ai/blog/gpt-6-luna-pricing)
  - [anotherwrapper.com](https://anotherwrapper.com/tools/llm-pricing/gpt-6-luna)
- **No lo dejé fijo en el código.** Hay que verificarlo y cargarlo en `AI_MODEL_PRICES`. Sin precio, el aprendizaje no corre.

**Estimaciones por ejecución** (fórmula del código: caracteres/3 de entrada, salida presupuestada de 900 tokens para extraer y 1.800 para consolidar; no son mediciones):

| Trabajo | Entrada típica | Con Luna (0,10/0,50, a verificar) | Con gpt-5-mini (0,25/2, tabla del repo) |
|---|---|---|---|
| Extracción (unos 6 turnos) | unos 1.450 tokens | ≈ USD 0,0006 | ≈ USD 0,0022 |
| Consolidación (unos 100 datos) | unos 4.000 tokens | ≈ USD 0,0013 | ≈ USD 0,0046 |

**Uso con el tope por defecto de USD 0,50 por persona y mes:**

- Con Luna alcanza para unas 800 ejecuciones de extracción. Con un uso intenso, unas 10 conversaciones por día dan unas 300 al mes, más 30 consolidaciones (≈ USD 0,04): estaría lejos del tope.
- Con gpt-5-mini serían unas 225 ejecuciones: el tope se podría alcanzar en un mes intenso, y ahí el aprendizaje se pausa hasta el mes siguiente.

**Mecanismo.**

- Cada ejecución reserva antes de llamar al modelo y liquida con el uso real que informa el proveedor.
- Si el proveedor falla, cuenta la estimación.
- Si una ejecución cuesta más de lo estimado, puede pasarse del tope por esa única llamada.
- Los topes son por mes calendario en UTC.
- `memory_spend` es solo de la memoria; `usage_events` sigue registrando el detalle técnico como antes.
- **Lectura sin costo:** usar la memoria en un turno no llama a ningún modelo; `memory.reflect` usa la búsqueda de Recall (un embedding).

**Servicios externos:** solo OpenAI, el mismo proveedor y la misma clave de siempre. No hay credenciales nuevas.

---

## 7. Resultados

| Verificación | Resultado |
|---|---|
| `npm run format:check` | OK en todo lo modificado. Un aviso en `desktop/voice_exports/*.json` (tu exportación de audio; no es código) |
| `npm run lint` | OK |
| `npm run typecheck` / `typecheck:desktop` | OK |
| `npm run test:run` | **2522 pasan, 2 omitidas, 0 fallan** (190 archivos). En una corrida anterior fallaba una prueba por el orden de ejecución tras mi cambio en `usage.ts`: la corregí. `finance-multi-book` (integración) a veces falla bajo carga y pasa sola, como ya pasaba antes |
| Evaluación de memoria (`memory-eval`, 42 casos) | 42/42. La compuerta: 0 datos falsos en el corpus (2 válidos aceptados, 14 trampas rechazadas). Relevancia: exactamente 3 de 60 |
| Base de datos (`tests/integration/memory.test.ts`, PGlite) | 10/10: migración, RLS, topes, idempotencia, valor único |
| Pruebas previas de memoria y Recall (86 + 5 de la auditoría) | Pasan, adaptadas al contrato nuevo |
| `npm run build` | OK |
| Desktop: `package:desktop` + smoke | Empaqueta. Smoke: arranca sin red, bridge tipado, segunda instancia, recuperación del renderer y arranque en frío por enlace, todo ✓ |

**Medido (sintético, en esta máquina):**

- Contexto de memoria, de ≈ 1.030 tokens (60 datos) a ≈ 60 tokens (pregunta sobre reuniones), ≈ 45 (pregunta sin relación) y ≈ 345 (pregunta amplia).
- Seleccionar los datos tarda 0,16 ms.
- **No medido:** latencia ni costo en producción, ni la precisión de lo que propone el modelo real.

---

## 8. Disponibilidad por superficie

| Superficie | Leer memoria | Aprender | Olvidar / corregir | Estado |
|---|---|---|---|---|
| Chat web | Datos relevantes + perfil | Sí, tras la conversación (opt-in) | Herramientas y Configuración | Implementado |
| ELISE Desktop | Igual que la web (mismo servidor; acciones por RPC) | Sí | Igual | Implementado. Probado: empaquetado y smoke |
| Voz legacy | Igual que el chat | Sí (los turnos de voz se indexan y aprenden igual) | Por voz, con las herramientas | Implementado |
| GPT-Live: respuesta directa | Lo que dijiste + perfil, en las instrucciones de la sesión (se leen al abrirla, no por paquete de audio) | Sí (sus turnos se guardan) | Delegando | Implementado. La latencia agregada al abrir la sesión es una lectura de base de datos; sin medir |
| GPT-Live: delegado | Igual que el chat | Sí | Sí | Implementado |
| Morning Brief | Datos relevantes en la narración | No (no es una conversación) | — | Implementado, sin prueba E2E |
| Otras tareas programadas | Los resultados programados por chat pasan por el motor del chat | — | — | Igual que el chat |
| Mobile / Home | Mismo contrato `memoryForContext` | — | — | No implementado (no existe la superficie) |

---

## 9. Despliegue

1. **Supabase (producción).** Aplicar la migración 062: `npx supabase db push`, o pegar el SQL en el editor de Supabase. **Antes del deploy de la web, o enseguida después.**
   - Hasta aplicarla, la web desplegada muestra la memoria vieja en solo lectura ("La memoria se está actualizando…") y guardar o olvidar devuelve "probá más tarde". Nada se rompe.
   - Ojo: la migración borra la copia JSON después de copiarla. Si querés un respaldo, exportá antes `select * from user_preferences where key = 'memory.facts'`.
2. **Vercel (web), variables de entorno:**
   - `MEMORY_LEARNING=on`, para que aparezca la opción de aprender. Sin ella, todo lo demás funciona igual.
   - `AI_MODEL_PRICES={"gpt-6-luna":{"input":0.1,"cached":0.01,"output":0.5}}`, **después de verificar** los precios en la página de OpenAI.
   - Opcionales: `MEMORY_USER_MONTHLY_USD` (por defecto 0.5), `MEMORY_WORKSPACE_MONTHLY_USD`, `MEMORY_FINGERPRINT_KEY` (por defecto se deriva de `ELISE_ENCRYPTION_KEY`).
   - Redeploy (el push a `main` ya lo hace).
3. **Trigger.dev:**
   - Las mismas variables en el entorno de producción.
   - `npx trigger.dev@latest deploy` para registrar `memory-sweep` y `memory-consolidate`, y la versión nueva de `recall-index`.
4. **Desktop:** no necesita release por la memoria (todo es servidor). El cambio de "volumen" y el de la línea de tiempo sí son de Desktop: ver el comando al final del mensaje.

---

## 10. Validación manual (guiones)

Usá una cuenta de prueba con `MEMORY_LEARNING=on` y el precio configurado. Antes, activá Configuración › Memoria › "Aprender de mis conversaciones".

1. **Recordar explícito:**
   - "Acordate que prefiero las reuniones a la tarde."
   - Abrí una conversación nueva: "Armame una reunión con Ana esta semana." Debería proponer la tarde.
2. **Aprender solo:**
   - En una conversación: "Esta semana arranqué a entrenar para el medio maratón de marzo." Después: "Ah, y los domingos hago el fondo largo, siempre."
   - Esperá unos 10 minutos sin escribir.
   - En Configuración › Memoria deberías ver "Aprendido recientemente" con el objetivo o la rutina, con "Lo dijiste vos · aprendido de tus conversaciones".
3. **Lo que no debe aprender:**
   - "Si fuera rico me mudaría a Bariloche." / "Mi jefe dice que «hay que llegar temprano»." / "Tengo turno con el cardiólogo el martes."
   - Nada de eso debe aparecer.
4. **Corregir:** "Eso ya no es así: ahora prefiero las reuniones a la mañana." En Configuración aparece el valor nuevo; ELISE usa el nuevo.
5. **Resumir con evidencia:** "¿Qué sabés de cómo entreno?" Debería separar "me dijiste…", "parece que…" y "no tengo evidencia de…", con fechas.
6. **Olvidar:**
   - "Olvidate de lo del medio maratón." Debería decir que lo olvidó y que la conversación sigue en el Historial.
   - Volvé a mencionarlo de pasada en otra conversación: no tiene que reaparecer como dato aprendido.
7. **Dejar de aprender:** "Dejá de aprender de nuestras conversaciones." En Configuración, el interruptor apagado; lo guardado sigue.
8. **Voz directa:** con GPT-Live, "¿Cómo me llamo?" o "¿qué te dije de las reuniones?" Debería responder sin delegar si el dato está entre lo que dijiste.
9. **Morning Brief:** con "prefiero respuestas cortas" guardado, la narración debería ser breve.
10. **Tope:** con `MEMORY_USER_MONTHLY_USD=0.001` en staging, después de una o dos ejecuciones los logs muestran `memory.learned` con `status: over_budget` y no hay más llamadas.

---

## 11. Riesgos y pendientes (por impacto)

1. **Calidad real de lo que propone el modelo:** sin medir. Correr los guiones del §10 y, si hace falta, ajustar `EXTRACTION_INSTRUCTIONS` (cambiar también `EXTRACTOR_VERSION`).
2. **Precio sin verificar:** sin `AI_MODEL_PRICES` correcto el aprendizaje no corre (falla cerrado). Con un precio incorrecto, el tope no protege.
3. **Relevancia léxica:** "¿a qué hora me conviene correr?" no encuentra "entrena los domingos" si no comparten raíces. Mejora futura: embeddings de los datos (la columna y pgvector ya existen; sería otra migración).
4. **Huellas:** las reformulaciones con otras palabras no se detectan (documentado).
5. **Recall sin tocar al olvidar:** `history.search` puede seguir mostrando la conversación textual. Es honesto (se avisa), pero es una decisión de producto.
6. **Consolidación diaria fija (06:30 UTC):** recorre hasta 200 personas por día, sin priorizar.
7. **Perfil solo con aprendizaje activado:** quien solo usa "acordate…" no tiene perfil (decisión: no hay trabajo de fondo sin opt-in).
8. **Primer deploy:** si la migración se demora, la memoria queda en solo lectura (degradación prevista).
