# ELISE — System Architecture

**Document:** `06-system-architecture.md`  
**Status:** Draft v1  
**Purpose:** Definir la arquitectura general de ELISE para el MVP y establecer los límites entre frontend, backend, AI runtime, data layer, background execution, realtime, knowledge, providers y módulos nativos.

---

# 1. Architecture Goal

ELISE debe construirse como una aplicación web modular y extensible capaz de:

- conversar con el usuario;
- consultar herramientas externas;
- utilizar conocimiento persistente;
- ejecutar acciones;
- procesar información en background;
- administrar tareas programadas;
- reaccionar en tiempo real;
- soportar múltiples usuarios;
- soportar múltiples cuentas por provider;
- mantener una arquitectura preparada para múltiples AI providers.

La arquitectura inicial debe ser suficientemente simple para permitir avanzar rápido, pero no debe introducir acoplamientos que dificulten la evolución posterior.

---

# 2. Core Architectural Decision

Durante el MVP no se utilizará un backend Node separado.

La arquitectura inicial será:

```text
Frontend + Synchronous Backend
Next.js / Vercel

Background Execution
Trigger.dev

Primary Data Layer
Supabase

Primary AI Provider
OpenAI

AI Provider Abstraction
ELISE internal interface

Realtime
Supabase Realtime + Trigger.dev realtime/event updates where appropriate
```

Esta decisión reduce infraestructura durante el MVP y mantiene una separación clara entre:

- request/response inmediato;
- ejecución duradera;
- datos persistentes;
- razonamiento de IA.

Un backend dedicado podrá agregarse posteriormente si aparece una necesidad real.

---

# 3. High-Level Architecture

```text
                         ┌───────────────────────────┐
                         │        ELISE WEB         │
                         │                           │
                         │ Next.js + React + TS     │
                         │ Desktop + Mobile Web     │
                         └─────────────┬─────────────┘
                                       │
                              HTTPS / Streaming
                                       │
                         ┌─────────────▼─────────────┐
                         │      NEXT.JS SERVER       │
                         │                           │
                         │ App Router                │
                         │ Server Actions / APIs     │
                         │ Auth-aware services       │
                         │ ELISE application layer   │
                         └───────┬────────┬──────────┘
                                 │        │
                    ┌────────────┘        └────────────┐
                    │                                  │
          ┌─────────▼─────────┐              ┌────────▼─────────┐
          │    ELISE CORE     │              │  BACKGROUND JOBS │
          │                   │              │                  │
          │ Orchestration     │              │ Trigger.dev      │
          │ Capabilities      │              │ Schedules        │
          │ Provider resolve  │              │ Sync             │
          │ Context building  │              │ Ingestion        │
          │ Rules             │              │ Long-running work│
          │ Agent runtime     │              │ Retries          │
          └───────┬───────────┘              └────────┬─────────┘
                  │                                   │
        ┌─────────┼───────────┐                       │
        │         │           │                       │
        ▼         ▼           ▼                       ▼
   ┌────────┐ ┌────────┐ ┌─────────────┐      ┌──────────────┐
   │   AI   │ │Supabase│ │ Providers   │      │ Realtime     │
   │Runtime │ │        │ │             │      │ Events       │
   │        │ │Auth    │ │ Google      │      │ Progress     │
   │OpenAI  │ │DB      │ │ Notion      │      │ Status       │
   │first   │ │Storage │ │ Web         │      │ Notifications│
   │        │ │Vector  │ │ Future      │      │              │
   └────────┘ └────────┘ └─────────────┘      └──────────────┘
```

---

# 4. Architectural Layers

ELISE se divide conceptualmente en las siguientes capas:

```text
Presentation
Application
Core / Domain
Infrastructure
Persistence
Background Execution
External Providers
```

Cada capa tiene responsabilidades distintas.

---

# 5. Presentation Layer

La capa de presentación vive principalmente en:

```text
src/app/
src/components/
src/features/
```

Responsabilidades:

- renderizar UI;
- manejar interacción;
- mostrar estados;
- consumir application services;
- mostrar resultados de tools;
- recibir realtime updates;
- mostrar approvals;
- presentar errores accionables.

No debe contener:

- lógica de negocio compleja;
- acceso directo a APIs externas;
- secretos;
- SDKs de providers;
- queries arbitrarias distribuidas por componentes.

---

# 6. Application Layer

La capa de aplicación coordina casos de uso.

Ejemplos:

```text
prepareMorningBrief()
askElise()
createSchedule()
connectProvider()
createTask()
searchKnowledge()
prepareMeetingBrief()
```

Esta capa puede utilizar:

- Core;
- repositories;
- provider interfaces;
- AI abstraction;
- background runtime;
- auth context.

Debe describir **qué hace ELISE**, no cómo cada provider específico lo implementa.

---

# 7. ELISE Core

`src/core/` representa los conceptos propios del producto.

Debe permanecer lo más independiente posible de infraestructura externa.

Ejemplos:

```text
src/core/
├── capabilities/
├── providers/
├── agents/
├── skills/
├── rules/
├── routines/
├── knowledge/
├── memory/
└── entities/
```

El Core define:

- tipos;
- interfaces;
- contratos;
- políticas;
- modelos canónicos;
- reglas de dominio.

No debe depender directamente de:

- OpenAI;
- Supabase;
- Trigger.dev;
- Gmail;
- Notion;
- Google APIs;
- ElevenLabs;
- SDKs externos.

---

# 8. Infrastructure Layer

`src/infrastructure/` contiene adapters concretos.

Ejemplos:

```text
src/infrastructure/
├── ai/
│   └── openai/
├── auth/
├── supabase/
├── background/
│   └── triggerdev/
├── providers/
│   ├── gmail/
│   ├── google-calendar/
│   ├── google-drive/
│   ├── google-tasks/
│   ├── google-sheets/
│   └── notion/
└── observability/
```

Esta capa traduce proveedores externos al modelo interno de ELISE.

---

# 9. Next.js as the Synchronous Backend

Durante el MVP, Next.js será responsable de:

- APIs;
- Server Actions;
- auth-aware requests;
- loading de datos para UI;
- llamadas rápidas a providers;
- consultas rápidas a Supabase;
- interacción con ELISE Core;
- streaming de respuestas cuando corresponda.

Ejemplos apropiados:

```text
"¿Qué tengo mañana?"
"Creá una tarea."
"Buscá este email."
"Consultá este Knowledge Space."
```

Siempre que una operación:

- sea rápida;
- no necesite retry complejo;
- no continúe durante mucho tiempo;
- no necesite esperar horas;
- no deba sobrevivir al cierre del navegador;

puede ejecutarse directamente desde Next.js.

---

# 10. Trigger.dev as Background Runtime

Trigger.dev se utilizará para trabajo duradero o programado.

Casos:

- Morning Brief;
- scheduled tasks;
- sincronización de Notion;
- sincronización de Drive;
- procesamiento de documentos;
- indexing;
- embeddings;
- procesos largos;
- retries;
- waiting for approval;
- event-driven work futuro.

La lógica de negocio no debe quedar atrapada dentro de Trigger.dev.

Patrón:

```text
Trigger.dev task
        ↓
Application Service
        ↓
ELISE Core / Provider Adapters
```

No:

```text
Trigger.dev task
        ↓
All business logic embedded here
```

Esto permite reemplazar el runtime en el futuro.

---

# 11. Background Runtime Abstraction

ELISE debe concebir internamente un contrato conceptual:

```ts
interface BackgroundRuntime {
  enqueue(...)
  schedule(...)
  cancel(...)
  getStatus(...)
}
```

La implementación inicial será:

```text
TriggerDevRuntime
```

Una implementación futura podría utilizar otro motor sin modificar el dominio.

No es necesario desarrollar múltiples runtimes durante el MVP.

---

# 12. Supabase Responsibilities

Supabase será la plataforma central de persistencia del MVP.

Se utilizará para:

## Authentication

- users;
- sessions;
- authentication state.

## PostgreSQL

- application state;
- ELISE Native;
- settings;
- connections metadata;
- rules;
- schedules;
- conversations;
- messages;
- entities;
- memory;
- knowledge metadata;
- execution state;
- approvals.

## Storage

- uploaded files;
- original Knowledge files;
- generated artifacts where appropriate.

## Vector / Search

Inicialmente:

- embeddings;
- document chunks;
- semantic retrieval.

## Realtime

- database changes;
- notifications;
- approval state;
- job state where useful.

---

# 13. Supabase Is Not the Entire System

Supabase será central, pero no debe convertirse en una capa donde toda la lógica de producto viva.

Evitar:

- lógica de negocio distribuida en triggers SQL innecesarios;
- lógica importante escondida en stored procedures sin necesidad;
- acceso directo desde UI a estructuras internas cuando exista una capa de aplicación apropiada.

La DB almacena estado.

ELISE Core y application services deciden comportamiento.

---

# 14. Multi-Tenant Foundation

Cada recurso sensible debe pertenecer a:

```text
user_id
```

o, preferentemente cuando corresponda:

```text
workspace_id
```

La arquitectura debe poder evolucionar hacia:

```text
Personal Workspace
Team Workspace
Business Workspace
```

aunque el MVP se enfoque en usuarios individuales.

RLS será una pieza fundamental de seguridad.

---

# 15. Multi-Account Architecture

ELISE debe soportar varias conexiones del mismo provider por usuario.

Ejemplo:

```text
User
├── Gmail Personal
├── Gmail Firbot
├── Notion Personal
├── Notion Firbot
├── Google Account Personal
└── Google Account Business
```

Nunca asumir:

```text
user → one Gmail
```

El modelo será:

```text
User / Workspace
      ↓
Connections
      ↓
Capability Bindings
      ↓
Provider
```

---

# 16. Capability Resolution Flow

Cuando ELISE necesita ejecutar algo:

```text
User Intent
    ↓
ELISE Core
    ↓
Capability
    ↓
Resolve available bindings
    ↓
Choose account/provider
    ↓
Permission check
    ↓
Provider adapter
    ↓
External API
```

Ejemplo:

```text
"Respondé el mail de Rod"

Intent
→ Email

Context
→ Work / RSFA

Resolver
→ Gmail Firbot or relevant account

Action
→ create draft / send
```

Si existe ambigüedad significativa:

```text
Ask user
```

---

# 17. AI Provider Architecture

OpenAI será el primer AI provider.

Sin embargo, ELISE no debe depender conceptualmente de OpenAI.

El Core debe utilizar contratos internos.

Ejemplo conceptual:

```ts
interface AIProvider {
  generate(...)
  stream(...)
  runTools(...)
}
```

La infraestructura inicial implementará:

```text
OpenAIProvider
```

Futuro:

```text
AnthropicProvider
OtherProvider
```

No es necesario lograr paridad multi-provider durante el MVP.

La meta es evitar acoplamiento irreversible.

---

# 18. AI Runtime Responsibilities

El AI runtime podrá participar en:

- intent interpretation;
- tool selection;
- context interpretation;
- summarization;
- classification;
- knowledge synthesis;
- planning;
- structured extraction;
- answer generation.

No debe controlar directamente:

- authorization;
- tenancy;
- financial calculations;
- irreversible writes;
- schedule persistence;
- security policy;
- data ownership.

---

# 19. ELISE Agent Runtime

La arquitectura conceptual será:

```text
User message
      ↓
Conversation Context
      ↓
Intent / Context Router
      ↓
Context Builder
      ↓
Available Capabilities
      ↓
Relevant Knowledge
      ↓
Rules / Preferences
      ↓
AI Runtime
      ↓
Tool Calls
      ↓
Results
      ↓
Final Response
```

El sistema no necesita múltiples agentes para cada feature.

ELISE sigue siendo la identidad principal.

---

# 20. Specialized Agents

Los subagents/especialistas se utilizarán únicamente cuando exista una razón clara.

Ejemplos posibles:

```text
Study Tutor
Research Specialist
Future Finance Analyst
```

No crear:

```text
Gmail Agent
Calendar Agent
Notion Agent
Client A Agent
Client B Agent
```

cuando una capability o context profile sea suficiente.

---

# 21. Context Package

Cada interacción construye dinámicamente un paquete de contexto.

Ejemplo:

```text
USER
WORKSPACE
CURRENT CONVERSATION
RELEVANT MEMORIES
ACTIVE RULES
RELEVANT ENTITIES
RELEVANT KNOWLEDGE
AVAILABLE CAPABILITIES
PERMISSIONS
RECENT TOOL RESULTS
```

El modelo no debe recibir todo el conocimiento del usuario.

Debe recibir solo aquello relevante para la interacción.

---

# 22. Knowledge Architecture

Knowledge tendrá su propio pipeline:

```text
Source
  ↓
Ingestion
  ↓
Extraction
  ↓
Normalization
  ↓
Metadata
  ↓
Chunking
  ↓
Embeddings / Indexing
  ↓
Retrieval
```

Fuentes iniciales:

- direct uploads;
- Notion;
- Google Drive;
- ELISE Notes.

El archivo original puede vivir:

- en Supabase Storage si fue cargado directamente;
- en el provider original si proviene de una fuente externa.

ELISE mantiene una representación indexada y metadata.

---

# 23. Structured Data vs Knowledge

No todo debe convertirse en embeddings.

Ejemplos:

```text
PDF / notes
→ Knowledge retrieval

Finance transactions
→ SQL / structured queries

Habit history
→ Structured data

Tasks
→ Structured data

Calendar
→ Live provider query
```

El router decide qué estrategia utilizar.

---

# 24. Realtime Architecture

Realtime es un requisito del MVP.

Debe utilizarse donde mejore visiblemente la experiencia.

Casos principales:

- Knowledge processing progress;
- schedule execution progress;
- tool execution state;
- approvals;
- notifications;
- long-running actions;
- connection status;
- background job completion.

Posibles fuentes:

```text
Supabase Realtime
Trigger.dev realtime/events
Streaming from Next.js
```

No todo debe utilizar el mismo canal.

La implementación debe elegir el mecanismo apropiado según el caso.

---

# 25. Realtime UX Example

Ejemplo:

```text
Preparing Morning Brief

✓ Calendar
✓ Tasks
● Reading email
○ Searching news
```

Por detrás:

```text
Trigger.dev
      ↓
job status
      ↓
realtime update
      ↓
UI
```

Otro ejemplo:

```text
Indexing Google Drive
68%
```

---

# 26. Event Model

ELISE debe desarrollar progresivamente un modelo de eventos internos.

Ejemplos:

```text
connection.created
connection.expired

knowledge.source.connected
knowledge.item.updated
knowledge.ingestion.completed

schedule.started
schedule.completed
schedule.failed

approval.requested
approval.resolved

notification.created
```

Durante el MVP no es necesario construir un event bus complejo.

Pero las nuevas funcionalidades deben evitar acoplamiento directo innecesario.

---

# 27. Approvals Architecture

Una acción puede producir:

```text
PendingApproval
```

Ejemplo:

```text
AI decides:
send email

Policy decides:
approval required

Persist:
approval

UI receives:
realtime update

User approves

Background/Application service continues
```

La política de autorización nunca debe depender exclusivamente del modelo.

---

# 28. Notifications Architecture

Las notificaciones deben ser datos persistentes.

Canales iniciales:

- in-app;
- browser notification.

Modelo conceptual:

```text
Notification
├── user
├── type
├── title
├── content
├── priority
├── read_at
├── action_url
└── source
```

Futuros delivery providers podrán agregarse sin cambiar el modelo.

---

# 29. ELISE Native Architecture

Los módulos ELISE Native viven en la base propia.

Ejemplos:

```text
Tasks
Habits
Lists
Finance
Goals
Notes
```

Deben exponer interfaces similares a providers externos cuando corresponda.

Ejemplo:

```text
Task Capability
├── EliseTaskProvider
└── GoogleTasksProvider
```

Esto permite que el Core trabaje con un modelo común.

---

# 30. External Provider Architecture

Cada provider debe vivir detrás de un adapter.

Ejemplo:

```text
core/
  capabilities/email/

infrastructure/
  providers/gmail/
```

Adapter:

```text
Gmail API
     ↓
GmailProvider
     ↓
Normalized Email Model
     ↓
ELISE
```

El resto de la aplicación no debe consumir objetos crudos del provider salvo casos técnicos bien delimitados.

---

# 31. Provider Normalization

Cada capability necesita modelos canónicos.

Ejemplo Email:

```text
EmailMessage
EmailThread
EmailAddress
EmailDraft
```

Google puede devolver un formato.

Microsoft puede devolver otro.

ELISE consume el modelo canónico.

---

# 32. Provider Extensions

Cuando un provider tenga funciones únicas, estas pueden existir como extensiones.

Ejemplo futuro:

```text
Email core:
search
read
draft
send

Gmail extension:
applyLabel
```

El core común no debe contaminarse con funciones exclusivas de un proveedor.

---

# 33. Web Search and News

Web/News será una capability externa sin conexión personal obligatoria.

Puede utilizarse desde:

- Chat;
- Morning Brief;
- Research;
- Study;
- Work.

La capa de aplicación debe recibir resultados normalizados con:

- title;
- summary/snippet;
- URL;
- source;
- publication date;
- relevance metadata.

---

# 34. Voice Architecture

Voice forma parte del MVP, pero el provider debe quedar abstracto.

Conceptualmente:

```text
Microphone
   ↓
Voice Input Provider
   ↓
ELISE Conversation
   ↓
AI Runtime
   ↓
Voice Output Provider
   ↓
Audio
```

El provider avanzado futuro podrá ser ElevenLabs.

La conversación escrita y hablada comparte:

- conversation state;
- context;
- permissions;
- tools.

---

# 35. Authentication Flow

Conceptualmente:

```text
User
 ↓
Supabase Auth
 ↓
Session
 ↓
Next.js
 ↓
Workspace context
 ↓
ELISE services
```

Todas las operaciones sensibles deben resolverse con identidad de usuario/workspace conocida.

Nunca confiar en IDs enviados desde cliente sin verificar ownership.

---

# 36. Connection Credential Storage

OAuth tokens y secretos de conexión:

- nunca en Client Components;
- nunca en localStorage;
- nunca expuestos al modelo;
- nunca incluidos en logs comunes.

La implementación concreta se definirá en el documento de seguridad.

---

# 37. Source of Truth

Cada dominio debe tener una fuente de verdad explícita.

Ejemplos:

```text
Elise Tasks
→ Supabase

Google Tasks
→ Google

Uploaded Knowledge file
→ Supabase Storage

Google Drive document
→ Google Drive

Notion page
→ Notion
```

ELISE puede mantener índices y caches, pero no debe generar copias divergentes silenciosamente.

---

# 38. Synchronous vs Background Decision Rule

Utilizar ejecución síncrona cuando:

- dura poco;
- el usuario espera el resultado;
- no requiere durability;
- retry no es crítico.

Utilizar background execution cuando:

- puede tardar;
- puede fallar transitoriamente;
- necesita retries;
- debe ejecutarse posteriormente;
- necesita schedule;
- procesa muchos elementos;
- debe continuar con la web cerrada;
- espera input externo.

---

# 39. Example: Morning Brief

```text
Schedule
   ↓
Trigger.dev
   ↓
MorningBriefService
   ↓
Capability Resolver
   ├── Calendar
   ├── Email
   ├── Tasks
   ├── Habits
   ├── Finance
   └── News
   ↓
AI synthesis
   ↓
Supabase
   ↓
Notification
   ↓
Realtime UI
```

---

# 40. Example: Chat Calendar Question

```text
User:
"¿Qué tengo mañana?"

Browser
  ↓
Next.js
  ↓
ELISE runtime
  ↓
Calendar capability
  ↓
Connection resolver
  ↓
GoogleCalendarProvider
  ↓
Normalized events
  ↓
AI / deterministic formatting
  ↓
Streaming response
```

No necesita Trigger.dev.

---

# 41. Example: Document Upload

```text
Browser
  ↓
Upload
  ↓
Supabase Storage
  ↓
knowledge_document
  ↓
Trigger.dev ingestion
  ↓
Extract
  ↓
Chunk
  ↓
Embed
  ↓
Store index
  ↓
Realtime status:
Ready
```

---

# 42. Example: Approval

```text
User:
"Respondé ese email."

ELISE
  ↓
Create draft
  ↓
Policy check

Send requires approval
  ↓
PendingApproval
  ↓
Realtime UI

[Approve]

  ↓
SendEmailService
  ↓
GmailProvider
```

---

# 43. Observability Boundaries

Todas las capas importantes deben ser observables.

Registrar:

- request ID;
- user/workspace;
- AI run;
- tool calls;
- provider calls;
- background run;
- errors;
- latency;
- approval lifecycle.

Nunca registrar secretos ni contenido sensible innecesariamente.

---

# 44. Repository Responsibility Map

Arquitectura sugerida:

```text
src/
├── app/                    # Next.js UI/routes
├── components/             # Reusable visual components
├── features/               # User-facing experiences
├── core/                   # Product/domain contracts
├── infrastructure/         # Concrete external implementations
├── lib/                    # Generic helpers
├── config/
├── hooks/
├── types/
└── styles/

supabase/
└── migrations/

tests/
├── unit/
├── integration/
└── fixtures/
```

---

# 45. Deployment Topology — MVP

```text
Vercel
├── Next.js frontend
└── Next.js server runtime

Supabase
├── Auth
├── PostgreSQL
├── Storage
├── Realtime
└── Vector data

Trigger.dev
└── Background execution

OpenAI
└── Primary AI runtime

External Providers
├── Google
├── Notion
└── Web Search / future providers
```

---

# 46. Scaling Philosophy

No optimizar prematuramente.

Escalar cuando aparezca una necesidad real.

Posibles evoluciones futuras:

- dedicated backend;
- dedicated vector database;
- queue/event bus;
- separate ingestion workers;
- provider microservices;
- Redis/cache;
- enterprise secret management;
- regional deployments.

El MVP no debe implementar estas piezas sin necesidad.

---

# 47. Architecture Constraints

Las siguientes reglas deben mantenerse:

1. `src/core` no importa SDKs externos.
2. UI no llama providers directamente.
3. Providers devuelven modelos normalizados.
4. Background runtime no contiene toda la lógica de negocio.
5. AI no controla autorización.
6. La DB no se convierte en application layer.
7. Multi-account se soporta desde el comienzo.
8. Multi-user se soporta desde el comienzo.
9. Realtime se utiliza cuando mejora UX.
10. AI provider debe poder reemplazarse.
11. Source of truth debe ser explícita.
12. Acciones sensibles requieren políticas determinísticas.

---

# 48. MVP Architecture Decision Summary

## Frontend

```text
Next.js + React + TypeScript
```

## Synchronous Backend

```text
Next.js server
```

## Background

```text
Trigger.dev
```

## Data

```text
Supabase
```

## Authentication

```text
Supabase Auth
```

## File Storage

```text
Supabase Storage
```

## Structured Data

```text
PostgreSQL
```

## Initial Vector Search

```text
Supabase / pgvector
```

## AI

```text
OpenAI first
AI abstraction from day one
```

## Realtime

```text
Supabase Realtime
+ Trigger.dev realtime/status
+ streaming when appropriate
```

## Deployment

```text
Vercel
+ Supabase
+ Trigger.dev
```

---

# 49. North Star Architecture

> **ELISE should remain simple at the edges and modular at the center.**
>
> Next.js serves the experience.
>
> Supabase owns persistent state.
>
> Trigger.dev executes durable work.
>
> AI interprets and reasons.
>
> Providers connect the outside world.
>
> ELISE Core keeps the product independent from all of them.
