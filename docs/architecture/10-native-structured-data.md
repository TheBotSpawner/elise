# ELISE — Native Structured Data

**Document:** `10-native-structured-data.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE modela, almacena, consulta y modifica datos estructurados nativos, cómo conviven con providers externos, cómo se importan datos existentes y cómo estos módulos se integran con Chat, Planning, Morning Brief, Knowledge y Schedules.

---

# 1. Vision

ELISE no debe depender de que cada usuario ya tenga una aplicación externa para organizar su información.

Para dominios simples y estructurados, ELISE ofrecerá módulos nativos oficiales.

MVP:

```text
ELISE Tasks
ELISE Habits
ELISE Lists
ELISE Finance
ELISE Goals
ELISE Notes
```

Estos módulos deben ser útiles directamente desde la interfaz, pero también deben poder operarse desde conversación natural.

Ejemplo:

> “Agregá revisar propuesta mañana.”

> “Hoy entrené.”

> “Gasté 32.000 pesos en supermercado.”

> “Guardá esto como una nota del proyecto.”

La UI y el chat son dos interfaces sobre el mismo modelo de datos.

---

# 2. Why Native Data Exists

ELISE Native cumple varios objetivos.

## Immediate Utility

Un usuario puede empezar sin configurar apps externas.

## Stable Product Experience

ELISE controla:

- schema;
- permissions;
- realtime;
- search;
- relationships;
- history;
- UX.

## Better Cross-Capability Context

Ejemplo:

```text
Goal
 ↓
Habits
 ↓
Tasks
 ↓
Calendar Planning
 ↓
Morning Brief
```

## Migration Path

El usuario puede importar sistemas previos desde:

- spreadsheets;
- CSV;
- Google Sheets;
- exports;
- futuras integrations.

---

# 3. Native Does Not Mean Mandatory

ELISE Native debe coexistir con providers externos.

Ejemplo:

```text
Tasks

├── ELISE Tasks
└── Google Tasks
```

El usuario puede:

- usar solamente ELISE;
- usar solamente un provider externo;
- utilizar ambos;
- asignarlos a contextos diferentes.

No debe existir lock-in obligatorio.

---

# 4. Architectural Principle

Los módulos nativos deben comportarse como providers de capabilities.

Ejemplo:

```text
Task Capability

implementations:
├── EliseTasksProvider
└── GoogleTasksProvider
```

Esto permite que el Core utilice un mismo contrato.

No:

```text
if native:
   special logic
else:
   provider logic
```

Sí:

```text
resolve TaskProvider
→ execute canonical operation
```

---

# 5. Source of Truth

Para un módulo Native:

```text
ELISE / Supabase
→ source of truth
```

Para un provider externo:

```text
External provider
→ source of truth
```

ELISE nunca debe duplicar silenciosamente datos externos como si fueran Native.

---

# 6. Structured Data vs Knowledge

Structured Data y Knowledge no son lo mismo.

Ejemplo:

```text
Task:
"Enviar propuesta"
status = pending
due_at = tomorrow

→ structured data
```

Ejemplo:

```text
Proposal.pdf
→ Knowledge
```

Structured Data se consulta principalmente mediante:

- SQL;
- filters;
- aggregations;
- relationships.

Knowledge utiliza:

- semantic retrieval;
- document search;
- embeddings;
- source citations.

---

# 7. Shared Structured Data Principles

Todos los módulos Native deben seguir principios comunes:

```text
workspace ownership
timestamps
soft delete where useful
auditability
realtime compatibility
entity relationships
import/export readiness
AI-safe write validation
canonical IDs
```

No se debe permitir que el modelo escriba datos arbitrarios sin validación.

---

# 8. Common Metadata

Muchas entidades Native deberían incluir conceptos comunes como:

```text
id
workspace_id
created_by
created_at
updated_at
archived_at
metadata
```

Cuando corresponda:

```text
source
external_reference
entity_links
tags
```

El schema exacto se documentará en `16-data-model.md`.

---

# 9. ELISE Tasks

Tasks representa trabajo accionable.

Modelo conceptual:

```text
Task

id
workspace_id
title
description
status
priority
due_at
start_at
completed_at
list_id
project/entity links
created_at
updated_at
```

Estados iniciales:

```text
Pending
In Progress
Completed
Cancelled
```

---

# 10. Task Operations

Core operations:

```text
createTask
getTask
listTasks
updateTask
completeTask
cancelTask
delete/archiveTask
```

Queries frecuentes:

```text
today
overdue
this week
high priority
by project
by goal
```

---

# 11. Task Natural Language

Ejemplos:

> “Agregá revisar presupuesto mañana.”

Interpretación:

```text
title:
Revisar presupuesto

due_at:
tomorrow

provider:
resolved Task provider
```

> “Ya terminé el informe.”

ELISE:

```text
find likely task
↓
confidence check
↓
complete
```

Si existen varias coincidencias, preguntar.

---

# 12. Tasks and Calendar

Una Task no debe convertirse automáticamente en Calendar Event.

Son conceptos diferentes.

```text
Task
→ something that must be done

Calendar Event
→ reserved time
```

Planning puede proponer:

```text
Task
→ Focus Block
```

y luego crear un evento si el usuario acepta.

---

# 13. ELISE Habits

Habits representa comportamientos recurrentes que el usuario quiere realizar.

Modelo conceptual:

```text
Habit

id
workspace_id
name
description
frequency
target
unit
active
start_date
```

Check-ins:

```text
HabitEntry

habit_id
date/time
value
status
notes
```

---

# 14. Habit Frequencies

El MVP debe soportar al menos:

```text
daily
specific days
weekly target
custom recurrence
```

Ejemplos:

```text
Gym
3 times / week

Read
daily

Run
Tuesday + Saturday
```

La lógica de progreso debe ser determinística.

---

# 15. Habit Progress

Ejemplo:

```text
Gym

Target:
3 / week

Current:
2 / 3
```

ELISE puede interpretar el estado:

> “Te falta una sesión esta semana.”

Pero el cálculo:

```text
2 / 3
```

debe venir del sistema, no del modelo.

---

# 16. Habit Recommendations

ELISE puede utilizar Habits + Calendar para sugerir acciones.

Ejemplo:

```text
Habit:
Gym
2/3 this week

Calendar:
Free Saturday morning
```

Respuesta:

> “Te falta una sesión de gimnasio. Tenés libre el sábado de 10 a 12, ¿querés que reserve un bloque?”

La recomendación es AI-driven.

La disponibilidad es deterministic/provider-driven.

---

# 17. ELISE Lists

Lists permite manejar colecciones simples.

Ejemplos:

```text
Shopping
Books
Ideas
Things to pack
Restaurants to try
```

Modelo conceptual:

```text
List
ListItem
```

No debe convertirse en un sistema excesivamente complejo.

---

# 18. List Operations

```text
createList
addItem
updateItem
complete/checkItem
removeItem
reorder
archiveList
```

Ejemplo:

> “Agregá detergente a la lista del supermercado.”

---

# 19. Lists vs Tasks

Una List Item no necesariamente es una Task.

Ejemplo:

```text
Shopping List
Milk
Bread
Coffee
```

No necesita:

- priority;
- due date;
- task workflow.

El usuario puede convertir una List Item en Task si quiere.

---

# 20. ELISE Finance

Finance representa registros financieros personales o profesionales básicos.

El MVP no busca reemplazar contabilidad bancaria completa.

Debe permitir:

- registrar movimientos;
- clasificar;
- analizar;
- editar;
- importar;
- consultar.

No incluye inicialmente:

- bank sync;
- payments;
- transfers;
- tax filing;
- investment brokerage.

---

# 21. Finance Core Model

Modelo conceptual:

```text
Transaction

id
workspace_id
type
amount
currency
date
account
category
subcategory
counterparty
project/entity
payment_method
status
notes
```

Tipos:

```text
Income
Expense
Transfer
```

`Transfer` puede implementarse en MVP o quedar preparado según complejidad.

---

# 22. Finance Categories

Categories deben ser configurables.

Ejemplos:

```text
Software
Food
Transport
Education
Clients
Marketing
Subscriptions
Travel
```

ELISE puede sugerir categoría con IA.

La categoría final debe ser validada antes de persistir cuando la confianza sea baja.

---

# 23. Finance Natural Language

Ejemplo:

> “Gasté 40 dólares en ChatGPT.”

ELISE extrae:

```text
type:
Expense

amount:
40

currency:
USD

counterparty:
OpenAI / ChatGPT

category:
Software / Subscription
```

Si faltan datos no críticos, puede usar defaults.

Si falta un dato esencial o existe ambigüedad importante, preguntar.

---

# 24. Deterministic Finance

Cálculos financieros deben ser determinísticos.

Ejemplos:

```text
monthly expense
income
net
category totals
project profitability
currency-separated totals
```

No pedirle al modelo que sume transacciones.

ELISE puede explicar los resultados calculados.

---

# 25. Currency Handling

No mezclar monedas automáticamente sin una regla explícita.

Ejemplo:

```text
ARS
USD
EUR
```

Una consulta:

> “¿Cuánto gasté este mes?”

puede devolver:

```text
ARS 350,000
USD 120
```

o convertir si el usuario lo solicita y existe una fuente de tipo de cambio apropiada.

La política exacta puede evolucionar.

---

# 26. Finance Dashboard

El MVP incluirá una vista visual básica.

Mínimo:

```text
Income
Expenses
Net

Recent transactions

Categories

Accounts / payment methods
```

Opcionalmente:

```text
monthly trend
category breakdown
```

No saturar con gráficos.

---

# 27. ELISE Goals

Goals representa resultados que el usuario quiere alcanzar.

Modelo conceptual:

```text
Goal

id
workspace_id
title
description
status
target_date
progress
metric
parent_goal
```

Estados:

```text
Active
Completed
Paused
Cancelled
```

---

# 28. Goal Relationships

Goals puede relacionarse con:

```text
Tasks
Habits
Projects
Calendar planning
Finance
```

Ejemplo:

```text
Goal:
Run half marathon

Habits:
Run 3x/week

Tasks:
Buy race registration

Calendar:
Training blocks
```

---

# 29. Goal Progress

Progress puede ser:

```text
manual
derived
hybrid
```

Ejemplo manual:

```text
Write thesis
60%
```

Ejemplo derived:

```text
Save USD 5,000
→ calculated from Finance
```

Ejemplo hybrid:

```text
Launch product
→ milestones + manual judgment
```

---

# 30. ELISE Notes

Notes representa información escrita nativamente dentro de ELISE.

Modelo conceptual:

```text
Note

id
workspace_id
title
content
space_id
entity links
tags
created_at
updated_at
```

Notes puede formar parte de Knowledge automáticamente.

---

# 31. Notes and Knowledge

Una Note puede tener dos representaciones relacionadas:

```text
Native Note
→ source of truth

Knowledge representation
→ searchable/indexed
```

Cuando cambia la Note:

```text
update
→ reindex
```

No crear una copia separada editable.

---

# 32. Notes From Conversation

Caso:

> “Guardá esto como una nota de RSFA.”

ELISE:

```text
extract useful content
suggest title
resolve RSFA entity/space
create Note
index
```

La respuesta debe confirmar dónde se guardó.

---

# 33. Cross-Module Entity Links

Structured Data debe poder relacionarse mediante entities.

Ejemplo:

```text
Client: RSFA

linked:
├── Tasks
├── Notes
├── Finance Transactions
├── Goals
└── Knowledge
```

Esto habilita:

> “Poneme al día con RSFA.”

sin crear un silo por módulo.

---

# 34. Structured Query Layer

El AI runtime no debe escribir SQL libre directamente.

Debe utilizar operaciones seguras.

Ejemplo:

```text
finance.listTransactions(...)
tasks.getOpen(...)
habits.getWeeklyProgress(...)
goals.getProgress(...)
```

Internamente estas operaciones pueden usar SQL mediante repositories.

---

# 35. Structured Tool Schemas

Cada operación expuesta a AI debe tener schema validado.

Ejemplo conceptual:

```ts
createTransaction({
  type,
  amount,
  currency,
  date?,
  category?,
  notes?
})
```

Utilizar validación estricta.

Datos inválidos no llegan a persistencia.

---

# 36. AI Role

AI se usa para:

- interpretar lenguaje natural;
- extraer campos;
- sugerir categorías;
- inferir relaciones;
- resumir;
- recomendar acciones;
- generar explicaciones.

No se usa como fuente de verdad para:

- totals;
- status;
- IDs;
- permissions;
- dates already stored;
- database constraints.

---

# 37. Importing Existing Data

ELISE debe facilitar migración desde sistemas existentes.

MVP:

```text
CSV
Excel-compatible tabular uploads
Google Sheets
```

Flujo:

```text
Import
 ↓
Inspect columns
 ↓
AI suggests mapping
 ↓
Preview
 ↓
User confirms
 ↓
Validate
 ↓
Import
```

---

# 38. AI-Assisted Mapping

Ejemplo spreadsheet:

```text
Fecha
Tipo
Monto
Moneda
Medio
Categoría
Cliente
```

ELISE puede proponer:

```text
Fecha
→ transaction.date

Tipo
→ transaction.type

Monto
→ transaction.amount

Moneda
→ transaction.currency

Cliente
→ linked entity
```

El usuario confirma antes del import.

---

# 39. Import Preview

Antes de escribir:

```text
248 rows detected

238 ready
7 need review
3 invalid

[ Review ]
[ Import ]
```

Nunca importar silenciosamente datos dudosos.

---

# 40. Import Validation

Validar:

- required fields;
- data types;
- dates;
- currencies;
- duplicates;
- invalid enum values;
- entity mapping.

La IA ayuda a interpretar.

Código valida.

---

# 41. Duplicate Detection

Durante imports, ELISE debe intentar detectar duplicados.

Signals:

```text
date
amount
title
external ID
row ID
source file
hash
```

No eliminar automáticamente casos ambiguos.

Presentar review cuando sea necesario.

---

# 42. Import Provenance

Cada registro importado puede conservar:

```text
import_id
source_file
source_row
imported_at
```

Esto facilita:

- debugging;
- rollback;
- audit.

---

# 43. Import Rollback

Idealmente una importación debe poder deshacerse como unidad cuando técnicamente sea seguro.

Ejemplo:

```text
Import #392
248 transactions

[ Undo import ]
```

Puede implementarse mediante batch/import IDs.

---

# 44. Export

Los datos Native pertenecen al usuario.

ELISE debe quedar preparada para exportar:

```text
CSV
JSON
future spreadsheet export
```

No es necesario completar todos los formatos en primera iteración, pero el schema debe permitirlo.

---

# 45. Realtime

Native data debe ser compatible con realtime.

Ejemplo:

```text
User completes task via chat
 ↓
DB updated
 ↓
Task UI updates immediately
```

Otros casos:

- habit check-in;
- finance transaction;
- note creation;
- goal update.

---

# 46. History and Audit

Acciones importantes deben ser auditables.

Ejemplo:

```text
Task completed
by user
14:32

Transaction updated
amount: 25 → 30
```

No necesariamente mostrar audit history en todas las pantallas.

Debe existir a nivel de sistema.

---

# 47. Soft Delete

Para ciertos módulos, usar soft-delete/archiving cuando sea útil.

Ejemplos:

```text
Tasks
Notes
Transactions
Goals
```

Esto facilita:

- undo;
- audit;
- recovery.

Borrado físico puede ocurrir posteriormente según retention policy.

---

# 48. Approvals

Native no significa sin permisos.

Ejemplo:

```text
Read Finance
→ automatic

Create transaction
→ configurable

Delete transaction
→ ask by default
```

El mismo policy engine aplica a Native y external providers.

---

# 49. Morning Brief Integration

Native data debe alimentar Morning Brief.

Ejemplo:

```text
Tasks
→ overdue + today

Habits
→ weekly progress

Goals
→ relevant progress

Finance
→ optional snapshot
```

El usuario decide qué incluir.

---

# 50. Planning Integration

Planning puede combinar:

```text
Tasks
Habits
Goals
Calendar
```

Ejemplo:

> “Organizame mañana.”

ELISE consulta:

```text
calendar
open tasks
habit targets
goal priorities
```

y propone un plan.

---

# 51. Schedule Integration

Scheduled Tasks puede consultar o modificar Native Data.

Ejemplos:

```text
Weekly Finance Review
Habit Reminder
Goal Progress Review
Task Digest
```

Toda modificación sigue policy/approval rules.

---

# 52. Notifications

Native modules pueden generar futuras notificaciones contextuales.

Ejemplo:

```text
Habit target at risk
Goal deadline approaching
Overdue high-priority task
Unexpected expense threshold
```

La filosofía sigue siendo:

> proactive, not noisy.

---

# 53. Search Across Native Data

Chat puede realizar búsquedas estructuradas.

Ejemplos:

> “Mostrame gastos de software de este mes.”

> “Qué tareas tengo de Firbot?”

> “Cuántas veces fui al gym esta semana?”

Estas queries no requieren vector search salvo que exista contenido textual relevante.

---

# 54. Semantic Search Over Native Text

Algunos campos pueden también indexarse para semantic search.

Ejemplo:

```text
Notes
Task descriptions
Goal descriptions
```

Sin embargo, el registro estructurado sigue siendo la fuente de verdad.

---

# 55. Provider Migration

Futuro:

```text
Google Tasks
→ ELISE Tasks
```

o:

```text
ELISE Tasks
→ external provider
```

El sistema debe poder mapear modelos canónicos y presentar preview.

No es requisito de implementación completa en primera fase.

---

# 56. Synchronization vs Import

Distinguir:

```text
Import
→ copy data into ELISE Native
→ ELISE becomes source of truth
```

de:

```text
Connection
→ external provider remains source of truth
```

El usuario debe entender la diferencia.

---

# 57. Example — Google Sheet Finance Import

User:

> “Quiero pasar esta planilla a Finanzas.”

Flow:

```text
Google Sheet
 ↓
Read rows
 ↓
Infer finance schema
 ↓
Suggest mapping
 ↓
Preview
 ↓
Confirm
 ↓
Import into ELISE Finance
 ↓
ELISE becomes source of truth for imported records
```

La hoja original no se sincroniza automáticamente salvo que el usuario configure una integración específica.

---

# 58. Example — Native Habit

User:

> “Quiero entrenar 4 veces por semana.”

ELISE:

```text
create Habit
name = Gym
frequency = weekly
target = 4
```

Durante la semana:

> “Entrené hoy.”

ELISE crea check-in.

Luego:

> “¿Cómo vengo?”

Sistema calcula:

```text
3 / 4
```

AI responde con contexto.

---

# 59. Example — Native Finance

User:

> “Gasté 85 USD en herramientas para Firbot.”

Flow:

```text
Finance capability
 ↓
EliseFinanceProvider
 ↓
extract:
Expense
85
USD
Software/Tools
Entity: Firbot
 ↓
validation
 ↓
policy
 ↓
persist
```

---

# 60. Example — Native Note + Knowledge

User:

> “Guardá que Client X confirmó el lanzamiento para el 15.”

Flow:

```text
Notes capability
 ↓
resolve Client X
 ↓
create Note
 ↓
link Client entity
 ↓
assign Knowledge Space
 ↓
index note
 ↓
available for future retrieval
```

---

# 61. Data Ownership

Native data pertenece al usuario/workspace.

Todo registro debe estar aislado por:

```text
workspace_id
```

y protegido por:

- application authorization;
- RLS;
- ownership checks.

---

# 62. UI Structure

`My Elise` agrupa módulos Native.

```text
My Elise
├── Tasks
├── Habits
├── Lists
├── Finance
├── Goals
└── Notes
```

Cada módulo puede tener:

- overview;
- filters;
- search;
- create/edit;
- chat actions;
- connection/context metadata.

---

# 63. Mobile UX

Mobile debe priorizar quick capture.

Ejemplos:

```text
+ Task
+ Expense
+ Habit Check-in
+ Note
```

y Voice:

> “Gasté 10 mil en nafta.”

> “Agregá comprar café.”

> “Hoy corrí.”

---

# 64. Data Model Boundaries

Evitar crear un único modelo genérico para todo.

No:

```text
GenericItem
type = task/habit/transaction/note/goal
```

Cada dominio tiene semántica diferente.

Compartir:

- metadata patterns;
- ownership;
- audit;
- entity links;

pero conservar modelos separados.

---

# 65. Avoid Overengineering

No construir inicialmente:

- full accounting system;
- enterprise project management;
- advanced CRM;
- complex Notion clone;
- universal database builder.

ELISE Native debe cubrir casos simples y útiles.

La ventaja es integración con ELISE, no profundidad infinita de cada módulo.

---

# 66. MVP Scope

MVP incluye:

```text
ELISE Tasks
ELISE Habits
ELISE Lists
ELISE Finance
ELISE Goals
ELISE Notes

CRUD
Chat operations
Realtime updates
Entity relationships
Basic dashboards
Imports
Google Sheets-assisted import
CSV/tabular import
AI-assisted mapping
Validation
Morning Brief integration
Planning integration
Schedules integration
Approvals
Basic auditability
```

---

# 67. Post-MVP Scope

Posibles extensiones:

```text
Templates
Shared lists
Team tasks
Budgets
Recurring transactions
Advanced goal metrics
Advanced habit analytics
Bank connections
Provider migrations
Native projects
Custom databases
More import sources
Mobile push
Advanced notifications
```

---

# 68. Engineering Rules

1. Native modules implement capability contracts.
2. Supabase is source of truth for Native.
3. Structured queries do not use RAG by default.
4. AI interprets; code validates.
5. Calculations are deterministic.
6. Every write validates workspace ownership.
7. Entity links remain explicit.
8. Imports require preview and validation.
9. External provider data is not silently converted into Native.
10. Native data remains exportable.
11. Realtime is supported.
12. Modules remain separate domains, not one generic table.

---

# 69. Architecture Summary

```text
User
 ↓
Chat / UI / Voice
 ↓
Capability
 ↓
Provider Resolver
 ↓
Elise Native Provider
 ↓
Application Service
 ↓
Validation / Policy
 ↓
Repository
 ↓
Supabase PostgreSQL
 ↓
Realtime Update
```

For analysis:

```text
Structured Data
 ↓
Deterministic Query / Aggregation
 ↓
AI Interpretation
 ↓
User-friendly Response
```

---

# 70. North Star

> **ELISE Native should make simple personal data effortless to create, useful to connect, and easy to reason about.**
>
> The user should never need another app merely because ELISE lacks a basic place to store a task, habit, goal, note or transaction.
>
> At the same time, ELISE must remain open to external providers whenever the user already has a preferred system.
