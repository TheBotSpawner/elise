# ELISE — Background Execution

**Document:** `14-background-execution.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE ejecuta trabajo duradero, programado o desacoplado de la interacción web utilizando un runtime de background, con retries, idempotencia, estado persistente, realtime, approvals y aislamiento respecto de la lógica de negocio.

---

# 1. Vision

ELISE debe poder seguir trabajando aunque:

- el usuario cierre la pestaña;
- una operación tarde varios minutos;
- haya que esperar una aprobación;
- una API externa falle temporalmente;
- una tarea deba ejecutarse horas o días después;
- un proceso implique muchos documentos o registros.

La ejecución en background debe sentirse integrada al producto, no como un sistema separado.

---

# 2. Core Decision

El runtime inicial de background será:

```text
Trigger.dev
```

Se utilizará para:

- Schedules;
- Morning Brief;
- Knowledge ingestion;
- sync;
- document processing;
- long-running analysis;
- retries;
- waits;
- approvals;
- future event/condition triggers.

Trigger.dev es infraestructura.

No es:

- el cerebro de ELISE;
- el lugar principal para lógica de negocio;
- una dependencia conceptual del dominio.

---

# 3. Architectural Principle

La lógica de negocio debe vivir en application services y Core.

Correcto:

```text
Trigger.dev Task
      ↓
Application Service
      ↓
ELISE Core
      ↓
Provider Adapters
```

Incorrecto:

```text
Trigger.dev Task
      ↓
all business logic embedded directly in task
```

Esto permite reemplazar el runtime más adelante.

---

# 4. Background Runtime Abstraction

ELISE debe definir una interfaz conceptual independiente.

Ejemplo:

```ts
interface BackgroundRuntime {
  enqueue(...)
  schedule(...)
  cancel(...)
  getStatus(...)
  waitFor(...)
}
```

Implementación inicial:

```text
TriggerDevRuntime
```

Futuras alternativas posibles:

```text
Inngest
Temporal
Custom Queue
Cloud Tasks
```

No se implementarán múltiples runtimes en MVP.

---

# 5. When to Use Background Execution

Usar background cuando una operación:

- puede tardar;
- necesita retries;
- necesita schedule;
- debe sobrevivir al cierre del navegador;
- procesa muchos elementos;
- espera input externo;
- necesita pause/resume;
- requiere durability.

Ejemplos:

```text
Morning Brief
Drive indexing
Notion sync
large import
document parsing
weekly review
scheduled report
meeting prep generated ahead of time
```

---

# 6. When Not to Use Background Execution

No enviar a background tareas simples que pueden resolverse directamente.

Ejemplos:

```text
"¿Qué tengo mañana?"
"Creá una tarea."
"Buscá este email."
"Mostrame mis gastos de hoy."
```

Regla:

> **Use background for durability, not as the default for every request.**

---

# 7. Job Model

Conceptualmente:

```text
BackgroundJob

id
workspace_id
user_id
type
status
created_at
started_at
completed_at
progress
result_reference
error_code
error_message
runtime_id
metadata
```

Estados:

```text
Queued
Running
Waiting
Waiting for Approval
Completed
Completed with Warning
Failed
Cancelled
```

---

# 8. Run Identity

Cada ejecución durable debe tener un ID propio.

Ejemplo:

```text
run_id
schedule_run_id
knowledge_sync_run_id
import_run_id
```

Esto permite:

- tracing;
- idempotency;
- retries;
- realtime;
- debugging;
- audit.

---

# 9. Durable Execution

Una operación durable debe poder sobrevivir a:

- process restarts;
- temporary network issues;
- provider latency;
- deployment;
- browser close.

El runtime debe persistir suficiente estado para continuar o recuperarse.

---

# 10. Idempotency

Toda operación que pueda repetirse debe contemplar idempotencia.

Ejemplos:

```text
create event
send email
create task
store transaction
index document
sync item
```

Posible estrategia:

```text
idempotency key
=
run_id + operation + target
```

La implementación concreta depende del provider.

---

# 11. Duplicate Prevention

Retries nunca deberían producir silenciosamente:

- dos emails;
- dos eventos;
- dos transacciones;
- dos tareas;
- dos copias de un documento.

Si el provider no soporta idempotency nativa, ELISE debe implementar deduplicación cuando sea posible.

---

# 12. Retry Strategy

Errores transitorios pueden reintentarse.

Ejemplos:

```text
timeout
rate limit
temporary provider error
network failure
```

Errores no reintentables:

```text
permission denied
invalid input
revoked connection
not found
hard validation failure
```

---

# 13. Retry Backoff

Los retries deben usar backoff apropiado.

Ejemplo conceptual:

```text
attempt 1
↓
short delay

attempt 2
↓
longer delay

attempt 3
↓
longer delay
```

No hacer loops agresivos.

---

# 14. Retry Limits

Cada job debe tener límites.

Ejemplos:

```text
max attempts
max runtime
retry window
```

Después del límite:

```text
Failed
```

y se genera un error accionable.

---

# 15. Partial Failure

Una ejecución puede completar parcialmente.

Ejemplo Morning Brief:

```text
Calendar ✓
Tasks ✓
News ✓
Email ✕
```

Resultado:

```text
Completed with Warning
```

La UI debe explicar qué faltó.

---

# 16. Realtime Progress

Background execution debe emitir progreso cuando sea útil.

Ejemplo:

```text
Indexing Google Drive

142 / 310 files
46%
```

o:

```text
Preparing Morning Brief

✓ Calendar
✓ Tasks
● Email
○ News
```

---

# 17. Realtime Channels

Posibles mecanismos:

```text
Trigger.dev realtime/status
Supabase Realtime
Next.js streaming
```

No todos los jobs deben usar el mismo mecanismo.

---

# 18. Persisted Status

Realtime mejora UX.

Persistencia garantiza consistencia.

El estado principal del job debe poder recuperarse desde DB aunque el cliente se desconecte.

---

# 19. Notifications

Cuando un background job finaliza puede crear una Notification.

Ejemplo:

```text
Morning Brief ready
```

o:

```text
Google Drive sync failed
```

No todo job debe notificar.

La política depende de:

- tipo;
- configuración;
- severidad;
- user preferences.

---

# 20. Background Results

Resultados útiles deben persistirse.

Ejemplos:

```text
Morning Brief
Weekly Finance Review
Client Analysis
Meeting Prep
Study Review
```

Modelo conceptual:

```text
Result

id
workspace_id
job_id
type
title
content
artifact_reference
created_at
read_at
metadata
```

---

# 21. Result Consumption

El resultado puede mostrarse como:

```text
Ready
[ Read ]
[ Listen ]
```

No debe abrirse automáticamente salvo configuración explícita.

---

# 22. Schedules

Schedules utilizan background runtime.

Flujo:

```text
Schedule
 ↓
Trigger.dev
 ↓
ScheduleRun
 ↓
Application Service
 ↓
Capabilities
 ↓
Result
 ↓
Notification
```

---

# 23. One-Time Jobs

Ejemplo:

```text
Tomorrow 18:00
Remind me to call Juan
```

Una sola ejecución.

---

# 24. Recurring Jobs

Ejemplo:

```text
Weekdays 07:30
Morning Brief
```

Cada ejecución debe tener su propio run.

---

# 25. Event-Driven Jobs — Future

Futuro:

```text
new email
calendar change
knowledge update
webhook
```

Evento:

```text
event
→ background job
```

---

# 26. Condition Watches — Future

Ejemplo:

```text
spending > threshold
habit target at risk
client hasn't replied
weather condition
```

Puede implementarse mediante:

- scheduled checks;
- provider events;
- webhooks;
- hybrid evaluation.

---

# 27. Knowledge Ingestion

Upload:

```text
Store file
 ↓
enqueue ingestion
 ↓
extract
 ↓
normalize
 ↓
version
 ↓
chunk
 ↓
embed
 ↓
index
 ↓
ready
```

Cada etapa puede reportar progreso.

---

# 28. Knowledge Sync

External source sync:

```text
discover changes
 ↓
new / modified / deleted
 ↓
process only changed items
 ↓
update index
 ↓
persist sync state
```

Debe ser incremental.

---

# 29. Large Imports

CSV/Sheets imports pueden ejecutarse en background.

Flow:

```text
preview
 ↓
user confirms
 ↓
enqueue import
 ↓
validate rows
 ↓
write batch
 ↓
report success/errors
```

---

# 30. Import Progress

Ejemplo:

```text
Importing Finance

238 / 248 rows

7 need review
3 invalid
```

---

# 31. Long AI Analysis

Una tarea de análisis grande puede handoff a background.

Ejemplo:

> “Analizá todos los documentos de este cliente.”

Flow:

```text
interactive request
 ↓
scope resolution
 ↓
enqueue background analysis
 ↓
return status
 ↓
process
 ↓
persist result
 ↓
notify
```

---

# 32. Background AI Calls

AI calls en background deben usar la misma abstracción de AI Provider.

No importar OpenAI directamente en cada Trigger task.

Correcto:

```text
Background job
→ AIService
→ OpenAIProvider
```

---

# 33. Rules at Execution Time

Los jobs deben evaluar Rules al momento de ejecutar.

No asumir que las reglas vigentes al crear el job siguen siendo válidas.

Ejemplo:

```text
Schedule created Monday

Rule changed Wednesday

Run Friday
→ use Wednesday rule
```

---

# 34. Provider Resolution at Execution Time

Cuando corresponda, resolver providers live.

Ejemplo:

```text
Morning Brief
→ Email capability
```

No hardcodear una cuenta para siempre si el Schedule no lo especificó.

---

# 35. Explicit Binding

Si el usuario pidió:

```text
"Use only Firbot Gmail"
```

entonces el job conserva ese binding específico.

---

# 36. Permission Validation

Antes de cada write:

```text
check current permission
check current connection state
check current approval policy
```

Un Schedule no es un bypass permanente.

---

# 37. Approval Wait

Background workflows pueden pausar.

Ejemplo:

```text
Create draft
 ↓
send requires approval
 ↓
Waiting for Approval
 ↓
user approves
 ↓
resume
```

---

# 38. Approval Expiry

Si una aprobación pierde validez temporal:

```text
revalidate before resume
```

Ejemplo:

```text
meeting reminder
```

no debería enviarse horas después sin verificar utilidad.

---

# 39. Durable Waits

El runtime debe soportar esperas largas sin mantener procesos activos innecesariamente.

Ejemplos:

```text
wait until schedule time
wait for approval
wait for external event
```

---

# 40. Cancellation

El usuario debe poder cancelar jobs cuando sea seguro.

Ejemplo:

```text
Indexing
[ Cancel ]
```

El sistema debe:

```text
request cancellation
stop future steps
mark state
clean partial state when needed
```

---

# 41. Cancellation Is Cooperative

Algunas operaciones externas no pueden detenerse una vez enviadas.

Ejemplo:

```text
email already sent
```

Cancel no revierte mágicamente.

UI debe distinguir:

```text
cancel pending work
```

de:

```text
undo completed external action
```

---

# 42. Timeout

Cada job debe tener timeout razonable.

Un proceso que queda colgado no puede durar indefinidamente.

Timeout genera:

```text
FAILED_TIMEOUT
```

o retry cuando corresponda.

---

# 43. Concurrency

ELISE debe controlar concurrencia.

Casos:

```text
many users
many imports
many sync jobs
many scheduled briefs
```

No todos deben correr sin límites.

---

# 44. Concurrency Keys

Ejemplo:

```text
one active sync per source
```

o:

```text
one Morning Brief run per schedule/window
```

Esto evita colisiones.

---

# 45. Per-User Fairness

Futuro scaling:

evitar que un usuario con una importación gigante bloquee ejecución de otros.

Puede requerir:

```text
queues
concurrency groups
quotas
```

No sobreconstruir en MVP.

---

# 46. Overlapping Schedule Runs

Políticas posibles:

```text
Skip
Queue
Cancel Previous
Allow Parallel
```

Morning Brief:

```text
Skip duplicate run
```

Large analysis:

```text
Queue or reject duplicate
```

---

# 47. Missed Schedules

Si un run programado no pudo ejecutarse:

posibles políticas:

```text
Run late
Skip
Ask
```

Ejemplo:

```text
Morning Brief
→ skip if too late
```

Ejemplo:

```text
Weekly Finance Review
→ run late
```

La política pertenece al tipo de Schedule.

---

# 48. Timezones

Todos los schedules deben resolverse en timezone del usuario/workspace.

No utilizar UTC como experiencia de producto.

Internamente se puede almacenar UTC + timezone canonical.

---

# 49. Daylight Saving

El runtime debe usar reglas de timezone reales.

Ejemplo:

```text
07:30 local
```

debe seguir siendo 07:30 local después de cambios DST.

---

# 50. Job Inputs

Los jobs deben recibir IDs y configuración mínima.

Preferir:

```text
workspace_id
schedule_id
run_id
```

y cargar datos actuales desde services.

Evitar pasar blobs gigantes con datos sensibles directamente al runtime.

---

# 51. Job Outputs

Outputs deben ser:

- references;
- structured result;
- status;
- errors.

No depender solo de logs.

---

# 52. Secrets

Background runtime puede necesitar acceso a secrets server-side.

Nunca incluir secrets:

```text
in job names
in logs
in metadata
in user-visible status
```

---

# 53. Provider Credentials

La task debe pedir credenciales a la infraestructura de Connections.

No guardar tokens duplicados dentro del Schedule.

---

# 54. Workspace Isolation

Todo job debe llevar:

```text
workspace_id
```

y validar ownership antes de leer o escribir.

---

# 55. User Deletion / Disconnect

Si una conexión se revoca:

```text
future jobs depending on it
→ fail safely / pause / needs attention
```

Si un Schedule depende completamente de esa conexión:

```text
Needs Attention
```

---

# 56. Deployment Safety

Deployments no deben provocar:

- duplicate runs;
- lost schedules;
- duplicate sends;
- corrupted state.

Durable runtime e idempotency deben proteger estos casos.

---

# 57. Versioned Job Logic

Cuando una task cambia de código, jobs antiguos pueden seguir activos.

Debe evitarse breaking changes sin migración.

Posibles estrategias:

```text
versioned payload
backward-compatible service
migration
```

---

# 58. Job Types

Tipos iniciales:

```text
schedule.run
knowledge.ingest
knowledge.sync
knowledge.reindex
import.execute
analysis.long
notification.deliver
```

---

# 59. Typed Jobs

Cada job debe tener input schema validado.

Ejemplo:

```ts
KnowledgeSyncJobInput {
  workspaceId
  sourceId
  runId
}
```

No depender de objetos libres.

---

# 60. Error Taxonomy

Errores útiles:

```text
AUTH_EXPIRED
PERMISSION_DENIED
RATE_LIMITED
TIMEOUT
PROVIDER_UNAVAILABLE
VALIDATION_ERROR
NOT_FOUND
CANCELLED
UNKNOWN
```

---

# 61. User-Facing Errors

Malo:

```text
502 upstream timeout
```

Mejor:

```text
Google Drive did not respond. ELISE will retry automatically.
```

---

# 62. Actionable Failure

Cuando el usuario debe intervenir:

```text
Gmail needs to be reconnected.

[ Reconnect ]
```

No seguir reintentando indefinidamente.

---

# 63. Logs

Cada run debe registrar:

```text
started
step changes
provider calls
retries
approvals
completion
failure
```

Sin secretos.

---

# 64. Trace IDs

Propagar:

```text
run_id
request_id
workspace_id
```

entre servicios.

Esto permite reconstruir una ejecución.

---

# 65. Metrics

Medir:

```text
success rate
failure rate
retry rate
average runtime
queue delay
provider latency
jobs waiting approval
jobs cancelled
```

---

# 66. Cost Tracking

Background work puede ser costoso.

Registrar:

```text
AI usage
embedding usage
provider calls
duration
documents processed
```

Esto ayuda a pricing futuro.

---

# 67. Backpressure

Si un provider está rate-limited:

```text
slow queue
retry later
```

No lanzar más requests agresivamente.

---

# 68. Provider-Specific Limits

Cada adapter puede declarar:

```text
rate limits
recommended concurrency
batch size
retry hints
```

Background runtime utiliza estos hints.

---

# 69. Batch Processing

Procesos grandes deberían usar batches.

Ejemplo:

```text
1000 Drive files
```

No procesar todo en una única operación monolítica.

Patrón:

```text
discover
→ batch
→ process
→ checkpoint
```

---

# 70. Checkpoints

Long jobs deben persistir progreso.

Ejemplo:

```text
processed 600 / 1000
```

Si falla:

```text
resume from checkpoint
```

cuando sea seguro.

---

# 71. Fan-Out / Fan-In

Casos grandes pueden usar:

```text
one coordinator
→ parallel child tasks
→ aggregate results
```

Ejemplo:

```text
analyze 20 documents
```

No usar esta complejidad para tareas simples.

---

# 72. Parallelism

Aprovechar parallelism cuando los pasos son independientes.

Ejemplo Morning Brief:

```text
Calendar
Email
Tasks
News
```

pueden fetcharse en paralelo.

---

# 73. Ordered Workflows

Cuando existe dependencia:

```text
discover file
→ fetch
→ parse
→ embed
```

mantener orden.

---

# 74. Transaction Boundaries

DB writes relacionados deben usar transacciones cuando corresponda.

Ejemplo:

```text
create import batch
+
rows
+
status
```

No dejar estados parciales incoherentes.

---

# 75. Compensation

Para operaciones multi-step con side effects externos, algunas fallas no pueden revertirse.

Ejemplo:

```text
email sent
then DB write fails
```

El sistema debe soportar reconciliación y no simplemente retry de send.

---

# 76. Reconciliation

Background jobs futuros pueden revisar inconsistencias.

Ejemplo:

```text
provider says event exists
DB says pending
```

Reconciliation actualiza estado sin duplicar.

---

# 77. Background UX

El usuario no necesita conocer términos como:

```text
queue
worker
retry policy
```

Debe ver:

```text
Processing
Waiting for approval
Ready
Needs attention
```

---

# 78. Home Integration

La Home puede mostrar discretamente:

```text
2 results ready
1 process running
```

Sin convertir Home en monitor de jobs.

---

# 79. Schedules Integration

Schedules muestra:

```text
Last run
Next run
Status
```

History contiene detalle.

---

# 80. Knowledge Integration

Knowledge muestra:

```text
Indexing...
Up to date
Needs attention
```

---

# 81. Approval Integration

Approvals muestra jobs pausados.

Ejemplo:

```text
Weekly Client Follow-up
Waiting for approval
```

---

# 82. Browser Close

Cerrar la aplicación nunca debe cancelar automáticamente un background job.

El resultado se recupera al volver.

---

# 83. Multi-Device

El usuario puede iniciar una operación en desktop y verla terminar en mobile.

Estado vive en backend, no en componente local.

---

# 84. Offline Client

Si el browser pierde conexión:

```text
job continues
```

Cuando reconecta:

```text
fetch current persisted state
```

---

# 85. Testing

Testing debe incluir:

- successful run;
- transient provider failure;
- permanent provider failure;
- duplicate delivery;
- timeout;
- cancellation;
- approval wait;
- approval expiry;
- disconnect during run;
- partial success;
- concurrent duplicate trigger.

---

# 86. Local Development

El entorno local debe permitir:

- ejecutar tasks;
- simular failures;
- revisar logs;
- probar retries;
- probar scheduled runs.

No depender de producción para debugging.

---

# 87. Environment Separation

Separar:

```text
development
staging
production
```

Schedules de desarrollo no deben ejecutar acciones de producción.

---

# 88. Safe Testing of Writes

Para tests/integration:

- mock providers;
- sandbox accounts;
- test bindings;
- explicit environment guards.

Evitar emails/eventos reales accidentales.

---

# 89. MVP Scope

MVP incluye:

```text
Trigger.dev integration
BackgroundRuntime abstraction
Schedules execution
one-time + recurring jobs
Knowledge ingestion
Knowledge sync
large imports
long-running analysis handoff
retries
idempotency
status persistence
realtime progress
cancellation where feasible
approval waits
partial failure
result persistence
notifications
logging
basic metrics
```

---

# 90. Post-MVP Scope

Futuro:

```text
event-driven workflows
condition watches
advanced queues
priority queues
team quotas
regional workers
custom workflow steps
webhook triggers
MCP actions
Make / Power Automate actions
advanced fan-out orchestration
enterprise SLAs
```

---

# 91. What ELISE Must Not Do

Avoid:

- putting all business logic inside Trigger.dev;
- retrying destructive writes blindly;
- storing provider tokens inside job payloads;
- relying only on ephemeral realtime state;
- running every request in background;
- allowing duplicate scheduled runs;
- keeping failed jobs invisible;
- coupling domain models to Trigger.dev SDK types;
- assuming user browser stays open;
- making users understand queue infrastructure.

---

# 92. Architecture Summary

```text
Interactive Request
      ↓
Need durable work?
      ↓
    Yes
      ↓
Application Service
      ↓
BackgroundRuntime
      ↓
Trigger.dev
      ↓
Application Service / Core
      ↓
Providers / Supabase / AI
      ↓
Persist State + Result
      ↓
Realtime / Notification
      ↓
User
```

---

# 93. North Star

> **Background execution should make ELISE dependable, not complicated.**
>
> The user asks once.
>
> ELISE keeps working.
>
> Progress remains visible.
>
> Failures are recoverable.
>
> Results are waiting when the user returns.
