# ELISE — Capability & Provider Model

**Document:** `07-capability-provider-model.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE abstrae capacidades del usuario y las implementa mediante providers intercambiables, múltiples cuentas, alternativas nativas y futuras integraciones custom.

---

# 1. Core Principle

ELISE debe pensar en **capabilities**, no en aplicaciones.

El usuario quiere:

- leer email;
- consultar calendario;
- gestionar tareas;
- buscar conocimiento;
- analizar finanzas;
- enviar mensajes;
- escuchar voz;
- automatizar acciones.

No debería necesitar pensar en:

- Gmail;
- Outlook;
- Notion;
- Google Tasks;
- ElevenLabs;
- Make;
- Microsoft Graph.

Las aplicaciones específicas son **providers** que implementan una capability.

Ejemplo:

```text
Email
├── Gmail
└── Outlook
```

o:

```text
Tasks
├── ELISE Tasks
├── Google Tasks
└── Todoist
```

---

# 2. Capability

Una Capability representa una capacidad funcional de ELISE.

Ejemplos iniciales:

```text
Email
Calendar
Tasks
Knowledge
Habits
Finance
Lists
Goals
Notes
Messaging
Voice
News
Web Search
CRM
Automation
Location
```

Cada capability define:

- un contrato común;
- operaciones disponibles;
- modelos canónicos;
- permisos;
- niveles de riesgo;
- posibles providers;
- extensiones opcionales.

---

# 3. Provider

Un Provider implementa una capability concreta.

Ejemplos:

```text
Email
├── GmailProvider
└── OutlookProvider

Tasks
├── EliseTasksProvider
└── GoogleTasksProvider

Finance
├── EliseFinanceProvider
├── GoogleSheetsFinanceProvider
└── FutureFinanceProvider
```

Un provider puede ser:

- nativo;
- externo;
- API-based;
- MCP-based;
- webhook-based;
- custom en versiones futuras.

---

# 4. Connection

Una Connection representa una cuenta concreta autorizada por un usuario.

Ejemplo:

```text
Provider:
Gmail

Connection:
leo.personal@gmail.com
```

Otro ejemplo:

```text
Provider:
Gmail

Connection:
leo@firbot.com
```

No confundir Provider con Connection.

`GmailProvider` es una implementación.

`leo@firbot.com` es una conexión específica de un usuario.

---

# 5. Multiple Active Providers

Una misma capability puede tener múltiples providers o múltiples connections activas simultáneamente.

Ejemplo:

```text
Email
├── Gmail Personal
├── Gmail Firbot
└── Future Outlook Account
```

ELISE no debe asumir:

```text
Capability = one provider = one account
```

El modelo correcto es:

```text
Capability
   ↓
Many Bindings
   ↓
Provider + Connection + Context
```

---

# 6. Querying Multiple Connections

Cuando el usuario no especifica una cuenta o contexto concreto, ELISE puede consultar múltiples bindings de una capability.

Ejemplo:

> “¿Tengo algún mail de Martín?”

Si existen:

```text
Gmail Personal
Gmail Firbot
```

ELISE puede buscar en ambas cuentas.

La decisión de consultar una, varias o todas debe depender de:

- contexto;
- reglas;
- costo;
- relevancia;
- latencia;
- permisos;
- confianza.

No debe pedir una aclaración innecesaria si buscar en varias cuentas es seguro y razonable.

---

# 7. Write Operations Must Be More Conservative

Para acciones de lectura, ELISE puede consultar múltiples connections cuando sea útil.

Para acciones de escritura, debe resolver explícitamente el destino.

Ejemplo:

> “Mandale un mail a Juan.”

Si existe suficiente contexto:

```text
Client Juan
→ Firbot context
→ Gmail Firbot
```

ELISE puede sugerir o utilizar esa cuenta según reglas.

Si existe ambigüedad:

```text
Personal Gmail
Firbot Gmail
```

debe preguntar.

Principio:

> **Read broadly when safe. Write narrowly when certain.**

---

# 8. Capability Binding

Un Binding relaciona una capability con una connection concreta y su contexto.

Modelo conceptual:

```text
CapabilityBinding

id
workspace_id
capability
provider
connection_id
context
priority
is_default
enabled
permissions
metadata
```

Ejemplo:

```text
capability: email
provider: gmail
connection: firbot@gmail.com
context: work.firbot
priority: 100
is_default: false
```

Otro:

```text
capability: email
provider: gmail
connection: personal@gmail.com
context: personal
is_default: true
```

---

# 9. Context-Aware Resolution

Elise debe resolver bindings utilizando contexto.

Ejemplo:

> “Respondé el correo de Rod.”

Contexto:

```text
Rod
→ RSFA
→ Work
```

Resolver:

```text
Email capability
→ Work-related email binding
→ relevant Gmail connection
```

Otro ejemplo:

> “Mandale un mail a mi hermana.”

Resolver:

```text
Personal context
→ Personal Gmail
```

---

# 10. Default Bindings

Cada capability puede tener:

- un default global;
- defaults por contexto;
- providers preferidos;
- fallbacks.

Ejemplo:

```text
Email

Global default:
Personal Gmail

Work / Firbot:
Firbot Gmail

Work / RSFA:
Outlook RSFA
```

El user-facing setup debe mantener esto simple.

---

# 11. Native + External Coexistence

ELISE Native y providers externos pueden coexistir.

Ejemplo:

```text
Tasks
├── ELISE Tasks
└── Google Tasks
```

El usuario puede:

- utilizar ambos;
- asignarlos a contextos distintos;
- elegir uno como default;
- consultar ambos cuando corresponda.

Ejemplo:

```text
Personal tasks
→ ELISE Tasks

Work tasks
→ Google Tasks
```

No es obligatorio migrar de uno al otro.

---

# 12. ELISE Native Is a Provider

Arquitectónicamente, ELISE Native debe comportarse como otro provider.

Ejemplo:

```text
TaskCapability

implementations:
- EliseTasksProvider
- GoogleTasksProvider
```

Esto evita crear lógica separada para:

```text
if native
else external
```

ELISE Core trabaja con el mismo contrato.

---

# 13. Core Capability Contract

Cada capability debe definir operaciones comunes.

Ejemplo:

```ts
interface EmailProvider {
  search(...)
  getMessage(...)
  getThread(...)
  createDraft(...)
  send(...)
}
```

ELISE trabaja principalmente con este contrato.

---

# 14. Canonical Models

Cada capability debe tener modelos internos propios de ELISE.

Ejemplo Email:

```text
EmailMessage
EmailThread
EmailAddress
EmailDraft
```

Ejemplo Calendar:

```text
Calendar
CalendarEvent
AvailabilitySlot
Attendee
```

Ejemplo Task:

```text
Task
TaskList
TaskStatus
TaskPriority
```

Providers externos traducen sus modelos al formato canónico.

---

# 15. Provider Normalization

Ejemplo:

```text
Gmail API response
        ↓
Gmail Adapter
        ↓
EmailMessage
        ↓
ELISE
```

Futuro:

```text
Microsoft Graph response
        ↓
Outlook Adapter
        ↓
EmailMessage
        ↓
ELISE
```

El resto del sistema no debería necesitar saber cuál fue el provider original.

---

# 16. Provider Extensions

Los providers pueden tener funcionalidades que no existan en el contrato común.

Ejemplo:

```text
Email Core
├── search
├── read
├── draft
└── send

Gmail Extension
└── applyLabel
```

Estas funcionalidades pueden exponerse como extensiones.

Regla:

> Una función específica de un provider no debe contaminar el contrato común salvo que tenga sentido para la capability en general.

---

# 17. Capability Support Matrix

Cada provider puede declarar qué operaciones soporta.

Ejemplo:

```text
GmailProvider

search          ✓
read            ✓
draft           ✓
send            ✓
archive         ✓
labels          ✓
```

Otro provider:

```text
ExampleEmailProvider

search          ✓
read            ✓
draft           ✕
send            ✓
archive         ✕
```

ELISE debe conocer estas diferencias antes de ofrecer una acción.

---

# 18. Provider Metadata

Cada provider debe declarar metadata como:

```text
id
displayName
capabilities
authType
supportsMultipleAccounts
supportedOperations
extensions
status
```

Esto permite construir interfaces dinámicas.

---

# 19. Connection Metadata

Cada conexión puede almacenar:

```text
id
workspace_id
provider_id
external_account_id
display_name
email/account label
status
created_at
last_sync_at
auth_metadata
user_defined_context
```

Tokens o secretos no deben exponerse como metadata común.

---

# 20. Provider Resolver

El Provider Resolver determina qué binding utilizar.

Inputs posibles:

```text
workspace
capability
intent
entities
active context
rules
available bindings
operation type
```

Output:

```text
one binding
multiple bindings
or clarification required
```

---

# 21. Resolver Decision Strategy

Orden conceptual:

```text
1. Explicit user selection
2. Strong contextual match
3. Context-specific default
4. Global default
5. Safe multi-provider read
6. Ask user
```

Ejemplo:

```text
User:
"Buscá si recibí algo sobre presupuesto."

No account specified.

Safe read operation.

→ Search all enabled email bindings.
```

Ejemplo:

```text
User:
"Respondé el presupuesto."

Write operation.

Context not enough.

→ Ask which account.
```

---

# 22. Aggregate Reads

Capabilities pueden soportar resultados agregados.

Ejemplo:

```text
Calendar
├── Personal
├── Firbot
└── University
```

Query:

> “¿Qué tengo mañana?”

Resultado:

```text
Merged timeline
```

pero preservando metadata:

```text
event.calendar
event.provider
event.connection
```

---

# 23. Aggregation Must Preserve Provenance

Cuando se mezclen providers, el origen debe permanecer disponible.

Ejemplo:

```text
10:00
Firbot Meeting
Source: Firbot Calendar

15:00
University
Source: Personal Google Account
```

Esto permite:

- transparencia;
- writes posteriores;
- troubleshooting;
- permisos correctos.

---

# 24. Capability Registry

ELISE debe mantener un registro de capabilities conocidas.

Ejemplo:

```text
CapabilityRegistry

email
calendar
tasks
knowledge
habits
finance
lists
goals
notes
voice
news
location
```

Cada capability define:

- schema;
- operations;
- models;
- risk levels;
- provider requirements.

---

# 25. Provider Registry

El sistema debe mantener providers disponibles.

Ejemplo MVP:

```text
Email
└── Gmail

Calendar
└── Google Calendar

Tasks
├── ELISE Tasks
└── Google Tasks

Knowledge
├── ELISE Uploads
├── Google Drive
└── Notion

Finance
├── ELISE Finance
└── Google Sheets
```

El registry crecerá progresivamente.

---

# 26. Dynamic UI From Registry

La interfaz de Connections puede construirse parcialmente desde metadata.

Ejemplo:

```text
Calendar

Google Calendar
✓ Available

Microsoft Outlook
Coming later
```

Esto evita hardcodear cada integración directamente en páginas diferentes.

---

# 27. Permissions at Capability Level

Permissions pueden definirse por capability/binding.

Conceptualmente:

```text
Understand
Read
Write
```

O internamente:

```text
knowledge_access
read_access
write_access
```

La UI utiliza términos simples.

---

# 28. Operation-Level Permissions

Algunas capabilities requieren permisos más específicos.

Ejemplo Email:

```text
read
draft
send
archive
delete
```

La UI no necesita mostrar todos por defecto.

Puede presentar:

```text
Understand
Read
Make changes
```

y dejar detalles en Advanced.

---

# 29. Capability Risk Metadata

Cada operación debe tener un nivel de riesgo.

Ejemplo:

```text
email.search
LOW

email.createDraft
LOW

email.send
MEDIUM/HIGH

calendar.deleteEvent
HIGH

finance.createTransaction
MEDIUM
```

El sistema de approvals utiliza esta metadata junto con reglas del usuario.

---

# 30. Provider Health

Cada connection debe tener estado.

Ejemplo:

```text
Connected
Needs Reauthorization
Syncing
Error
Disabled
```

ELISE debe evitar intentar acciones sobre providers no saludables sin comunicarlo.

---

# 31. Fallback Providers

Cuando existan varios providers compatibles, puede definirse fallback.

Ejemplo:

```text
Task Creation

Primary:
ELISE Tasks

Fallback:
Google Tasks
```

Sin embargo, los fallbacks no deben ejecutarse automáticamente para operaciones de escritura si podrían crear datos en un destino inesperado.

---

# 32. Provider Selection UX

El usuario no debe gestionar providers constantemente.

La experiencia normal es:

> Pedir algo a ELISE.

Solo cuando sea necesario:

```text
Which account should I use?

○ Personal
● Firbot
```

Puede incluir:

```text
Remember this choice for Firbot
```

---

# 33. Provider Configuration UX

Connections:

```text
Gmail

Personal
✓ Connected
Default for Personal

Firbot
✓ Connected
Default for Work

[ Add account ]
```

Advanced:

```text
Context
Priority
Capabilities
Permissions
Custom instructions
```

---

# 34. Knowledge Has Multiple Simultaneous Providers by Design

Knowledge normalmente combina varias fuentes.

Ejemplo:

```text
Knowledge Space: RSFA

Sources
├── Notion
├── Google Drive
├── Uploaded files
└── ELISE Notes
```

No existe necesariamente un provider principal.

El Knowledge System agrega resultados preservando provenance.

---

# 35. External Source vs Native Source

Ejemplo:

```text
Finance

ELISE Finance
→ ELISE is source of truth

Google Sheet
→ Sheet is source of truth
```

Capability y provider son independientes de source-of-truth semantics.

Cada provider debe declarar su comportamiento.

---

# 36. Provider Sync Modes

Providers pueden funcionar mediante:

```text
Live Query
Cached Query
Synchronized Index
Hybrid
```

Ejemplos:

```text
Google Calendar
→ Live Query

Notion Knowledge
→ Synchronized Index

Gmail
→ Primarily live + optional derived metadata

ELISE Tasks
→ Direct DB access
```

La capability no debe asumir una única estrategia.

---

# 37. Provider-Specific Rules

Una connection puede tener reglas propias.

Ejemplo:

```text
Gmail Firbot

Important:
clients

Auto draft:
direct client questions

Never auto send:
pricing
```

Otra cuenta puede tener reglas distintas.

---

# 38. Cross-Provider Operations

Una intención puede utilizar varios providers.

Ejemplo:

> “Preparame para la reunión con Cliente X.”

```text
Google Calendar
+
Gmail
+
Notion
+
Google Drive
+
ELISE Tasks
```

El Agent/Application layer coordina capabilities.

No se crea un provider gigante que intente resolver todo.

---

# 39. Provider Calls and AI

El modelo puede decidir que necesita una capability.

No debería decidir directamente:

```text
call Gmail API endpoint X
```

Debe solicitar algo como:

```text
email.search(...)
```

El backend resuelve provider + connection + auth.

---

# 40. Provider Credentials Never Reach the Model

AI recibe:

- tool schema;
- permitted actions;
- normalized results.

No recibe:

- OAuth tokens;
- refresh tokens;
- API secrets;
- raw credential metadata.

---

# 41. Custom Providers — Post-MVP

La arquitectura debe permitir providers creados fuera del set oficial.

Futuros mecanismos:

```text
Custom API
Webhook
MCP
Custom Connector
```

Ejemplo:

```text
Custom Capability:
Generate Client Report

Implementation:
Webhook
```

o:

```text
CRM Capability

Provider:
Company Internal API
```

---

# 42. Custom Provider Security

Los custom providers deberán tener:

- schema validation;
- explicit permissions;
- secret management;
- operation declarations;
- risk classification;
- rate limits;
- audit logs.

No permitir custom code arbitrario en el MVP.

---

# 43. Future Provider Marketplace

No forma parte del MVP, pero el modelo debe permitir eventualmente:

```text
Add Capability

Popular
Business
Productivity
Finance
Communication
Automation
```

El Marketplace sería una interfaz sobre Capability Registry + Provider Registry.

---

# 44. Provider Lifecycle

Estados conceptuales:

```text
Available
Connected
Configured
Healthy
Degraded
Disconnected
Deprecated
```

Esto permitirá retirar o reemplazar integrations sin romper el core.

---

# 45. Provider Versioning

Adapters externos pueden cambiar por modificaciones de APIs.

El provider layer debe aislar estos cambios.

El modelo de dominio no debe versionarse cada vez que Google o Notion cambien un endpoint.

---

# 46. Example — Email Search Across Accounts

User:

> “Buscá el correo sobre la propuesta Fernández López.”

Flow:

```text
Intent
→ Email Search

Explicit account?
→ No

Context strong enough?
→ Work / Firbot

Available bindings:
- Gmail Personal
- Gmail Firbot

Resolver:
→ Gmail Firbot first

Confidence sufficient?
→ Yes

Search
→ results
```

Si el contexto fuera débil y una búsqueda global fuera segura:

```text
Search both
→ merge
→ rank
→ preserve source
```

---

# 47. Example — Calendar Aggregation

User:

> “¿Qué tengo mañana?”

Bindings:

```text
Personal Calendar
Firbot Calendar
University Calendar
```

ELISE:

```text
query all enabled calendars
↓
normalize events
↓
merge timeline
↓
detect conflicts
↓
respond
```

---

# 48. Example — Tasks Native + Google

Configuration:

```text
Personal
→ ELISE Tasks

Work
→ Google Tasks
```

User:

> “Agregá comprar pasta dental.”

Context:

```text
Personal
```

Resolver:

```text
EliseTasksProvider
```

User:

> “Agregá revisar propuesta de Client X.”

Context:

```text
Work
```

Resolver:

```text
GoogleTasksProvider
```

---

# 49. Example — Unknown Write Destination

User:

> “Creá una tarea: revisar presupuesto.”

Available:

```text
ELISE Tasks
Google Tasks
```

No context.

Write operation.

ELISE:

> “¿Querés guardarla en ELISE Tasks o Google Tasks?”

Option:

```text
Remember this as my default
```

---

# 50. Architectural Rule Summary

1. Capabilities are product concepts.
2. Providers are implementations.
3. Connections are user-specific accounts.
4. Bindings connect capability + provider + connection + context.
5. Multiple bindings can coexist.
6. Reads may safely aggregate.
7. Writes require precise destination resolution.
8. ELISE Native behaves as a provider.
9. Providers normalize into canonical models.
10. Unique functionality lives in extensions.
11. Resolver uses context before asking.
12. Provenance is always preserved.
13. Credentials never reach AI.
14. Custom providers are future extensions, not MVP requirements.
15. The user interacts with ELISE, not with provider architecture.

---

# 51. North Star

> **Users choose what ELISE can access. ELISE chooses how to use it.**
>
> Capabilities remain stable.
>
> Providers can change.
>
> Accounts can multiply.
>
> Context determines which one matters.
