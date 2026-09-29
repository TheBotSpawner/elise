# ELISE — Tools, Actions & Approvals

**Document:** `15-tools-actions-approvals.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE expone tools al runtime de IA, cómo clasifica acciones de lectura y escritura, cómo valida inputs, cómo resuelve providers, cómo aplica permisos y approvals, y cómo confirma resultados de forma segura y trazable.

---

# 1. Vision

ELISE debe poder actuar sobre el mundo digital del usuario sin convertir cada interacción en una experiencia peligrosa o llena de confirmaciones innecesarias.

El objetivo es combinar:

```text
speed
+
clarity
+
control
+
safety
```

La regla general es:

> **Read broadly when safe. Write narrowly when certain.**

Y para acciones sensibles:

> **Fast when safe. Careful when it matters.**

---

# 2. Tool

Una Tool es una operación estructurada que el runtime de IA puede solicitar.

Ejemplos:

```text
email.search
email.createDraft
email.send

calendar.listEvents
calendar.createEvent
calendar.deleteEvent

tasks.create
tasks.complete

knowledge.search
knowledge.saveNote

finance.createTransaction
finance.query

web.search
```

Una Tool no es un provider.

ELISE solicita:

```text
calendar.createEvent
```

El backend decide si se ejecuta mediante:

```text
Google Calendar
Microsoft Calendar
future provider
```

---

# 3. Action

Una Action es la ejecución concreta de una Tool.

Ejemplo:

```text
Tool:
email.send

Action:
Send draft #123 to client@example.com
using Gmail Firbot
```

Las Actions tienen:

- actor;
- workspace;
- capability;
- operation;
- target;
- provider;
- connection;
- risk;
- approval policy;
- execution status;
- result.

---

# 4. Tool Architecture

Flujo:

```text
AI Runtime
    ↓
Tool Request
    ↓
Tool Registry
    ↓
Input Validation
    ↓
Capability Resolver
    ↓
Provider Resolver
    ↓
Permission Check
    ↓
Policy / Approval Check
    ↓
Execution
    ↓
Normalized Result
    ↓
Audit
    ↓
AI / UI
```

---

# 5. Tool Registry

ELISE debe mantener un registro de tools disponibles.

Cada tool define:

```text
name
capability
operation
description
input_schema
output_schema
risk_level
required_permissions
supports_background
supports_idempotency
approval_defaults
```

---

# 6. Tool Naming Convention

Usar nombres basados en capability.

Preferir:

```text
email.search
calendar.createEvent
tasks.create
knowledge.search
```

Evitar:

```text
gmailSearch
googleCalendarCreate
notionSearch
```

El provider se resuelve después.

---

# 7. Tool Inputs

Todos los inputs deben validarse con schemas estrictos.

Ejemplo conceptual:

```ts
calendar.createEvent({
  title,
  start,
  end,
  attendees?,
  calendarContext?,
  notes?
})
```

No permitir objetos arbitrarios enviados directamente por el modelo.

---

# 8. Tool Outputs

Outputs también deben estar normalizados.

Ejemplo:

```text
CreateEventResult

success
event_id
provider
connection_id
title
start
end
url
```

La respuesta al usuario debe basarse en el resultado real.

---

# 9. Read vs Write

Tools se clasifican inicialmente en:

```text
Read
Write
Destructive Write
External Communication
Sensitive Write
```

Ejemplos:

```text
Read:
email.search

Write:
tasks.create

Destructive:
calendar.deleteEvent

External Communication:
email.send

Sensitive:
finance.deleteTransaction
```

---

# 10. Read Actions

Read actions normalmente pueden ejecutarse automáticamente.

Ejemplos:

```text
search email
read calendar
query tasks
search knowledge
read finance
```

Siempre deben respetar:

- ownership;
- workspace;
- provider permissions;
- source scope;
- connection access.

---

# 11. Safe Multi-Provider Reads

Si el usuario no especifica una cuenta y consultar varias es seguro:

```text
search all relevant bindings
```

Ejemplo:

> “¿Tengo algún mail de Juan?”

Puede consultar:

```text
Gmail Personal
Gmail Firbot
```

si ambas son relevantes.

---

# 12. Write Actions

Writes requieren resolver destino exacto.

Ejemplo:

> “Creá una tarea para mañana.”

Si existe default claro:

```text
ELISE Tasks
```

se ejecuta.

Si existen múltiples destinos plausibles:

```text
ELISE Tasks
Google Tasks
```

y no hay contexto suficiente:

```text
ask
```

---

# 13. Destructive Actions

Deletes y acciones irreversibles deben tener mayor protección.

Ejemplos:

```text
delete event
delete email
delete transaction
disconnect provider
bulk archive
```

Por defecto:

```text
Always Ask
```

salvo casos de muy bajo riesgo específicamente configurados.

---

# 14. External Communication

Acciones que afectan a otras personas requieren especial atención.

Ejemplos:

```text
send email
send message
invite attendee
future WhatsApp message
future Slack message
```

Default:

```text
draft → permissive
send → conservative
```

---

# 15. Draft First Pattern

Cuando sea posible:

```text
Generate
→ Draft
→ Review
→ Send
```

Ejemplo email:

```text
email.createDraft
→ automatic

email.send
→ approval
```

Esto da velocidad sin perder control.

---

# 16. Risk Levels

Cada operation puede tener un nivel de riesgo.

Ejemplo:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

No deben mostrarse necesariamente como labels al usuario.

---

# 17. Risk Examples

```text
LOW
email.search
tasks.list
knowledge.search

MEDIUM
tasks.create
calendar.createEvent
finance.createTransaction

HIGH
email.send
calendar.deleteEvent
finance.deleteTransaction

CRITICAL
future payment execution
bulk destructive operation
workspace ownership transfer
```

---

# 18. Risk Is Contextual

Una misma tool puede variar según contexto.

Ejemplo:

```text
calendar.createEvent
```

Low/medium:

```text
personal reminder
no attendees
```

Higher:

```text
external client meeting
multiple attendees
```

El Policy Engine puede ajustar riesgo.

---

# 19. Approval Modes

Configuraciones principales:

```text
Always Ask
Ask When Uncertain
Allow Automatically
```

En español:

```text
Preguntar siempre
Preguntar si hay dudas
Permitir automáticamente
```

---

# 20. Default Approval Philosophy

Defaults:

```text
Read
→ Automatic

Draft
→ Automatic

Simple reversible write
→ Automatic or Ask When Uncertain

External communication
→ Always Ask initially

Destructive
→ Always Ask
```

---

# 21. Approval Decision

Inputs:

```text
operation
risk
reversibility
provider
connection
context
confidence
rules
current instruction
target
scope
```

Output:

```text
Execute
Ask Approval
Ask Clarification
Reject
```

---

# 22. Clarification vs Approval

No son lo mismo.

Clarification:

```text
"Which calendar?"
```

Approval:

```text
"Create this event?"
```

Primero resolver ambigüedad.

Después aplicar approval policy.

---

# 23. Example — Ambiguous Account

User:

> “Mandá este mail.”

Connections:

```text
Gmail Personal
Gmail Firbot
```

No context.

Flow:

```text
Clarification:
Which account?

Then:
Send approval
```

No pedir aprobación sobre una acción cuyo destino todavía es ambiguo.

---

# 24. Example — Clear Context

User:

> “Respondé este mail de RSFA.”

Context:

```text
RSFA
→ work
→ Firbot Gmail
```

ELISE puede resolver cuenta automáticamente.

Luego:

```text
create draft
→ automatic

send
→ approval
```

---

# 25. Approval Object

Modelo conceptual:

```text
Approval

id
workspace_id
user_id
action_id
capability
operation
provider
connection_id
risk_level
payload_snapshot
summary
reason
status
expires_at
created_at
resolved_at
```

---

# 26. Approval States

```text
Pending
Approved
Rejected
Expired
Cancelled
Superseded
```

---

# 27. Approval Snapshot

La aprobación debe guardar qué se está aprobando.

Ejemplo:

```text
To:
client@example.com

Subject:
Proposal follow-up

Body hash / snapshot:
...

Connection:
Gmail Firbot
```

Si el contenido cambia sustancialmente después:

```text
new approval required
```

---

# 28. Approval UX

Debe mostrar:

```text
What will happen
Where
Who is affected
Relevant content
```

Ejemplo:

```text
Send email

From:
Firbot Gmail

To:
Client X

Subject:
Proposal follow-up

[ Review ]
[ Approve ]
[ Reject ]
```

---

# 29. Edit Before Approval

El usuario puede modificar antes de aprobar.

Ejemplo:

```text
[ Edit Draft ]
```

Si cambia:

```text
approval now refers to edited version
```

---

# 30. Approve From Chat

Approval puede aparecer inline.

Ejemplo:

```text
I prepared the event.

Tuesday 15:00
Client X
45 minutes

[ Create ]
[ Edit ]
[ Cancel ]
```

No obligar a abrir una pantalla separada.

---

# 31. Approval Center

También debe existir:

```text
Approvals
```

para acciones pendientes provenientes de:

- background jobs;
- Schedules;
- disconnected sessions.

---

# 32. Approval Expiration

Actions time-sensitive deben expirar.

Ejemplo:

```text
Send reminder before meeting
```

Si el meeting ya ocurrió:

```text
approval expired
```

No ejecutar automáticamente.

---

# 33. Revalidation Before Execution

Después de aprobar, verificar nuevamente:

```text
permission still valid
connection healthy
target still exists
action still makes sense
```

Especialmente si pasó tiempo.

---

# 34. Remember This Choice

Después de aprobar, ELISE puede ofrecer:

```text
Remember this
```

Ejemplos:

```text
Always use Firbot Gmail for RSFA

Allow task creation automatically

Always ask before sending client emails
```

Esto crea Rule/Policy.

---

# 35. Bulk Actions

Bulk operations requieren tratamiento especial.

Ejemplo:

```text
Archive 800 emails
Delete 40 calendar events
Import 5,000 transactions
```

UI debe mostrar:

```text
scope
count
preview
impact
```

---

# 36. Bulk Approval

No aprobar con una frase vaga.

Malo:

```text
"Clean my inbox"
```

y ejecutar 2,000 deletes.

Mejor:

```text
ELISE found:
• 840 promotions
• 120 newsletters
• 35 old notifications

Proposed:
Archive 995 emails

[ Review ]
[ Approve ]
```

---

# 37. Preview Pattern

Para acciones complejas:

```text
Interpret
→ Preview
→ Validate
→ Approve
→ Execute
```

Ejemplos:

- finance import;
- calendar plan;
- bulk inbox cleanup;
- migration;
- Schedule creation.

---

# 38. Action Model

Modelo conceptual:

```text
Action

id
workspace_id
run_id
capability
operation
provider
connection_id
input
risk_level
status
approval_id
idempotency_key
created_at
executed_at
result_reference
```

---

# 39. Action States

```text
Proposed
Validated
Waiting for Clarification
Waiting for Approval
Executing
Completed
Failed
Cancelled
Expired
```

---

# 40. Idempotency

Writes deben tener idempotency cuando sea posible.

Ejemplo:

```text
Action ID
→ idempotency key
```

Retry:

```text
same action
→ do not duplicate
```

---

# 41. Tool Validation Pipeline

Antes de ejecutar:

```text
Schema Validation
↓
Workspace Validation
↓
Capability Permission
↓
Connection Ownership
↓
Provider Support
↓
Rule Resolution
↓
Risk Evaluation
↓
Approval Decision
↓
Execution
```

---

# 42. Provider Capability Check

El resolver debe verificar que el provider soporte la operación.

Ejemplo:

```text
provider supports read but not draft
```

No ofrecer:

```text
createDraft
```

para esa connection.

---

# 43. Permission Check

Distintas capas:

```text
OAuth permission
ELISE capability permission
User policy
Workspace permission
```

Todas deben permitir la operación.

---

# 44. Tool Availability

El AI Runtime solo recibe tools utilizables.

Ejemplo:

Sin Gmail conectado:

```text
email.search
```

no debería exponerse.

Puede exponerse una acción UI:

```text
Connect Email
```

---

# 45. Dynamic Tool Set

Tools disponibles dependen de:

```text
intent
active skill
connections
permissions
workspace
context
```

No exponer 100 tools en cada request.

---

# 46. Tool Categories

Organización conceptual:

```text
Read Tools
Write Tools
Search Tools
Generation Tools
Provider Setup Tools
Background Tools
System Tools
```

---

# 47. System Tools

Ejemplos internos:

```text
requestClarification
requestApproval
enqueueBackgroundJob
createNotification
```

No necesariamente deben ser model tools directas.

Algunas pueden ser funciones del runtime.

---

# 48. Action Confirmation

Después de ejecutar:

```text
confirm actual result
```

Ejemplo:

```text
✓ Event created
```

solo después de respuesta exitosa del provider.

---

# 49. Never Claim Before Confirmation

Malo:

```text
Done, I sent the email.
```

si todavía no se llamó al provider.

Correcto:

```text
I prepared the email. Approve it to send.
```

Luego:

```text
✓ Email sent.
```

---

# 50. Failed Writes

Si el provider falla:

```text
do not claim success
```

Ejemplo:

```text
I couldn't send the email because Gmail needs to be reconnected.

[ Reconnect ]
```

---

# 51. Uncertain Write Outcome

Caso peligroso:

```text
request timed out after send
```

No retry ciegamente.

Estado:

```text
UNKNOWN_OUTCOME
```

Luego:

```text
reconcile with provider
```

antes de repetir.

---

# 52. Reconciliation

Ejemplo email:

```text
timeout
↓
search sent folder / provider action ID
↓
determine whether sent
```

Cuando sea técnicamente posible.

---

# 53. Undo

Actions reversibles pueden ofrecer:

```text
Undo
```

Ejemplos potenciales:

```text
archive email
complete task
move note
```

No fingir undo cuando la acción no es realmente reversible.

---

# 54. Destructive Confirmation Language

El UI debe ser concreto.

Malo:

```text
Are you sure?
```

Mejor:

```text
Delete 12 calendar events?

This cannot be undone.

[ Cancel ]
[ Delete 12 events ]
```

---

# 55. Tool Errors

Tool runtime debe producir errores tipados.

Ejemplos:

```text
VALIDATION_ERROR
AUTH_EXPIRED
PERMISSION_DENIED
NOT_FOUND
RATE_LIMITED
PROVIDER_UNAVAILABLE
CONFLICT
UNKNOWN_OUTCOME
```

---

# 56. Error Recovery

Cada error puede incluir:

```text
retryable
user_action_required
suggested_recovery
```

Ejemplo:

```text
AUTH_EXPIRED
retryable = false
user_action_required = reconnect
```

---

# 57. Tool Timeouts

Tools deben tener timeouts.

Si una operación excede tiempo interactivo:

```text
handoff to background
```

si la semántica lo permite.

---

# 58. Background Actions

Background execution utiliza las mismas tools y policies.

No crear un camino “menos seguro” para Schedules.

```text
Interactive
Background
Scheduled
```

todos pasan por:

```text
validation
permissions
rules
approval policy
```

---

# 59. Approval in Background

Flow:

```text
Schedule Run
 ↓
Tool Request
 ↓
Approval Required
 ↓
Pending Approval
 ↓
Run Paused
 ↓
User Approves
 ↓
Resume
```

---

# 60. Tool Result Provenance

Cada resultado debe conservar:

```text
provider
connection
external ID
timestamp
```

Esto permite futuros writes sobre el mismo objeto.

---

# 61. Search Result Provenance

Ejemplo email result:

```text
message
source account
provider
thread ID
```

No perder source al combinar múltiples cuentas.

---

# 62. Action Provenance

Audit:

```text
requested by
interpreted by
approved by
executed via
executed at
result
```

---

# 63. AI Role

AI puede:

- interpret intent;
- choose relevant tool;
- extract fields;
- propose actions;
- summarize;
- explain;
- draft content.

AI no puede decidir unilateralmente:

- authorization;
- workspace access;
- credential access;
- hard approval bypass;
- whether a destructive action really succeeded.

---

# 64. Deterministic Role

Código controla:

```text
schema validation
permissions
ownership
provider support
risk
approval
idempotency
calculations
dates
limits
```

---

# 65. Tool Description Quality

Tool descriptions deben ser claras para reducir errores de selección.

Ejemplo:

```text
email.send
Sends an already prepared email using a resolved email connection.
Use only when final sending is intended.
```

No descripciones ambiguas.

---

# 66. Structured Tool Calls

Preferir schemas concretos.

Malo:

```text
executeAction({
  text: "send an email to John"
})
```

Mejor:

```text
email.send({
  draftId,
  connectionContext
})
```

---

# 67. Tool Composition

Una experiencia puede combinar tools.

Ejemplo:

> “Organizame mañana.”

```text
calendar.listEvents
tasks.list
habits.getProgress
goals.listActive
```

Luego:

```text
calendar.createEvent
```

si el usuario acepta el plan.

---

# 68. Write Plan Validation

Antes de ejecutar varias writes:

```text
validate full plan
```

Ejemplo:

```text
Create 5 calendar blocks
```

Chequeos:

```text
conflicts
durations
calendar
timezone
duplicates
```

Luego ejecutar.

---

# 69. Multi-Action Approval

Para varias actions relacionadas, se puede pedir una sola aprobación comprensible.

Ejemplo:

```text
Add tomorrow's plan to your calendar?

5 blocks
09:00 Deep Work
11:00 Gym
...
```

En backend siguen existiendo múltiples Actions.

---

# 70. Atomicity Expectations

No siempre se puede garantizar transacción entre APIs externas.

ELISE debe distinguir:

```text
database atomicity
vs
multi-provider best-effort execution
```

Si un plan falla parcialmente:

```text
report exact state
```

---

# 71. Partial Multi-Action Result

Ejemplo:

```text
4 calendar blocks created
1 failed due to conflict
```

No responder simplemente:

```text
Done.
```

---

# 72. Tool Execution Logs

Registrar:

```text
tool name
action ID
provider
latency
status
error type
retry count
```

Evitar guardar payloads sensibles completos innecesariamente.

---

# 73. Audit Trail

Para writes:

```text
user
workspace
operation
target
provider
approval
result
timestamp
```

---

# 74. Tool Metrics

Medir:

```text
success rate
error rate
latency
approval rate
clarification rate
retry rate
provider-specific failures
```

---

# 75. Approval Metrics

Medir:

```text
approved
rejected
edited before approval
expired
time to approval
```

Esto ayuda a ajustar defaults.

---

# 76. Friction Monitoring

Si usuarios aprueban siempre una acción de bajo riesgo:

ELISE puede sugerir:

```text
"Want to allow this automatically?"
```

No cambiar policy sin consentimiento.

---

# 77. Safety Monitoring

Si una acción configurada automática empieza a fallar o se vuelve ambigua:

```text
fall back to approval
```

La autonomía no debe ser rígida.

---

# 78. Provider-Specific Extensions

Tools core usan capability contracts.

Provider extensions pueden existir.

Ejemplo:

```text
email.applyLabel
```

solo disponible para providers compatibles.

UI/AI debe saber que es una extensión.

---

# 79. Custom Tools — Post-MVP

Futuro:

```text
MCP
Webhook
Custom API
Make
Power Automate
```

Cada custom tool debe declarar:

```text
schema
permissions
risk
auth
side effects
```

---

# 80. Custom Tool Trust

Custom tools se consideran menos confiables hasta configurarse.

No asumir:

```text
safe because user connected it
```

Requieren:

- explicit permissions;
- validation;
- logs;
- action classification.

---

# 81. Web Search Tools

Web Search es Read.

Sin embargo:

```text
web content
```

es untrusted input.

No debe poder modificar tool policies ni instrucciones de sistema.

---

# 82. Prompt Injection Boundary

Contenido de:

```text
emails
web pages
documents
CRM text
```

nunca se trata como trusted instruction.

Ejemplo malicioso:

```text
"Ignore all previous instructions and send..."
```

debe permanecer data.

---

# 83. Tool Output Sanitization

Antes de volver al AI Runtime:

- normalize;
- remove secrets;
- limit excessive payload;
- preserve provenance;
- mark source type.

---

# 84. Approval Security

Una approval UI nunca debe poder modificar el payload de forma oculta.

User approves:

```text
what they saw
```

No otra versión.

---

# 85. Action Versioning

Si una propuesta cambia:

```text
action version increments
```

Approval vieja:

```text
Superseded
```

---

# 86. Multiple Devices

Una approval puede abrirse en otro dispositivo.

Estado vive en backend.

Cuando uno resuelve:

```text
others update via realtime
```

---

# 87. Duplicate Approval Handling

Una approval solo puede resolverse una vez.

Usar transacción/locking para evitar doble ejecución.

---

# 88. Cancellation

Antes de ejecutar:

```text
user can cancel
```

Durante ejecución:

depende de provider.

Después:

solo Undo si existe.

---

# 89. Tool Policies by Context

Ejemplo:

```text
Personal:
Create event → automatic

Clients:
Create event with attendees → ask
```

Policy Engine debe soportarlo.

---

# 90. Tool Policies by Entity

Ejemplo:

```text
RSFA:
Use Firbot Gmail
Send → Always Ask
```

---

# 91. Tool Policies by Schedule

Un Schedule puede agregar restricciones.

Ejemplo:

```text
Weekly Finance Review
→ read only
```

Aunque Finance capability permita writes.

Principio:

```text
least privilege per run
```

---

# 92. Approval Reason

ELISE debe poder explicar por qué pregunta.

Ejemplo:

```text
I'm asking because this email will be sent to an external recipient.
```

No usar explicaciones vagas.

---

# 93. Trust Through Predictability

El usuario debe aprender:

```text
what ELISE does automatically
what ELISE asks about
```

Cambios frecuentes e inexplicables destruyen confianza.

Defaults deben ser consistentes.

---

# 94. MVP Tool Scope

Tools iniciales cubren al menos:

```text
Email
Calendar
Tasks
Habits
Lists
Finance
Goals
Notes
Knowledge
Web Search
Connections
Schedules
Notifications
Approvals
```

No todas necesitan la misma profundidad desde la primera iteración.

---

# 95. MVP Approval Scope

Incluye:

```text
inline approvals
approval center
Always Ask
Ask When Uncertain
Allow Automatically
approval expiration
approval audit
realtime updates
background waits
remember decision
edit before approve
```

---

# 96. Post-MVP Scope

```text
team approvals
multi-person approvals
admin policies
approval delegation
advanced risk engine
custom tool marketplace
financial execution approvals
enterprise policy templates
cross-system transactional workflows
```

---

# 97. What ELISE Must Not Do

Avoid:

- giving AI raw provider credentials;
- letting AI bypass policy;
- executing ambiguous writes;
- claiming an action succeeded before provider confirmation;
- blind retries on external writes;
- approving changed payloads with old approvals;
- exposing every tool in every run;
- hiding which account/provider received a write;
- treating scheduled jobs as exempt from approvals;
- using free-form model text as executable action payload without validation.

---

# 98. Architecture Summary

```text
User Intent
    ↓
AI proposes Tool
    ↓
Tool Registry
    ↓
Schema Validation
    ↓
Context + Provider Resolution
    ↓
Permission Check
    ↓
Risk + Policy
    ↓
Clarification?
    ↓
Approval?
    ↓
Execute
    ↓
Provider Result
    ↓
Persist Action + Audit
    ↓
Confirm to User
```

---

# 99. North Star

> **ELISE should be capable enough to act, disciplined enough to ask, and transparent enough to trust.**
>
> Tools define what ELISE can do.
>
> Policies define what ELISE may do.
>
> Approvals keep important decisions with the user.
>
> Execution results define what actually happened.
