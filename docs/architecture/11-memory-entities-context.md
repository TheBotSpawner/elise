# ELISE — Memory, Entities & Context

**Document:** `11-memory-entities-context.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE representa memoria persistente, entidades del mundo del usuario, contexto activo y relaciones entre datos para construir respuestas y acciones más relevantes sin mezclar conceptos distintos como Knowledge, Rules, conversation history y structured data.

---

# 1. Vision

ELISE debe sentirse como una inteligencia continua.

Para lograrlo no alcanza con guardar conversaciones.

El sistema necesita entender:

- quién es el usuario;
- qué personas conoce;
- qué empresas y proyectos existen;
- qué herramientas utiliza;
- qué preferencias tiene;
- qué contexto está activo;
- qué decisiones previas siguen siendo relevantes;
- qué información debería recordar;
- qué información debería recuperar desde Knowledge;
- qué reglas explícitas debe respetar.

La experiencia objetivo es que el usuario pueda hablar naturalmente sin repetir contexto todo el tiempo.

---

# 2. Core Separation

ELISE debe mantener separados estos conceptos:

```text
Conversation
Knowledge
Memory
Rules
Entities
Structured Data
Active Context
```

Aunque se relacionen entre sí, no son equivalentes.

---

# 3. Conversation

Conversation representa el intercambio reciente o histórico entre usuario y ELISE.

Ejemplo:

```text
User:
"Preparame la reunión con Rod."

ELISE:
...
```

Conversation sirve para:

- continuidad inmediata;
- pronombres;
- referencias recientes;
- historial;
- búsqueda posterior.

No debe convertirse automáticamente en memoria persistente.

---

# 4. Knowledge

Knowledge representa información con fuente identificable.

Ejemplos:

```text
Proposal.pdf
Notion page
Google Drive document
ELISE Note
```

Knowledge responde:

> “¿Qué dice esta fuente?”

Memory responde:

> “¿Qué aprendió ELISE sobre mí o mi contexto?”

---

# 5. Memory

Memory representa contexto persistente que ELISE aprendió y que puede ser útil en futuras interacciones.

Ejemplos:

```text
Leo suele planificar el día siguiente la noche anterior.
Firbot es una empresa del usuario.
RSFA es un cliente relacionado con trabajo.
El usuario prefiere que los scheduled results no sean invasivos.
```

Memory no debe ser un dumping ground de todo lo hablado.

---

# 6. Rules

Rules son instrucciones explícitas y normativas.

Ejemplo:

```text
"Never send an email without asking me first."
```

Esto no es memory.

Es una regla.

Las reglas deben tener prioridad operativa mayor que preferencias inferidas.

---

# 7. Entities

Entities representan objetos persistentes importantes en el mundo del usuario.

Ejemplos:

```text
Person
Company
Client
Project
Course
Subject
Account
Provider
Location
Goal
```

Una entidad sirve como punto común entre distintas capabilities.

---

# 8. Active Context

Active Context representa aquello que probablemente importa ahora.

Ejemplo:

```text
Active workspace:
Personal

Active project:
ELISE

Active Knowledge Space:
Architecture

Recent entity:
Firbot
```

El contexto activo puede cambiar rápidamente.

No debe almacenarse como memory permanente salvo que exista motivo.

---

# 9. Context Package

Cada request de ELISE construye dinámicamente un paquete de contexto.

Ejemplo:

```text
ContextPackage

user
workspace
conversation
active_context
relevant_entities
relevant_memory
rules
knowledge_evidence
structured_data
available_capabilities
permissions
recent_tool_results
```

No enviar todos los datos del usuario a cada request.

---

# 10. Context Builder

El `Context Builder` decide qué información incluir.

Inputs:

```text
current message
conversation
active UI context
entities
rules
memory
available data
tool results
```

Output:

```text
minimal relevant context
```

Principio:

> **Context should be assembled, not accumulated.**

---

# 11. Why Context Must Be Dynamic

Un prompt global gigante genera:

- costo;
- latencia;
- ruido;
- contradicciones;
- pérdida de relevancia;
- mayor riesgo de filtrar contexto irrelevante.

ELISE debe recuperar solo lo que importa para cada interacción.

---

# 12. Memory Categories

Memory puede organizarse conceptualmente en categorías.

Ejemplos:

```text
Preferences
Personal Context
Work Context
Relationships
Recurring Behaviors
Communication Preferences
Workflow Preferences
Stable Facts
```

Estas categorías ayudan al retrieval y a la UI.

---

# 13. Preference Memory

Ejemplos:

```text
Prefers concise work summaries.
Plans tomorrow the evening before.
Likes proactive suggestions but not invasive notifications.
Prefers English documentation for some technical contexts.
```

Estas preferencias pueden ser:

- explicit;
- inferred;
- user-edited.

---

# 14. Stable Fact Memory

Ejemplos:

```text
Firbot is the user's company.
ELISE is an active project.
RSFA is a work client.
```

Solo hechos suficientemente estables deben tratarse como persistent memory.

---

# 15. Ephemeral Context Is Not Memory

Ejemplo:

```text
"I am at a café right now."
```

Normalmente es contexto temporal.

No debería convertirse en memory persistente.

Otro ejemplo:

```text
"I'm working on the finance import this afternoon."
```

Puede ser útil durante la sesión pero no necesariamente dentro de semanas.

---

# 16. Memory Creation

Memory puede originarse de:

```text
explicit user statement
repeated behavior
confirmed inference
important recurring relationship
manual user edit
```

El sistema debe ser conservador.

No memorizar todo.

---

# 17. Explicit Memory

Caso:

> “Recordá que para Firbot siempre uso la cuenta de Gmail del trabajo.”

Esto puede producir:

```text
Memory / Preference:
Firbot email context
→ Work Gmail
```

Dependiendo del efecto operativo también puede convertirse en una Rule o Binding preference.

---

# 18. Inferred Memory

Ejemplo:

El usuario planifica varias veces el día siguiente por la noche.

ELISE puede inferir:

```text
Likely preference:
Daily planning happens in the evening.
```

Las inferencias deben tener:

```text
confidence
evidence
last_confirmed
```

Las inferencias de baja confianza no deben gobernar acciones sensibles.

---

# 19. Memory Confidence

Modelo conceptual:

```text
Memory

confidence
source_type
evidence_count
confirmed
```

Ejemplo:

```text
explicit user statement
→ high confidence

single inferred behavior
→ low confidence
```

---

# 20. Memory Strength

Además de confidence puede existir persistencia semántica.

Ejemplo:

```text
Temporary
Useful
Stable
Pinned
```

Esto ayuda a decidir retention.

---

# 21. Memory Decay

Algunas memories pierden valor con el tiempo.

Ejemplo:

```text
Current project priority
```

puede dejar de ser válida.

Otras son más estables:

```text
Preferred language
```

El sistema debe permitir:

- aging;
- refresh;
- confirmation;
- replacement.

---

# 22. Conflicting Memory

Si nueva información contradice una memory anterior:

```text
old:
Morning planning preferred

new:
User explicitly says they now plan at night
```

La información explícita más reciente debe prevalecer.

No conservar ambas como verdades activas sin resolver.

---

# 23. Memory Provenance

Cada memory debería registrar de dónde provino.

Modelo conceptual:

```text
Memory

id
workspace_id
type
content
source_type
source_reference
confidence
created_at
updated_at
last_used_at
confirmed_at
status
```

Esto permite auditoría y corrección.

---

# 24. User Control Over Memory

El usuario debe poder:

- ver memoria relevante;
- corregirla;
- indicar que algo no debe utilizarse;
- reemplazar preferencias;
- desactivar categorías futuras si se implementa.

La UX exacta puede ser progresiva.

---

# 25. Memory Should Not Be Hidden Authority

ELISE no debe actuar de forma extraña basándose en una memory invisible.

Cuando una memory materialmente cambia una acción, puede ser útil mostrar:

```text
Using your Firbot work account
```

o permitir inspeccionar por qué tomó una decisión.

---

# 26. Entities as Shared Context

Entities conectan diferentes sistemas.

Ejemplo:

```text
Entity:
RSFA

Relationships:
├── Knowledge Space
├── Email threads
├── Tasks
├── Finance transactions
├── Calendar meetings
├── Notes
└── Projects
```

Esto permite contexto cross-capability.

---

# 27. Entity Types

Tipos iniciales potenciales:

```text
Person
Organization
Client
Project
Workspace
Course
Subject
Location
Account
Goal
Custom
```

No es necesario soportar todos como UI explícita desde MVP.

---

# 28. Person Entity

Modelo conceptual:

```text
Person

id
workspace_id
name
aliases
emails
phones
organization links
relationship
metadata
```

Ejemplo:

```text
Rod Schubert
→ RSFA
→ email
→ meetings
→ related Knowledge
```

---

# 29. Organization Entity

Ejemplos:

```text
Firbot
RSFA
Client X
UTN
```

Modelo conceptual:

```text
Organization

name
aliases
type
related people
related projects
related Knowledge Spaces
```

---

# 30. Project Entity

Project representa trabajo con continuidad.

Ejemplo:

```text
ELISE
Mortgage Application
Client Automation
```

Puede relacionarse con:

```text
Tasks
Knowledge
Calendar
Emails
Finance
Notes
Goals
```

---

# 31. Entity Aliases

Las entidades deben soportar aliases.

Ejemplo:

```text
Robert Schubert
Rod
Rod Schubert
```

pueden referir a la misma entidad.

Otro ejemplo:

```text
Firbot
Firbot Solutions
```

---

# 32. Entity Resolution

Cuando ELISE encuentra nombres en texto:

```text
"Rod"
```

debe intentar resolver:

```text
existing entity
```

antes de crear una nueva.

Signals:

```text
name
email
organization
recent context
aliases
source links
```

---

# 33. Entity Resolution Confidence

Casos:

```text
high confidence
→ resolve automatically

medium confidence
→ use cautiously

low confidence
→ ask
```

Ejemplo:

> “Mandale esto a Martín.”

Si existen dos personas llamadas Martín:

```text
ask user
```

---

# 34. Entity Merge

El sistema debe poder fusionar duplicados.

Ejemplo:

```text
Rod
Rod Schubert
rod@rsfa...
```

pueden terminar como una sola entidad.

Merge debe preservar:

- references;
- aliases;
- links;
- history.

---

# 35. Entity Split

También debe ser posible corregir un merge incorrecto.

Nunca asumir que entity resolution es infalible.

---

# 36. Entity Relationships

Entities pueden relacionarse entre sí.

Ejemplos:

```text
Person → works_at → Organization
Project → belongs_to → Client
Person → participates_in → Project
Goal → relates_to → Project
```

No hace falta construir un graph database en MVP.

PostgreSQL relacional es suficiente inicialmente.

---

# 37. Relationship Metadata

Una relación puede contener:

```text
type
source
confidence
created_at
confirmed
```

Ejemplo:

```text
Rod
works_at
RSFA
```

---

# 38. Entity Graph

Conceptualmente:

```text
Leo
├── owns → Firbot
├── studies_at → UTN
└── works_with → RSFA

Firbot
├── has_project → ELISE
└── has_client → Client X
```

Este graph ayuda al Context Builder.

---

# 39. Knowledge Entity Linking

Knowledge puede asociarse con entities.

Ejemplo:

```text
Proposal.pdf
→ Client X
→ Project Y
```

La relación puede provenir de:

- location in Space;
- explicit user assignment;
- AI extraction;
- provider metadata.

---

# 40. Email Entity Linking

Emails pueden relacionarse con:

```text
Person
Organization
Project
Client
```

Ejemplo:

```text
rod@rsfa.co.nz
→ Rod
→ RSFA
```

Esto mejora meeting prep y client brief.

---

# 41. Calendar Entity Linking

Eventos pueden vincularse con:

```text
people
organizations
projects
locations
```

Esto permite detectar:

```text
meeting with Client X
```

y traer contexto automáticamente.

---

# 42. Structured Data Entity Linking

Tasks, Notes, Goals y Finance también pueden vincularse con entidades.

Ejemplo:

```text
Transaction
→ Firbot

Task
→ ELISE Project

Note
→ RSFA
```

---

# 43. Active Entity Context

Si el usuario está navegando:

```text
Knowledge
→ RSFA
```

ELISE puede establecer:

```text
active_entity = RSFA
```

Luego:

> “¿Qué tengo pendiente?”

puede priorizar tareas relacionadas con RSFA.

---

# 44. Context Sources

Context puede provenir de:

```text
current message
conversation history
active UI route
selected Knowledge Space
selected entity
current workspace
recent tool results
calendar event
location
time
device context
```

No todos deben persistirse.

---

# 45. UI Context

La interfaz puede comunicar contexto al runtime.

Ejemplo:

```text
route:
Knowledge / RSFA

selected_document:
Mortgage Process.pdf
```

Pregunta:

> “Resumime esto.”

No necesita entity inference compleja.

El contexto UI ya indica el scope.

---

# 46. Temporal Context

El contexto puede incluir:

```text
current date
current time
timezone
relative dates
```

Esto es clave para:

```text
today
tomorrow
next week
before the meeting
```

Debe resolverse determinísticamente.

---

# 47. Location Context

Futuro:

```text
current location
```

puede utilizarse temporalmente para:

- nearby search;
- parking;
- restaurants;
- commute;
- weather.

No se convierte automáticamente en persistent memory.

---

# 48. Device Context

Futuro contexto útil:

```text
desktop
mobile
voice session
driving mode
```

Esto puede cambiar la presentación o longitud de respuesta.

Ejemplo:

```text
voice + mobile
→ concise spoken answer
```

---

# 49. Workspace Context

Workspace define frontera primaria de datos.

Ejemplo:

```text
Personal
Future: Firbot Team
```

El Context Builder nunca debe mezclar workspaces sin autorización explícita.

---

# 50. Conversation Context Window

No hace falta enviar toda la conversación completa al modelo.

Estrategia posible:

```text
recent messages
+
conversation summary
+
relevant older turns
```

Esto reduce tokens.

---

# 51. Conversation Summary

Conversaciones largas pueden mantener un summary estructurado.

Ejemplo:

```text
Conversation Summary

current objective
decisions
open questions
relevant entities
important constraints
```

Debe actualizarse cuidadosamente.

---

# 52. Conversation Search

Historial antiguo puede recuperarse cuando sea relevante.

Ejemplo:

> “¿Qué habíamos decidido sobre el logo?”

ELISE puede buscar conversaciones relacionadas con ELISE branding.

Conversation history no necesita estar siempre en contexto.

---

# 53. Memory Retrieval

Memory retrieval puede utilizar:

```text
category
entity links
keywords
semantic similarity
recency
importance
confidence
```

No todas las memories se agregan a cada prompt.

---

# 54. Rule Retrieval

Rules se recuperan según:

```text
capability
provider
connection
context
entity
operation
```

Ejemplo:

```text
Email send
→ retrieve Email rules
```

No enviar reglas de Finance si el usuario pregunta por un documento.

---

# 55. Context Priority

Orden conceptual de autoridad:

```text
Hard security policy
Explicit current user instruction
Explicit Rules
Current confirmed structured data
Explicit source evidence
Confirmed Memory
Inferred Memory
Model inference
```

Los niveles superiores prevalecen en conflictos.

---

# 56. Current Instruction Overrides Preference

Ejemplo:

Memory:

```text
User prefers concise answers.
```

Current message:

> “Explicamelo con mucho detalle.”

La instrucción actual gana.

---

# 57. Rules Override Inferred Preferences

Ejemplo:

Inferred:

```text
User often allows event creation.
```

Rule:

```text
Always ask before inviting external attendees.
```

La Rule gana.

---

# 58. Knowledge Does Not Override Current Live Data Automatically

Ejemplo:

Knowledge document dice:

```text
Project status = Planned
```

pero live structured source dice:

```text
Project status = Active
```

ELISE debe considerar freshness/source semantics.

No mezclar sin indicar diferencia.

---

# 59. Context Budgeting

Cada Context Package debe respetar un budget.

Posible distribución dinámica:

```text
system behavior
current conversation
rules
memory
entities
knowledge evidence
tool results
```

La distribución depende del request.

---

# 60. Context Compression

Cuando haya demasiada información:

- summarize;
- deduplicate;
- rank;
- remove redundant metadata;
- retain provenance references.

No truncar ciegamente lo más antiguo si sigue siendo relevante.

---

# 61. Context Debugging

Durante desarrollo debe existir una vista técnica que permita inspeccionar:

```text
active context
selected memories
selected rules
selected entities
knowledge chunks
tools available
provider bindings
```

No necesariamente visible al usuario final.

Es crítica para debugging.

---

# 62. Memory UI

La UI futura puede ofrecer:

```text
What ELISE knows about you
```

Categorías:

```text
Preferences
Work
Personal
Relationships
Workflow
```

Acciones:

```text
Edit
Correct
Don't use
```

No necesita ser una feature protagonista del MVP.

---

# 63. Entity UI

Las entities pueden aparecer de forma contextual.

Ejemplo:

```text
Client: RSFA

Recent:
• 2 emails
• 1 upcoming meeting
• 3 open tasks
• 14 knowledge items
```

No es necesario construir un CRM completo.

---

# 64. Automatic Entity Creation

ELISE puede crear entities automáticamente cuando existe confianza suficiente.

Ejemplo:

nuevo cliente mencionado repetidamente junto a email/domain específico.

Sin embargo, debe evitar crear cientos de entidades irrelevantes.

---

# 65. Entity Importance

Puede existir una señal de importancia.

Signals:

```text
interaction frequency
recent activity
explicit pin
number of linked objects
active projects
```

Esto ayuda al ranking contextual.

---

# 66. Memory Importance

Memories también pueden tener una prioridad.

Ejemplo:

```text
High:
User's default planning workflow

Low:
Temporary preference mentioned once
```

---

# 67. Memory Deduplication

Evitar almacenar:

```text
User likes concise answers
User prefers concise responses
User wants short answers
```

como tres memories independientes.

El sistema debe consolidar.

---

# 68. Memory Updates

Cuando un hecho evoluciona:

```text
old
→ superseded

new
→ active
```

No borrar necesariamente history, pero retrieval debe priorizar la versión actual.

---

# 69. Memory Privacy

Memory puede contener información personal.

Debe respetar:

- workspace isolation;
- privacy settings;
- deletion requests;
- retention policies;
- no exposure to unrelated users.

---

# 70. Memory and Sensitive Data

ELISE debe evitar inferir o persistir innecesariamente categorías altamente sensibles.

Solo conservarlas cuando:

- el usuario lo necesita;
- existe propósito claro;
- la política del producto lo permite.

El sistema debe ser conservador por diseño.

---

# 71. Context and Approvals

Context puede reducir ambigüedad, pero no debe eliminar approvals obligatorias.

Ejemplo:

Context sabe que:

```text
Firbot → Gmail Work
```

Eso puede resolver la cuenta.

Pero si:

```text
email.send → Always Ask
```

debe seguir pidiendo aprobación.

---

# 72. Context and Provider Resolution

Context alimenta el Provider Resolver.

Ejemplo:

```text
Message:
"Respondé a Rod."

Entities:
Rod → RSFA

Context:
Work

Bindings:
Gmail Personal
Outlook RSFA

Resolver:
Outlook RSFA
```

---

# 73. Context and Planning

Daily Planning puede utilizar:

```text
Calendar
Tasks
Habits
Goals
Planning preferences
Energy/time preferences
Rules
```

No necesita acceso indiscriminado a todo Knowledge.

---

# 74. Context and Morning Brief

Morning Brief puede construir un package especializado.

Ejemplo:

```text
today
calendar
important email
tasks
habit progress
goals
news interests
user brief configuration
```

No reutilizar un prompt genérico gigantesco.

---

# 75. Context and Study

Study Context:

```text
active subject
selected Knowledge Space
exam date
progress
weak topics
study preferences
```

No incluir work entities salvo que exista necesidad explícita.

---

# 76. Context and Work

Client/Project Brief:

```text
client entity
project entities
recent emails
meetings
open tasks
recent Knowledge changes
commitments
decisions
```

Esto permite respuestas ricas sin crear un agente separado por cliente.

---

# 77. Model Inputs Must Be Traceable

Cuando sea posible, el runtime debería poder identificar:

```text
which memory was included
which entity relationship was used
which rule affected behavior
which knowledge source supported answer
```

Esto mejora confianza y debugging.

---

# 78. Suggested Data Entities

Tablas potenciales:

```text
memories
memory_sources
entities
entity_aliases
entity_relationships
entity_links
conversation_summaries
context_preferences
```

El schema final se define en `16-data-model.md`.

---

# 79. Memory Service Boundary

Application code debe interactuar mediante servicios como:

```text
getRelevantMemories(...)
createMemory(...)
updateMemory(...)
supersedeMemory(...)
searchMemories(...)
```

No consultar tablas arbitrariamente desde UI o agent prompts.

---

# 80. Entity Service Boundary

Servicios conceptuales:

```text
resolveEntity(...)
findEntities(...)
createEntity(...)
mergeEntities(...)
linkEntity(...)
getEntityContext(...)
```

---

# 81. Context Builder Boundary

Interfaz conceptual:

```ts
buildContext({
  userId,
  workspaceId,
  conversationId,
  message,
  activeUiContext,
  requestedCapabilities
})
```

Output:

```text
ContextPackage
```

---

# 82. Context Package Must Be Immutable Per Run

Una vez construido para una AI run concreta, debe tratarse como snapshot.

Si el contexto cambia durante el run:

```text
new run
or explicit update
```

Esto mejora reproducibilidad.

---

# 83. Tool Results Become Temporary Context

Ejemplo:

```text
calendar.search(...)
```

devuelve eventos.

Estos resultados pueden incluirse en la misma ejecución.

No necesariamente deben transformarse en memory.

---

# 84. Memory from Tool Results

Solo ciertos resultados deberían convertirse en memory.

Ejemplo:

```text
Repeatedly confirmed client relationship
```

puede generar memory/entity link.

Pero:

```text
Today's calendar
```

no debe memorizarse como preferencia.

---

# 85. User Corrections

Correcciones deben tener alta prioridad.

Ejemplo:

> “No, Martín López no trabaja en Firbot.”

El sistema debe:

```text
correct relationship
invalidate conflicting inference
avoid repeating mistake
```

---

# 86. User Forget / Do Not Use

El sistema debe poder marcar información como:

```text
inactive
suppressed
deleted
```

según la acción disponible.

A nivel de producto, ELISE debe respetar explícitamente pedidos del usuario de no utilizar determinada información.

---

# 87. Relevance Over Quantity

Una buena memory system no es la que guarda más.

Es la que trae:

```text
the right thing
at the right time
for the right reason
```

---

# 88. MVP Scope

MVP debería incluir:

```text
conversation history
conversation summaries
basic persistent memory
memory confidence/provenance
basic memory retrieval
entities
aliases
entity relationships
entity linking
active UI context
Context Builder
rule-aware context
knowledge-aware context
provider resolution context
workspace isolation
basic correction flows
```

---

# 89. Post-MVP Scope

Futuro:

```text
advanced memory management UI
automatic memory decay
user-controlled memory categories
knowledge graph visualization
team entities
shared organizational memory
cross-workspace controlled context
location patterns
behavioral personalization
more advanced entity resolution
```

---

# 90. What ELISE Must Not Do

Avoid:

- stuffing all user data into every prompt;
- treating conversation history as memory automatically;
- treating memory as verified Knowledge;
- treating inferred preference as explicit Rule;
- creating entities for every noun;
- resolving ambiguous people silently;
- allowing memory to override current instructions;
- persisting temporary context forever;
- exposing memory across workspaces;
- allowing AI-generated relationships to become unquestioned truth.

---

# 91. Architecture Summary

```text
Current Request
      ↓
Active UI Context
      ↓
Conversation
      ↓
Entity Resolution
      ↓
Relevant Memories
      ↓
Relevant Rules
      ↓
Knowledge / Structured Data
      ↓
Capability / Provider Context
      ↓
Context Builder
      ↓
Context Package
      ↓
AI Runtime
```

---

# 92. North Star

> **ELISE should remember what matters, understand what things are connected, and forget what is merely noise.**
>
> Memory gives continuity.
>
> Entities give structure.
>
> Context gives relevance.
>
> Rules give control.
>
> Knowledge gives evidence.

---

# Implementation note (2026-10-01)

Context Profiles, lightweight people/organization entities, the active context of an interaction, Study and Work Intelligence are implemented as described in [ADR-016](../decisions/ADR-016-context-profiles-study-work.md). Entity aliases, emails and domains are arrays on `entities` rather than separate `entity_aliases` / `entity_relationships` tables (§28-37); those can be extracted later without changing the tools.
