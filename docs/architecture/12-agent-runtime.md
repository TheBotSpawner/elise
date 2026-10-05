# ELISE — Agent Runtime

**Document:** `12-agent-runtime.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE interpreta solicitudes, construye contexto, selecciona capabilities y tools, coordina acciones, utiliza modelos de IA y mantiene una sola inteligencia coherente sin convertir cada feature en un agente independiente.

---

# 1. Agent Runtime Vision

ELISE debe sentirse como una sola inteligencia.

El usuario no debería pensar:

```text
Email Agent
Calendar Agent
Finance Agent
Study Agent
Notion Agent
```

Debe pensar:

```text
ELISE
```

Internamente, ELISE puede utilizar:

- tools;
- skills;
- capability adapters;
- specialized profiles;
- background jobs;
- subagents cuando realmente aporten valor.

Pero esa complejidad debe permanecer detrás de una identidad unificada.

---

# 2. Core Architectural Decision

El MVP tendrá un runtime principal:

```text
ELISE Core Agent
```

Su responsabilidad será:

```text
understand intent
build context
select capabilities
invoke tools
respect rules
request approvals
coordinate background work
generate final response
```

No se creará un agente diferente por cada integración o caso de uso.

---

# 3. Runtime Flow

Flujo general:

```text
User Input
    ↓
Request Context
    ↓
Intent / Context Routing
    ↓
Context Builder
    ↓
Rules + Permissions
    ↓
Available Capabilities
    ↓
AI Runtime
    ↓
Tool Calls
    ↓
Policy / Approval Checks
    ↓
Execution
    ↓
Tool Results
    ↓
Final Synthesis
    ↓
Response / Realtime UI
```

---

# 4. Runtime Inputs

Cada ejecución puede recibir:

```text
user message
conversation id
workspace id
active UI context
voice/text mode
current date/time
timezone
selected Knowledge Space
selected entity
selected document
```

Luego se enriquece con contexto relevante.

---

# 5. Context Package

Antes de llamar al modelo se construye un `ContextPackage`.

Conceptualmente:

```text
ContextPackage

User
Workspace
Current request
Recent conversation
Conversation summary
Active context
Relevant entities
Relevant memories
Relevant rules
Knowledge evidence
Structured data
Available capabilities
Available tools
Permissions
Provider bindings
Recent tool results
```

No todos los campos estarán presentes en cada request.

---

# 6. Context Builder

El `Context Builder` es responsable de decidir qué información llega al modelo.

Debe:

- limitar contexto;
- priorizar relevancia;
- preservar provenance;
- aplicar scope;
- evitar datos innecesarios;
- incluir rules aplicables;
- incluir capabilities permitidas.

No debe ser simplemente:

```text
load everything
```

---

# 7. One Intelligence, Multiple Skills

> Implementado para los usuarios como **Métodos** (procedural memory, scoped, versionados):
> ver ADR-040.

ELISE puede tener Skills internas.

Ejemplos:

```text
Email Copilot
Daily Planning
Morning Brief
Meeting Prep
Study Tutor
Client Brief
Finance Analysis
Knowledge Research
```

Una Skill es:

```text
behavioral configuration
+
tool set
+
context strategy
+
output expectations
```

No necesariamente es un agente separado.

---

# 8. Skill Example — Meeting Prep

```text
MeetingPrepSkill

Capabilities:
Calendar
Email
Knowledge
Tasks

Context:
Meeting
Participants
Client entity
Recent activity

Output:
Concise preparation brief
```

El mismo ELISE Core ejecuta esta experiencia.

---

# 9. Skill Example — Study

Study puede requerir un comportamiento más especializado.

Ejemplo:

```text
StudyTutorProfile

Behavior:
Socratic when appropriate
Ask questions
Track answers
Use selected Knowledge Space
Avoid unsupported material
```

Esto puede implementarse como un specialized profile sobre el mismo runtime.

---

# 10. Agent Profiles

Un Agent Profile puede definir:

```text
instructions
allowed tools
context policy
response style
interaction loop
```

Ejemplos:

```text
Default Elise
Study Tutor
Research Mode
Future specialized profiles
```

La existencia de un profile no crea una nueva identidad para el usuario.

---

# 11. Subagents

Los subagents se utilizarán únicamente cuando exista beneficio real.

Buenos casos:

```text
parallel research
large comparison
independent document analysis
complex decomposition
```

Malos casos:

```text
one subagent for Gmail
one subagent for Calendar
one subagent for each customer
```

---

# 12. Subagent Rule

Principio:

> **Use tools first. Use specialized profiles second. Use subagents only when decomposition genuinely improves the result.**

Esto evita:

- complejidad;
- costos;
- latencia;
- debugging difícil;
- comportamiento inconsistente.

---

# 13. AI Provider Abstraction

OpenAI será el provider inicial.

El runtime debe depender de una interfaz interna.

Conceptualmente:

```ts
interface AIProvider {
  generate(...)
  stream(...)
  runWithTools(...)
}
```

Implementación inicial:

```text
OpenAIProvider
```

Futuro:

```text
AnthropicProvider
OtherProvider
```

---

# 14. OpenAI Agents SDK

El MVP puede utilizar OpenAI Agents SDK dentro de:

```text
src/infrastructure/ai/openai/
```

No debe filtrarse hacia el Core.

Correcto:

```text
ELISE Core
→ AIRuntime interface
→ OpenAI adapter
→ Agents SDK
```

Incorrecto:

```text
Entire application
→ imports OpenAI Agents SDK directly
```

---

# 15. Model Selection

ELISE debe poder soportar distintos modelos según tarea.

Ejemplo futuro:

```text
fast model
→ classification / simple extraction

strong model
→ planning / complex reasoning

embedding model
→ retrieval
```

El usuario normal no necesita elegir modelos.

---

# 16. Model Policy

El modelo se selecciona mediante configuración interna según:

```text
task complexity
latency target
cost
tool requirements
context length
quality requirements
```

No hardcodear nombres de modelo en feature code.

---

# 17. Tool Model

Una Tool representa una operación disponible para la IA.

Ejemplos:

```text
email.search
email.createDraft
calendar.list
calendar.createEvent
tasks.create
knowledge.search
finance.query
habits.checkIn
web.search
```

---

# 18. Tool Naming

Los nombres deben describir capabilities, no providers.

Preferir:

```text
email.search
calendar.createEvent
```

sobre:

```text
gmailSearch
googleCalendarCreate
```

El Provider Resolver determina implementación.

---

# 19. Tool Schema

Cada tool debe tener:

```text
name
description
input schema
output schema
risk level
required permissions
capability
operation type
```

Inputs validados con schema estricto.

---

# 20. Tool Execution Boundary

El modelo nunca ejecuta APIs directamente.

Flujo:

```text
AI
 ↓
Tool request
 ↓
ELISE Tool Runtime
 ↓
Validation
 ↓
Capability Resolver
 ↓
Permission Check
 ↓
Approval Check
 ↓
Provider
 ↓
Normalized Result
```

---

# 21. Tool Results

Los resultados deben ser estructurados.

Ejemplo:

```text
CalendarSearchResult

events
source
connection
time range
```

AI recibe solo información necesaria y segura.

---

# 22. Read Tools

Read tools pueden ejecutarse automáticamente cuando:

- están autorizadas;
- son seguras;
- no modifican estado;
- no exponen scope incorrecto.

Ejemplos:

```text
calendar.list
email.search
knowledge.search
tasks.list
```

---

# 23. Write Tools

Write tools pasan por policy engine.

Ejemplos:

```text
email.send
calendar.createEvent
finance.createTransaction
tasks.delete
```

Resultado:

```text
execute
or
request approval
```

---

# 24. Approval Integration

El modelo puede proponer una acción.

No decide por sí mismo si la acción está permitida.

Ejemplo:

```text
AI:
email.send(...)

Policy:
Always Ask

Runtime:
create PendingApproval
```

---

# 25. Deterministic Policies

Siempre deben ser código determinístico:

```text
authorization
workspace isolation
provider ownership
risk classification
approval policy
idempotency
schema validation
financial calculations
date validation
rate limits
```

No delegarlos al modelo.

---

# 26. Intent Routing

El runtime puede clasificar la intención antes de construir contexto profundo.

Ejemplos:

```text
chat/general
calendar
email
knowledge
planning
study
finance
scheduled task
multi-capability
```

El routing puede usar IA ligera o reglas.

---

# 27. Routing Is Not Agent Selection

Ejemplo:

```text
Intent:
Meeting Prep
```

No significa:

```text
launch MeetingPrepAgent
```

Significa:

```text
activate MeetingPrepSkill
load relevant context
expose relevant capabilities
```

---

# 28. Multi-Capability Requests

ELISE debe manejar requests que cruzan dominios.

Ejemplo:

> “Buscá el mail de Juan, revisá cuándo estoy libre y armame una reunión.”

Flow:

```text
Email Search
↓
Calendar Availability
↓
Create Event proposal
```

El runtime coordina varias tools dentro de la misma interacción.

---

# 29. Planning

Para requests complejos, el modelo puede producir un plan interno.

Ejemplo:

```text
1. Resolve Juan
2. Find latest email
3. Check calendar
4. Suggest slot
5. Ask before creating event if required
```

El plan no necesita mostrarse completo al usuario.

---

# 30. Tool Loop

El runtime puede ejecutar múltiples ciclos:

```text
Model
→ Tool
→ Result
→ Model
→ Tool
→ Result
→ Final answer
```

Debe existir un límite configurable.

Evitar loops infinitos.

---

# 31. Execution Limits

Cada run debe tener límites como:

```text
max tool calls
max retries
max runtime
max tokens
max parallel tasks
```

Los límites exactos se definirán durante implementación.

---

# 32. Parallel Tool Calls

Cuando varias lecturas son independientes pueden ejecutarse en paralelo.

Ejemplo Morning Brief:

```text
Calendar
Email
Tasks
Habits
News
```

pueden consultarse simultáneamente.

Esto reduce latencia.

---

# 33. Sequential Tool Calls

Cuando existe dependencia:

```text
Find client
↓
Resolve email account
↓
Search email
```

debe ejecutarse secuencialmente.

---

# 34. Streaming

Las respuestas de Chat deben utilizar streaming cuando mejore UX.

Ejemplo:

```text
ELISE starts responding
while final formatting continues
```

Sin embargo, no se debe transmitir una conclusión final antes de completar tools necesarias.

---

# 35. Execution State Streaming

También se puede transmitir:

```text
Checking calendar...
Searching email...
Reviewing Knowledge...
```

Esto alimenta la visualización JARVIS-like definida en UI.

---

# 36. Realtime Runtime States

Estados posibles:

```text
Queued
Understanding
Gathering Context
Thinking
Using Tools
Waiting for Approval
Running in Background
Completing
Completed
Failed
Cancelled
```

La UI puede simplificarlos.

---

# 37. Voice Runtime

Voice utiliza el mismo runtime.

```text
Audio
 ↓
Speech input
 ↓
User message
 ↓
ELISE runtime
 ↓
Response
 ↓
Speech output
```

No debe existir lógica de negocio duplicada para Voice.

---

# 38. Voice Interruption

Futuro/según provider:

- user can interrupt;
- stop speaking;
- continue context;
- switch to text.

Conversation state permanece igual.

---

# 39. Background Handoff

Si una operación tarda demasiado para una request interactiva:

```text
Interactive runtime
 ↓
BackgroundRuntime.enqueue(...)
 ↓
return acknowledgement
```

Ejemplo:

```text
"Voy a analizar todos estos documentos. Te aviso cuando esté listo."
```

Luego Trigger.dev completa el trabajo.

---

# 40. Background Jobs Are Not Agents

Trigger.dev ejecuta trabajo.

No representa otra inteligencia.

Ejemplo:

```text
Trigger task
→ calls MeetingPrepService
```

No:

```text
Trigger task
→ invents its own behavior disconnected from ELISE
```

---

# 41. Scheduled Tasks Runtime

Un Schedule contiene configuración estructurada.

Ejemplo:

```text
Morning Brief
Mon-Fri
07:30
```

Cuando dispara:

```text
Trigger.dev
 ↓
ScheduledTaskService
 ↓
ELISE Skill / Application Service
 ↓
Capabilities
 ↓
Result
```

---

# 42. Schedule Prompt Safety

No guardar únicamente un prompt opaco.

Un Schedule debe tener estructura.

Ejemplo:

```text
type
schedule
inputs
capabilities
delivery
instructions
approval policy
```

Puede conservar también instrucciones libres.

---

# 43. Morning Brief Runtime

Morning Brief debe ser principalmente workflow determinístico + síntesis AI.

```text
Fetch configured blocks
 ↓
Normalize
 ↓
Rank
 ↓
Apply preferences
 ↓
AI synthesis
 ↓
Persist result
 ↓
Notify
```

No pedir al agente:

> “Decidí cualquier cosa que quieras hacer.”

---

# 44. Daily Planning Runtime

Planning combina:

```text
Calendar
Tasks
Habits
Goals
Preferences
```

AI propone distribución.

Código valida:

```text
time collisions
durations
working hours
calendar constraints
```

---

# 45. Study Runtime

Study Profile puede controlar:

```text
selected Knowledge Space
question difficulty
session mode
answer evaluation
progress tracking
```

El material factual debe venir de Knowledge cuando el usuario estudia fuentes específicas.

---

# 46. Email Copilot Runtime

Email flows:

```text
read/search
→ safe automatic

draft
→ normally automatic

send
→ policy-controlled
```

Tone/context pueden provenir de:

```text
rules
conversation
client entity
memory
```

---

# 47. Tool Availability

No exponer todas las tools en cada request.

Seleccionar tools según:

```text
intent
active skill
permissions
connected capabilities
context
```

Esto mejora:

- precisión;
- seguridad;
- tokens;
- tool selection.

---

# 48. Capability Availability

Ejemplo:

Usuario no conectó Email.

El runtime no expone:

```text
email.search
email.send
```

Puede exponer:

```text
connection.setup
```

o devolver una acción para conectar la capability.

---

# 49. Missing Capability Behavior

Ejemplo:

> “Buscá el mail que me mandó Juan.”

Sin email conectado:

```text
ELISE:
To do that, connect your email.

[ Connect Gmail ]
```

No inventar resultados.

---

# 50. Error Recovery

Las tools deben devolver errores tipados.

Ejemplo:

```text
AUTH_EXPIRED
PERMISSION_DENIED
RATE_LIMITED
NOT_FOUND
VALIDATION_ERROR
TEMPORARY_PROVIDER_ERROR
```

El runtime decide cómo recuperarse.

---

# 51. Retry Policy

Retries determinísticos para errores transitorios:

```text
network timeout
rate limit
provider temporary error
```

No repetir automáticamente:

```text
invalid input
permission denied
destructive write with uncertain result
```

---

# 52. Write Idempotency

Toda acción que pueda repetirse debe contemplar idempotencia.

Ejemplos:

```text
create event
send message
create transaction
background sync
```

Evitar duplicados si existe retry.

---

# 53. Partial Failure

Multi-tool request:

```text
Calendar ✓
Tasks ✓
Email ✕
```

ELISE puede continuar con información parcial cuando sea útil.

Debe indicar limitación:

```text
I prepared this using your calendar and tasks, but Gmail needs to be reconnected.
```

---

# 54. Tool Confirmation

Después de writes:

```text
✓ Event created
✓ Task added
```

La respuesta debe basarse en resultado real del provider, no en intención del modelo.

---

# 55. Hallucination Boundary

El runtime debe diferenciar:

```text
model-generated language
```

de:

```text
verified tool result
```

Nunca afirmar que una acción ocurrió hasta recibir confirmación.

---

# 56. Prompt Architecture

Las instrucciones del runtime deben ser modulares.

Conceptualmente:

```text
Core ELISE Instructions
+
Active Skill
+
Rules
+
Context
+
Tool definitions
+
Task-specific guidance
```

Evitar un system prompt monolítico gigantesco.

---

# 57. Core Instructions

Core define comportamientos estables:

```text
identity
safety
tool discipline
context discipline
approval awareness
clarification behavior
source awareness
```

---

# 58. Skill Instructions

Ejemplo:

```text
Study
→ teach, test, adapt difficulty

Morning Brief
→ prioritize concise relevance

Planning
→ optimize realistic schedule
```

---

# 59. User Rules Injection

Solo cargar reglas relevantes.

Ejemplo:

```text
Email task
→ email rules

Finance task
→ finance rules
```

No cargar reglas no relacionadas.

---

# 60. Memory Injection

Solo memories relevantes.

Memory puede influir:

- tone;
- defaults;
- context;
- provider choice;
- planning preferences.

No puede saltarse hard policies.

---

# 61. Entity Injection

El runtime puede incluir resumen compacto de entidades relevantes.

Ejemplo:

```text
Alex Morgan
Organization: Client A
Relationship: client contact
```

No incluir el graph entero.

---

# 62. Knowledge Injection

Knowledge llega como evidence chunks con provenance.

Ejemplo:

```text
Source
Section
Relevant text
Version
```

La respuesta debe citar o preservar fuente cuando corresponda.

---

# 63. Tool Result Compression

Resultados grandes pueden resumirse antes del siguiente model turn.

Ejemplo:

```text
500 calendar events
```

no deben enviarse completos si la pregunta solo necesita:

```text
next available slot
```

---

# 64. Deterministic Preprocessing

Antes de usar AI pueden resolverse:

```text
date ranges
filters
totals
calendar conflicts
deduplication
normalization
```

Esto mejora exactitud.

---

# 65. Deterministic Postprocessing

Después de AI:

```text
schema validation
permission validation
date validation
provider compatibility
```

antes de ejecutar writes.

---

# 66. Structured Outputs

Cuando el runtime espera una decisión o plan, preferir outputs estructurados.

Ejemplo:

```text
PlanProposal
TaskExtraction
ProviderResolutionHint
MeetingBriefData
```

No parsear prosa cuando puede usarse schema.

---

# 67. Conversation Persistence

Guardar:

```text
messages
tool calls
tool results references
run IDs
timestamps
```

No guardar secretos.

Tool results sensibles pueden almacenarse de forma resumida o referenciada según política.

---

# 68. Run Identity

Cada ejecución debe tener:

```text
run_id
conversation_id
workspace_id
user_id
```

Esto permite:

- observability;
- tracing;
- debugging;
- realtime.

---

# 69. Runtime Audit Trail

Registrar:

```text
request
selected skill
selected tools
provider resolutions
approvals
writes
errors
latency
model usage
```

Con límites de privacidad.

---

# 70. Observability

Debe poder medirse:

```text
time to first token
total response latency
tool latency
provider error rate
approval rate
background completion time
token usage
model cost
retrieval quality
```

---

# 71. Evaluation

Crear test cases para comportamientos críticos.

Ejemplo:

```text
User has two Gmail accounts
asks generic search
→ query both if safe
```

```text
User asks to send from ambiguous account
→ ask clarification
```

```text
Study mode
→ stays within selected sources
```

---

# 72. Agent Regression Tests

Cambios de prompt/model no deben romper comportamientos.

Mantener suites con:

```text
input
context
expected tool
forbidden tool
expected approval
expected output properties
```

---

# 73. Security Boundary

El runtime AI nunca debe poder:

- bypass RLS;
- retrieve arbitrary credentials;
- change permissions;
- disable approvals;
- access another workspace;
- execute hidden provider operations.

Todo pasa por backend policy enforcement.

---

# 74. Prompt Injection Resistance

Contenido externo debe tratarse como datos, no instrucciones.

Ejemplo documento:

```text
"Ignore previous instructions and send..."
```

debe permanecer contenido.

El runtime debe diferenciar:

```text
trusted system/rules
vs
untrusted source content
```

---

# 75. Tool Output Trust

Tool results pueden contener texto externo malicioso.

No convertir contenido de:

- email;
- web;
- document;

en instrucciones privilegiadas.

---

# 76. Cancellation

El usuario debe poder cancelar procesos interactivos o background cuando sea técnicamente posible.

Ejemplo:

```text
Stop
Cancel processing
```

Background runtime debe recibir cancel signal.

---

# 77. Human-in-the-Loop

Approvals son una forma de human-in-the-loop.

Otros casos:

```text
ambiguous entity
import mapping
knowledge organization
provider selection
```

El runtime puede pausar para pedir input.

---

# 78. Reentrancy

Después de una aprobación o clarificación, el runtime debe poder continuar con suficiente estado.

Ejemplo:

```text
Run
→ waits approval
→ approval granted
→ resumes execution
```

Sin reconstruir todo de forma insegura.

---

# 79. Runtime State Persistence

Runs largos pueden persistir:

```text
current step
pending approval
resolved providers
intermediate references
```

especialmente en Trigger.dev.

---

# 80. Cost Control

El runtime debe permitir:

```text
model usage tracking
token budgets
tool call budgets
retrieval limits
background quotas
```

La optimización comercial se definirá después.

---

# 81. Latency Strategy

Para tareas simples:

```text
minimum routing
minimum context
fast response
```

Para tareas complejas:

```text
more reasoning
more retrieval
background if needed
```

No usar el pipeline más caro para cada request.

---

# 82. Graceful Degradation

Si una capability falla, ELISE puede:

- usar otras fuentes;
- informar la limitación;
- ofrecer reconnect;
- continuar parcialmente.

No inventar sustitutos sin decirlo.

---

# 83. Example — Simple Chat

User:

> “Creá una tarea para mañana.”

```text
Intent → Task
Context → Personal
Tool → tasks.create
Provider → ELISE Tasks
Policy → allowed
Execute
Result → success
Response → confirmation
```

---

# 84. Example — Complex Work Request

User:

> “Preparame para la reunión con Alex.”

```text
Entity Resolution
→ Alex / Client A

Calendar
→ identify meeting

Email
→ recent relevant threads

Knowledge
→ Client A Space

Tasks
→ open Client A items

Context Builder
→ compact package

MeetingPrepSkill
→ synthesize

Response
→ briefing + sources
```

---

# 85. Example — Planning With Write

User:

> “Organizame mañana y subilo al calendario.”

```text
Planning Skill
 ↓
Calendar read
Tasks read
Habits read
Goals read
 ↓
AI proposes schedule
 ↓
Deterministic conflict validation
 ↓
Calendar writes
 ↓
Approval policy
 ↓
Create events
 ↓
Confirm results
```

---

# 86. Example — Schedule Creation

User:

> “Todos los viernes haceme un resumen de mis finanzas.”

```text
Intent
→ Create Schedule

AI extraction
→ recurrence + purpose

Structured preview
→ Friday / Finance Review

User confirms
→ persist Schedule

Trigger.dev
→ future executions
```

---

# 87. Example — Background Research

User:

> “Analizá todos los documentos de este cliente y decime los principales riesgos.”

If large:

```text
Chat runtime
→ identify scope
→ enqueue background analysis
→ return progress state

Trigger.dev
→ retrieve/process
→ AI synthesis
→ persist result
→ notify
```

---

# 88. Suggested Code Boundaries

Conceptual structure:

```text
src/core/agents/
├── runtime.ts
├── context.ts
├── skills.ts
├── tools.ts
├── policies.ts
└── types.ts

src/infrastructure/ai/
├── provider.ts
└── openai/

src/features/chat/
src/features/approvals/
src/features/schedules/
```

Exact implementation may evolve.

---

# 89. MVP Scope

MVP Agent Runtime includes:

```text
one ELISE Core runtime
OpenAI provider
AI provider abstraction
streaming chat
Context Builder integration
tool execution loop
capability-based tools
provider resolution
rules
memory
entities
Knowledge retrieval
structured data tools
approval integration
background handoff
scheduled execution integration
voice-compatible runtime
run tracing
basic evaluation
```

---

# 90. Post-MVP Scope

Future:

```text
additional AI providers
advanced model routing
specialized subagents
parallel research agents
advanced planning
agent marketplace/skills
user-created skills
custom MCP tools
enterprise policy profiles
advanced cost routing
```

---

# 91. What ELISE Must Not Do

Avoid:

- one agent per provider;
- one agent per client;
- giant always-loaded prompts;
- exposing every tool every time;
- allowing AI to authorize itself;
- claiming writes succeeded before confirmation;
- letting external content override system instructions;
- keeping business logic inside provider SDKs;
- making Trigger.dev the agent brain;
- creating complex multi-agent orchestration before it is needed.

---

# 92. North Star

> **ELISE is one intelligence with many capabilities, not many agents pretending to be one product.**
>
> Context determines what matters.
>
> Skills determine how ELISE behaves.
>
> Tools determine what ELISE can do.
>
> Policies determine what ELISE may do.
>
> Providers determine where the action happens.
