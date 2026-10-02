# ELISE — Observability, Errors & Audit

**Document:** `18-observability-errors-audit.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE registra, observa, diagnostica y comunica lo que ocurre en el sistema, incluyendo AI runs, tools, providers, background jobs, approvals, errores, métricas, trazas y auditoría, sin exponer secretos ni convertir la experiencia de usuario en una consola técnica.

---

# 1. Vision

ELISE debe ser observable en dos niveles distintos:

```text
User-facing observability
→ What is happening?
→ Did it work?
→ What needs attention?

Engineering observability
→ Why did it happen?
→ Where did it fail?
→ How long did it take?
→ Which provider/model/tool was involved?
```

El usuario debe ver claridad.

El equipo de ingeniería debe tener trazabilidad.

---

# 2. Core Principle

> **Every important action should be traceable from user intent to final outcome.**

Ejemplo:

```text
User request
↓
AI Run
↓
Tool Call
↓
Provider Resolution
↓
Approval
↓
External Action
↓
Result
```

Debe ser posible reconstruir este camino.

---

# 3. Observability Domains

ELISE debe observar al menos:

```text
Frontend
Next.js server
AI runtime
Tool execution
Provider calls
Background jobs
Schedules
Knowledge ingestion
Approvals
Notifications
Database
Realtime
```

---

# 4. Shared Trace Identifiers

Cuando corresponda, propagar:

```text
request_id
run_id
conversation_id
workspace_id
action_id
background_job_id
schedule_run_id
approval_id
```

No todas las operaciones necesitan todos los IDs.

---

# 5. Request ID

Cada request significativa debería tener:

```text
request_id
```

Permite relacionar:

- frontend error;
- server logs;
- tool execution;
- provider call.

---

# 6. AI Run ID

Cada ejecución del Agent Runtime debe tener:

```text
ai_run_id
```

Debe permitir identificar:

```text
conversation
skill
model
tools
latency
token usage
result status
```

---

# 7. Action ID

Cada write/proposed action debe tener:

```text
action_id
```

Ejemplo:

```text
email.send
calendar.createEvent
finance.createTransaction
```

Esto vincula:

```text
AI run
approval
tool execution
provider result
audit
```

---

# 8. Background Job ID

Procesos durables deben tener:

```text
background_job_id
```

Ejemplos:

```text
Knowledge sync
Morning Brief
Import
Long analysis
```

---

# 9. Structured Logging

Preferir logs estructurados.

Ejemplo conceptual:

```json
{
  "event": "tool.completed",
  "tool": "calendar.createEvent",
  "workspace_id": "...",
  "run_id": "...",
  "latency_ms": 432,
  "status": "success"
}
```

No depender únicamente de strings libres.

---

# 10. Log Levels

Usar niveles coherentes:

```text
debug
info
warn
error
critical
```

Producción no debe generar debug excesivo por defecto.

---

# 11. Sensitive Data in Logs

Nunca loguear:

```text
passwords
OAuth tokens
refresh tokens
API secrets
service-role keys
raw credentials
```

Evitar también contenido personal completo salvo necesidad real.

---

# 12. Content Logging

Por defecto, preferir:

```text
IDs
counts
types
hashes
metadata
```

sobre:

```text
full email body
full document
full conversation
```

El contenido completo solo debe registrarse cuando exista una razón explícita y segura.

---

# 13. Error Taxonomy

ELISE debe utilizar errores tipados.

Categorías iniciales:

```text
AUTH_ERROR
PERMISSION_DENIED
VALIDATION_ERROR
NOT_FOUND
CONFLICT
RATE_LIMITED
PROVIDER_UNAVAILABLE
TIMEOUT
AI_PROVIDER_ERROR
BACKGROUND_ERROR
UNKNOWN_OUTCOME
INTERNAL_ERROR
```

---

# 14. User Error vs System Error

Diferenciar:

```text
User-correctable
System-recoverable
System-fatal
```

Ejemplos:

```text
Missing required date
→ User-correctable

Google timeout
→ System-recoverable

Database corruption
→ System-fatal
```

---

# 15. Retryable Errors

Errores transitorios:

```text
timeout
rate limit
temporary network failure
provider 5xx
```

Pueden reintentarse.

---

# 16. Non-Retryable Errors

Ejemplos:

```text
permission denied
invalid payload
resource not found
revoked OAuth
```

No repetir automáticamente.

---

# 17. Unknown Outcome

Caso crítico:

```text
Provider request timed out after a write may have occurred.
```

Estado:

```text
UNKNOWN_OUTCOME
```

Antes de retry:

```text
reconcile
```

Ejemplo:

```text
Did email actually send?
Did event get created?
```

---

# 18. Error Object

Modelo conceptual:

```text
AppError

code
category
message
user_message
retryable
user_action_required
provider
operation
trace_id
metadata
cause
```

---

# 19. User-Facing Errors

La UI debe mostrar lenguaje accionable.

Malo:

```text
403 invalid_grant
```

Mejor:

```text
Gmail needs to be reconnected.

[ Reconnect ]
```

---

# 20. Error Details

Para usuarios avanzados o soporte:

```text
View details
```

Puede mostrar:

```text
Error code
Time
Reference ID
Provider
```

No secretos ni stack traces completos.

---

# 21. Error Reference ID

Errores visibles pueden incluir:

```text
Reference: ERR-...
```

Esto ayuda a soporte sin exponer detalles internos.

---

# 22. Frontend Error Boundaries

Next.js/React debe usar:

- route error boundaries;
- component fallbacks;
- retry affordances;
- graceful degradation.

Una card rota no debería romper toda la app.

---

# 23. Loading vs Error vs Empty

Cada componente debe diferenciar:

```text
Loading
Empty
Error
Ready
```

No mostrar un spinner infinito ante fallo.

---

# 24. Provider Health

Cada connection puede tener:

```text
Healthy
Degraded
Needs Reauthorization
Unavailable
Disabled
```

Esto debe alimentar:

- Connections UI;
- Schedules;
- Tool availability.

---

# 25. Provider Metrics

Por provider medir:

```text
success rate
latency
rate-limit frequency
auth failures
5xx failures
timeout rate
```

Esto ayuda a saber si el problema es de ELISE o del proveedor.

---

# 26. AI Runtime Metrics

Medir:

```text
time to first token
total latency
input tokens
output tokens
tool calls per run
model
cost estimate
failure rate
```

---

# 27. Tool Metrics

Por tool:

```text
calls
success rate
latency
approval rate
clarification rate
error rate
retry rate
```

---

# 28. Context Metrics

Durante desarrollo puede ser útil medir:

```text
memory items injected
rules injected
knowledge chunks retrieved
context token size
```

Esto ayuda a detectar prompts inflados.

---

# 29. Knowledge Metrics

Medir:

```text
items indexed
sync duration
failed items
chunks generated
retrieval latency
search result count
reindex frequency
```

---

# 30. Retrieval Quality

Crear evaluación offline:

```text
question
expected source
retrieved source
answer evidence
```

No reducir calidad a una única métrica automática.

---

# 31. Background Metrics

Medir:

```text
queued jobs
running jobs
success rate
retry rate
average duration
queue delay
jobs waiting approval
cancelled jobs
```

---

# 32. Schedule Metrics

Medir:

```text
runs
success
partial success
failure
missed runs
late runs
approval waits
```

---

# 33. Notification Metrics

Medir:

```text
created
delivered
failed
read
clicked
```

No usar métricas de engagement para volver notificaciones más invasivas.

---

# 34. Approval Metrics

Medir:

```text
requested
approved
rejected
edited
expired
time to decision
```

Esto puede revelar fricción excesiva.

---

# 35. Audit vs Logs

Logs:

```text
operational debugging
```

Audit:

```text
durable history of meaningful actions
```

No son lo mismo.

---

# 36. Audit Events

Ejemplos:

```text
connection.created
connection.disconnected
permission.changed
rule.changed
schedule.created
schedule.paused
approval.approved
email.sent
calendar.event_created
finance.transaction_deleted
```

---

# 37. Audit Event Schema

Conceptualmente:

```text
AuditEvent

id
workspace_id
user_id
event_type
resource_type
resource_id
provider
connection_id
approval_id
result
timestamp
metadata
```

---

# 38. Audit Immutability

Audit events no deberían editarse desde UI normal.

Correcciones pueden generar nuevos eventos.

No reescribir historia silenciosamente.

---

# 39. Audit Privacy

Audit debe ser útil sin duplicar contenido sensible.

Ejemplo:

```text
Email sent to client@example.com
```

puede ser suficiente.

No siempre hace falta almacenar el cuerpo completo.

---

# 40. Tool Execution Trace

Ejemplo:

```text
AI Run #123
├── email.search ✓ 320ms
├── calendar.list ✓ 280ms
└── knowledge.search ✓ 510ms
```

Puede existir internamente para debugging.

---

# 41. User-Facing Execution Trace

La UI muestra una versión simplificada:

```text
✓ Checked calendar
✓ Read important email
✓ Searched knowledge
```

No:

```text
MCP request 04af...
```

---

# 42. Trace Collapsing

Después de completar:

```text
✓ Prepared using 3 sources
```

El usuario puede expandir.

---

# 43. Realtime Error Updates

Si una operación background falla:

```text
Realtime
→ update UI
```

Ejemplo:

```text
Google Drive sync needs attention.
```

No esperar refresh manual.

---

# 44. Sentry / Error Monitoring

Se recomienda utilizar una herramienta de error monitoring compatible con Next.js.

Ejemplo futuro:

```text
Sentry
```

o equivalente.

Debe configurarse con:

- source maps;
- environment tags;
- release version;
- PII minimization.

La elección definitiva puede hacerse en implementación.

---

# 45. Product Analytics

Analytics debe medir uso del producto sin invadir privacidad.

Ejemplos:

```text
onboarding completed
connection added
Morning Brief configured
Schedule created
Knowledge Space created
```

Evitar enviar contenido del usuario como analytics property.

---

# 46. Analytics Tool

Puede elegirse posteriormente:

```text
PostHog
Amplitude
other
```

No es necesario bloquear arquitectura ahora.

---

# 47. OpenTelemetry — Future

Si el sistema crece, adoptar OpenTelemetry para trazas distribuidas.

MVP puede comenzar más simple.

Arquitectura debe mantener IDs consistentes para facilitar migración.

---

# 48. Performance Budgets

Definir objetivos por experiencia.

Ejemplos conceptuales:

```text
Chat:
fast first feedback

Simple reads:
seconds, not tens of seconds

Background:
clear progress instead of blocking
```

Los targets exactos se establecerán mediante medición real.

---

# 49. Slow Operation Handling

Si una operación supera threshold interactivo:

```text
show progress
or
handoff background
```

Nunca dejar al usuario mirando un loader sin contexto.

---

# 50. Database Monitoring

Observar:

```text
slow queries
connection usage
storage growth
RLS-related failures
deadlocks
index usage
```

---

# 51. Vector Monitoring

Observar:

```text
vector index size
retrieval latency
embedding failures
reindex volume
```

---

# 52. Storage Monitoring

Medir:

```text
workspace storage
upload failures
download errors
orphaned objects
```

---

# 53. Orphan Cleanup

Background maintenance puede detectar:

```text
Storage files without DB reference
stale temp files
abandoned imports
```

Nunca borrar automáticamente sin reglas seguras.

---

# 54. Data Integrity Checks

Potential checks:

```text
current_version exists
schedule.next_run valid
approval/action relation valid
connection bindings valid
```

---

# 55. Health Checks

ELISE debe tener health endpoints internos para:

```text
app
database
background runtime
AI provider
critical services
```

No incluir secretos en responses públicas.

---

# 56. Provider Health Checks

No golpear providers innecesariamente.

Usar:

- connection errors;
- lightweight validation;
- token expiry;
- last successful call.

---

# 57. Setup Health vs System Health

User-facing:

```text
ELISE Setup
Email connected
Knowledge ready
```

Engineering-facing:

```text
DB healthy
Trigger.dev healthy
OpenAI latency
```

No mezclarlos.

---

# 58. Alerting

Engineering alerts para:

```text
high error rate
background queue stuck
auth failures spike
database unavailable
provider outage
schedule failures spike
```

---

# 59. Alert Noise

Evitar alert fatigue.

No alertar por cada error individual recuperable.

Preferir thresholds y aggregation.

---

# 60. Incident Correlation

Un provider outage puede generar cientos de errores.

Agrupar por:

```text
provider
error code
time window
```

---

# 61. Degraded Mode

Si una integración falla, otras partes pueden seguir funcionando.

Ejemplo:

```text
Gmail unavailable
```

ELISE todavía puede usar:

```text
Calendar
Tasks
Knowledge
```

---

# 62. User Status Messaging

Si un provider externo tiene problemas:

```text
Gmail is temporarily unavailable. Your calendar and tasks are still available.
```

No presentar ELISE completa como caída.

---

# 63. Partial Results

Multi-capability experiences pueden finalizar:

```text
Completed with warning
```

Ejemplo Morning Brief sin Gmail.

---

# 64. Failure Recovery UX

Cada error debería intentar ofrecer:

```text
Retry
Reconnect
Review
Edit
Cancel
```

según corresponda.

---

# 65. Automatic Recovery

ELISE puede recuperar automáticamente:

```text
temporary provider failure
background timeout retry
rate limit
```

si es seguro.

No molestar al usuario si el sistema se recuperó solo.

---

# 66. Retry Visibility

No hace falta mostrar cada retry.

Si tarda:

```text
Still working...
```

Si falla finalmente:

```text
Needs attention
```

---

# 67. Observability for Permissions

Registrar:

```text
permission denied
approval required
scope missing
connection inaccessible
```

Esto ayuda a diagnosticar UX de permisos.

---

# 68. Observability for Provider Resolution

Durante debugging registrar:

```text
capability requested
candidate bindings
selected binding
reason
confidence
```

Sin exponerlo por defecto al usuario.

---

# 69. Observability for Context Builder

Development trace:

```text
active entity
selected memories
selected rules
Knowledge scope
retrieved chunks
```

Muy útil para investigar respuestas inesperadas.

---

# 70. Explainability Without Chain-of-Thought

La UI puede explicar decisiones mediante hechos observables:

```text
Using Acme Gmail because this conversation is linked to Client A.
```

No requiere exponer razonamiento interno detallado del modelo.

---

# 71. AI Failure Modes

Track separately:

```text
model timeout
invalid structured output
tool selection failure
context overflow
provider refusal/error
```

---

# 72. Structured Output Recovery

Si AI devuelve schema inválido:

```text
validate
↓
retry/repair within limit
↓
fail safely
```

No ejecutar payload inválido.

---

# 73. Hallucinated Tool Calls

Tool Registry rechaza:

```text
unknown tool
unsupported operation
invalid provider extension
```

Registrar como runtime error/evaluation signal.

---

# 74. Cost Observability

Track:

```text
AI input/output tokens
embedding volume
background runtime usage
Storage
provider calls where relevant
```

Necesario para pricing futuro.

---

# 75. Cost Attribution

Idealmente atribuir costo a:

```text
workspace
feature
AI run
background job
```

No necesita facturación real en MVP.

---

# 76. Feature-Level Metrics

Ejemplos:

```text
Morning Brief:
average sources
generation time
completion rate

Knowledge:
retrieval latency
sync failures

Study:
sessions completed
```

---

# 77. Privacy-Safe Product Metrics

Evitar metrics como:

```text
full prompt text
full email subject/body
document content
```

Preferir:

```text
feature type
count
latency
success/failure
```

---

# 78. Retention

Distintas observability data requieren diferente retención.

Ejemplo:

```text
debug logs → short
audit → longer
AI usage metrics → medium/long
raw traces → controlled
```

Definir política antes de producción pública.

---

# 79. Log Redaction

Crear utilidad común:

```text
redactSensitive(...)
```

para:

- tokens;
- auth headers;
- cookies;
- secrets;
- sensitive fields.

---

# 80. Environment Tags

Todos los eventos deben identificar:

```text
development
staging
production
```

Nunca mezclar métricas de entornos.

---

# 81. Release Tracking

Registrar versión/release del frontend/backend.

Permite responder:

```text
Did errors start after release X?
```

---

# 82. Feature Flags

Futuro:

```text
feature flags
```

pueden permitir rollout gradual.

Eventos deben registrar flags relevantes en debugging, sin sobrecargar analytics.

---

# 83. Audit Search

Future UI/admin puede permitir buscar:

```text
resource
operation
date
provider
status
```

No es necesario como interfaz completa en MVP.

---

# 84. User Activity History

No mostrar un “surveillance log”.

Audit existe para confianza y soporte.

User-facing history puede limitarse a acciones relevantes:

```text
Email sent
Event created
Schedule ran
```

---

# 85. Admin Access

Future internal admin tools deben estar altamente restringidos.

No crear un backdoor para leer datos de todos los usuarios indiscriminadamente.

---

# 86. Support Diagnostics

Cuando un usuario reporta error, idealmente puede compartir:

```text
Reference ID
```

El equipo puede buscar:

```text
trace/run/action
```

sin pedir credenciales.

---

# 87. Error Correlation Example

User sees:

```text
Couldn't create the event.
Reference: ACT-83F2
```

Engineering:

```text
Action
→ calendar.createEvent
→ Google Calendar
→ permission revoked
```

---

# 88. Background Debugging

Run detail internal:

```text
ScheduleRun
├── Triggered 07:30
├── Calendar ✓
├── Tasks ✓
├── Gmail retry 1
├── Gmail retry 2
├── Gmail failed
├── News ✓
└── Completed with warning
```

---

# 89. Knowledge Debugging

Source detail internal:

```text
Notion Source
├── last sync
├── cursor
├── items discovered
├── items updated
├── failed items
└── parser version
```

---

# 90. Data Import Debugging

Import should preserve:

```text
row number
raw data reference
normalized data
validation error
created record
```

Esto permite review preciso.

---

# 91. Audit for AI-Initiated Actions

Toda Action generada por AI debe poder indicar:

```text
origin = ai
```

y vincularse a:

```text
ai_run_id
```

---

# 92. Audit for User-Direct Actions

Actions desde UI pueden indicar:

```text
origin = user_ui
```

Esto ayuda a distinguir caminos.

---

# 93. Audit for Scheduled Actions

```text
origin = schedule
schedule_run_id = ...
```

---

# 94. Audit for System Maintenance

```text
origin = system
```

Ejemplos:

```text
sync
reindex
cleanup
```

---

# 95. Error Ownership

Los errores deben poder asignarse conceptualmente a:

```text
User Input
ELISE
External Provider
Infrastructure
AI Provider
```

Esto mejora mensajes y debugging.

---

# 96. Error Message Philosophy

No culpar al usuario por fallos técnicos.

No ocultar problemas reales.

Ser específico:

```text
"Google Calendar access expired."
```

mejor que:

```text
"Something went wrong."
```

---

# 97. Error Escalation

Después de retries seguros fallidos:

```text
Needs attention
```

No mantener procesos infinitos.

---

# 98. Observability Dashboard — Internal

El equipo debería poder consultar:

```text
system health
recent errors
provider health
background jobs
AI usage
schedule failures
cost
```

No es un requisito de UI pública.

---

# 99. MVP Tooling

La implementación puede comenzar con:

```text
structured application logs
Supabase data/audit tables
Trigger.dev run visibility
Vercel runtime logs
optional Sentry or equivalent
```

No hace falta una plataforma observability enterprise desde día uno.

---

# 100. Observability Service Boundary

Centralizar helpers:

```text
logger
tracer
metrics
audit
error normalization
```

Evitar `console.log` dispersos como estrategia permanente.

---

# 101. Suggested Code Structure

```text
src/infrastructure/observability/
├── logger.ts
├── errors.ts
├── audit.ts
├── metrics.ts
├── tracing.ts
└── redaction.ts
```

---

# 102. Error Normalization Boundary

Providers traducen errores propios a errores ELISE.

Ejemplo:

```text
Google 401
↓
AUTH_EXPIRED
```

Application layer no debería depender de códigos crudos de Google.

---

# 103. Provider Error Preservation

Aunque se normalice, mantener internamente metadata mínima para debugging:

```text
provider_code
request_reference
```

sin secretos.

---

# 104. Alert Thresholds

Definir después de tener tráfico real.

No inventar thresholds complejos antes de medir baseline.

---

# 105. SLOs — Future

Futuro Business/Enterprise:

```text
availability
job completion
sync latency
provider reliability
```

MVP debe medir suficiente para poder definir SLOs más adelante.

---

# 106. Testing Observability

Tests deben verificar:

```text
errors normalized
secrets redacted
audit emitted
trace IDs propagated
failed writes not reported as success
```

---

# 107. Testing Audit

Ejemplo:

```text
send email
→ approval
→ approve
→ send
```

Expected audit:

```text
approval.approved
email.sent
```

---

# 108. Testing Unknown Outcome

Simular timeout tras write.

Expected:

```text
UNKNOWN_OUTCOME
no blind retry
reconciliation attempted
```

---

# 109. Testing Cross-Tenant Logging

Logs/audit de un workspace nunca deben exponerse a otro.

Internal telemetry también debe preservar tenant metadata de forma segura.

---

# 110. Incident Response Basics

Antes de producción pública, documentar:

```text
identify incident
contain
assess user impact
recover
communicate if needed
review root cause
```

No hace falta proceso enterprise en MVP, pero sí disciplina básica.

---

# 111. MVP Scope

MVP incluye:

```text
structured logs
typed errors
error normalization
reference IDs
AI run tracing
tool execution tracing
provider latency/status
background job observability
Schedule history
Knowledge sync history
approval audit
action audit
notification state
secret redaction
basic metrics
environment separation
user-facing actionable errors
```

---

# 112. Post-MVP Scope

Future:

```text
OpenTelemetry
advanced distributed tracing
custom observability dashboard
enterprise audit export
SLOs
incident automation
advanced anomaly detection
cost dashboards
team activity audit
long-term security analytics
```

---

# 113. What ELISE Must Not Do

Avoid:

- logging secrets;
- logging full user content by default;
- exposing raw stack traces to users;
- returning generic errors when recovery is known;
- treating logs as audit history;
- treating audit as debug logs;
- claiming success before provider confirmation;
- hiding partial failures;
- retrying unknown writes blindly;
- requiring users to understand technical provider errors.

---

# 114. Architecture Summary

```text
User Request
      ↓
Request ID
      ↓
AI Run
      ↓
Tool / Action
      ↓
Provider / Background
      ↓
Result / Error
      ↓
Structured Logs
      ↓
Metrics
      ↓
Audit Event
      ↓
User-Friendly Status
```

---

# 115. North Star

> **When ELISE works, the experience should feel effortless.**
>
> **When ELISE fails, the reason should be traceable and the recovery path should be clear.**
>
> Users see clarity.
>
> Engineers see evidence.
>
> Audit preserves what mattered.
