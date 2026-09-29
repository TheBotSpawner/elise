# ELISE — Knowledge System

**Document:** `09-knowledge-system.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE ingiere, organiza, sincroniza, indexa, recupera y cita conocimiento proveniente de archivos, Notion, Google Drive, ELISE Notes y futuras fuentes.

---

# 1. Knowledge Vision

ELISE debe poder entender información distribuida en múltiples fuentes sin obligar al usuario a reorganizar toda su vida digital.

El usuario debería poder conectar:

- Google Drive;
- Notion;
- archivos subidos;
- ELISE Notes;
- futuras fuentes;

y luego preguntar:

> “¿Qué acordamos con este cliente?”

> “Resumime todo lo relacionado con este proyecto.”

> “¿Dónde estaba el documento con la propuesta?”

> “¿Qué cambió desde la versión anterior?”

La complejidad de:

- extracción;
- indexación;
- embeddings;
- sincronización;
- reranking;
- metadata;
- versionado;

debe permanecer invisible para el usuario normal.

---

# 2. Core Principle

Knowledge no es una carpeta gigante ni un único vector store global.

La arquitectura debe preservar:

- fuente;
- ownership;
- contexto;
- versión;
- provenance;
- permissions;
- Knowledge Space;
- provider.

Principio:

> **Retrieve from the right context before retrieving from everything.**

---

# 3. Knowledge Sources

Fuentes iniciales del MVP:

```text
ELISE Uploads
Google Drive
Notion
ELISE Notes
```

Futuras:

```text
OneDrive
SharePoint
Web pages
Slack
Teams
CRM records
Email-derived knowledge
MCP sources
Custom APIs
```

---

# 4. Source of Truth

Cada fuente debe conservar una fuente de verdad explícita.

## Direct Upload

```text
Original
→ Supabase Storage
```

ELISE controla:

- archivo original;
- metadata;
- versiones;
- index.

## Google Drive

```text
Original
→ Google Drive
```

ELISE mantiene:

- external reference;
- metadata;
- extracted representation;
- index;
- sync state.

## Notion

```text
Original
→ Notion
```

ELISE mantiene:

- external page/database ID;
- metadata;
- normalized content;
- index;
- sync state.

## ELISE Notes

```text
Original
→ ELISE / Supabase
```

ELISE es fuente de verdad.

---

# 5. Knowledge Item

La unidad lógica común será un `KnowledgeItem`.

Puede representar:

```text
File
Document
Note
Notion Page
Drive Document
Web Page
Future Source
```

Modelo conceptual:

```text
KnowledgeItem

id
workspace_id
space_id
source_id
source_provider
external_id
type
title
source_url
mime_type
status
current_version_id
created_at
updated_at
last_synced_at
metadata
```

---

# 6. Knowledge Spaces

Knowledge Spaces son contenedores lógicos de contexto.

Ejemplos:

```text
Firbot
RSFA
University
Administración
Personal
Client A
```

Un Space no equivale necesariamente a una carpeta física.

Puede combinar:

```text
Knowledge Space: RSFA

├── Notion workspace/pages
├── Google Drive folder
├── Uploaded PDF
├── ELISE Notes
└── Future email-derived records
```

---

# 7. Space Hierarchy

Los Spaces pueden tener jerarquía.

Ejemplo:

```text
Work
└── Firbot
    ├── Internal
    └── Clients
        ├── RSFA
        └── Client B

Study
└── UTN
    ├── Administración
    └── Legislación
```

La jerarquía sirve para:

- navegación;
- scoping;
- permisos futuros;
- retrieval;
- organización.

No debe convertirse en una estructura rígida obligatoria.

---

# 8. Default Retrieval Scope

Cuando el usuario se encuentra dentro de un Knowledge Space, ELISE debe buscar primero dentro de ese contexto.

Ejemplo:

```text
Active Space:
RSFA

User:
"¿Cuál fue la última decisión sobre el flujo?"
```

ELISE busca primero:

```text
RSFA
```

Si la evidencia es insuficiente, puede:

1. expandir a spaces relacionados;
2. expandir globalmente si es seguro;
3. informar que amplió la búsqueda;
4. pedir aclaración si mezclar contextos puede generar confusión.

---

# 9. Global Retrieval

Desde Chat general, ELISE puede buscar en múltiples Spaces.

El Context Builder debe usar:

- active conversation;
- entities;
- current project;
- user wording;
- rules;
- recent interactions;

para limitar el scope antes de buscar.

No debe ejecutar una búsqueda global indiscriminada ante cada pregunta.

---

# 10. Explicit Scope Overrides

El usuario puede indicar scope explícitamente.

Ejemplos:

> “Buscá solo en Firbot.”

> “No uses mis notas personales.”

> “Revisá todos mis documentos.”

> “Preguntale solo a este Space.”

La instrucción explícita tiene prioridad.

---

# 11. Connecting a Knowledge Source

Flujo conceptual:

```text
Connect provider
    ↓
Choose accessible content
    ↓
Choose / create Knowledge Space
    ↓
Choose access behavior
    ↓
Start ingestion
    ↓
Realtime progress
    ↓
Ready
```

---

# 12. Source Selection UX

ELISE debe permitir dos enfoques:

## Simple

```text
Index everything I selected
```

## Selective

El usuario elige:

- folders;
- pages;
- databases;
- files;
- subtrees.

El modo simple debe ser la opción recomendada cuando sea seguro.

---

# 13. Automatic Indexing

Una vez autorizada y seleccionada una fuente:

```text
ELISE automatically indexes the selected scope.
```

El usuario no debe tener que ejecutar manualmente:

- extraction;
- chunking;
- embeddings;
- sync configuration.

---

# 14. Ingestion Pipeline

Pipeline conceptual:

```text
Source
 ↓
Discover items
 ↓
Fetch content
 ↓
Validate
 ↓
Extract
 ↓
Normalize
 ↓
Store metadata
 ↓
Create version
 ↓
Chunk
 ↓
Embed
 ↓
Index
 ↓
Ready
```

---

# 15. Background Processing

La ingesta debe ejecutarse en background mediante Trigger.dev.

Casos:

- large uploads;
- Drive folders;
- Notion workspaces;
- re-index;
- version processing;
- retries.

El usuario puede seguir utilizando ELISE.

---

# 16. Realtime Ingestion Status

Ejemplo:

```text
Google Drive

Indexing...
142 / 310 files

46%

You can keep using ELISE.
```

Estados:

```text
Pending
Discovering
Fetching
Processing
Indexing
Ready
Partial
Error
Paused
```

---

# 17. Incremental Sync

Las fuentes externas deben sincronizarse automáticamente.

No volver a procesar todo si solamente cambió una pequeña parte.

Utilizar cuando sea posible:

- modified timestamps;
- hashes;
- provider cursors;
- revision IDs;
- change APIs;
- stored sync state.

Flujo:

```text
Previous state
    ↓
Detect changes
    ↓
Only process:
new
modified
deleted
```

---

# 18. Default Sync Behavior

Para el MVP:

```text
Automatic periodic sync
+
Sync Now
```

La frecuencia exacta debe administrarse mediante defaults internos.

El usuario normal no necesita configurarla.

Una opción avanzada podrá mostrar frecuencia posteriormente.

---

# 19. Sync Freshness

Cada source debe exponer:

```text
Last synced
Current status
Freshness
```

Ejemplo:

```text
Notion
✓ Up to date
Synced 8 minutes ago
```

o:

```text
Google Drive
⚠ Last sync failed
2 hours ago

[ Retry ]
```

---

# 20. Provider Webhooks

Cuando un provider permita webhooks o change notifications confiables, pueden utilizarse para mejorar frescura.

No deben ser requisito universal.

Modelo:

```text
Webhook/event
    ↓
Trigger incremental sync
```

Fallback:

```text
Periodic sync
```

---

# 21. Knowledge Versioning

ELISE debe conservar versiones anteriores.

Esto aplica especialmente a:

- uploaded files;
- ELISE Notes;
- external content que cambie y sea relevante conservar.

Modelo conceptual:

```text
KnowledgeItem
    ↓
KnowledgeVersion
├── v1
├── v2
└── v3 current
```

---

# 22. Knowledge Version

Modelo conceptual:

```text
KnowledgeVersion

id
knowledge_item_id
version_number
source_revision
content_hash
extracted_content
created_at
is_current
metadata
```

Chunks deben vincularse a una versión concreta.

---

# 23. Version Retention

No es necesario guardar indefinidamente cada modificación trivial.

La estrategia debe equilibrar:

- auditability;
- usefulness;
- storage;
- indexing cost.

Posibles reglas futuras:

```text
Keep latest N versions
Keep major changes
Keep versions for N days
Manual pin
```

Durante MVP se utilizará una política razonable y configurable internamente.

---

# 24. Compare Versions

ELISE debe poder soportar:

> “¿Qué cambió entre estas dos versiones?”

Proceso:

```text
Version A
+
Version B
 ↓
Deterministic diff where useful
+
AI semantic interpretation
 ↓
Change summary
```

La IA explica el significado del cambio.

El código determina diferencias concretas cuando sea posible.

---

# 25. Content Extraction

Los documentos pueden contener:

- text;
- headings;
- tables;
- metadata;
- links;
- structured blocks;
- images;
- attachments.

La extracción debe preservar estructura útil.

No convertir todo en un bloque plano si puede evitarse.

---

# 26. Normalized Knowledge Representation

Cada provider puede tener formatos diferentes.

ELISE debe convertir contenido a una representación común.

Ejemplo conceptual:

```text
NormalizedDocument

title
body
sections
headings
tables
links
metadata
source
version
```

Esto simplifica retrieval y futuras migraciones.

---

# 27. Chunking

Chunking debe adaptarse al contenido.

No usar un único tamaño fijo para todos los tipos.

Factores:

- document structure;
- headings;
- paragraphs;
- tables;
- token count;
- semantic boundaries.

Cada chunk debe preservar metadata suficiente.

---

# 28. Chunk Metadata

Modelo conceptual:

```text
KnowledgeChunk

id
workspace_id
space_id
item_id
version_id
chunk_index
content
embedding
heading_path
page_number
source_url
metadata
```

Debe ser posible regresar del chunk al documento original.

---

# 29. Embeddings

Los embeddings iniciales se almacenarán mediante Supabase/Postgres con pgvector.

La implementación debe quedar detrás de una abstracción.

Esto permite migrar a otro vector backend si el volumen futuro lo requiere.

---

# 30. Search Strategy

La búsqueda no debe ser únicamente vectorial.

La estrategia debe permitir combinar:

```text
Semantic Search
Keyword Search
Metadata Filters
Recency
Entity Context
Space Scope
Provider Scope
```

Objetivo:

```text
Hybrid Retrieval
```

---

# 31. Retrieval Flow

Ejemplo:

```text
User Question
    ↓
Determine scope
    ↓
Build filters
    ↓
Hybrid search
    ↓
Candidate chunks
    ↓
Rerank
    ↓
Top evidence
    ↓
AI synthesis
    ↓
Answer + citations
```

---

# 32. Reranking

Una primera búsqueda puede devolver más candidatos de los que llegan al modelo.

ELISE debe poder rerankear por:

- semantic relevance;
- scope;
- entity match;
- recency;
- source quality;
- document importance.

El método exacto puede evolucionar.

---

# 33. Context Budget

No enviar todos los resultados al modelo.

El Context Builder debe seleccionar únicamente evidencia útil dentro del presupuesto disponible.

Principio:

> **Retrieve broadly enough to find evidence, then send narrowly enough to reason well.**

---

# 34. Citations

Toda respuesta basada en Knowledge debe mostrar provenance cuando sea posible.

Ejemplo:

```text
According to:
• Mortgage Process v3
• Client Meeting Notes — Sep 18
```

El usuario debe poder abrir el origen.

---

# 35. Citation Metadata

Una cita debe poder resolver:

```text
title
provider
source URL
space
version
page / section where possible
```

ELISE no debe inventar citas.

---

# 36. Source Preview

Desde una respuesta, el usuario debería poder:

```text
Open source
Preview relevant section
View in provider
Ask about this document
```

Esto es especialmente importante para confianza.

---

# 37. Answers Without Evidence

Si ELISE no encuentra evidencia suficiente:

No debe presentar una respuesta especulativa como si proviniera del Knowledge Space.

Respuesta deseada:

```text
I couldn't find enough information in the selected sources to answer this confidently.
```

Luego puede:

- expandir scope;
- buscar web si el usuario lo permite;
- pedir una fuente;
- explicar qué revisó.

---

# 38. Knowledge vs Web

Estas fuentes deben permanecer diferenciadas.

```text
Knowledge
→ User-owned / connected sources

Web
→ External current information
```

Una respuesta puede combinar ambas, pero debe distinguir provenance.

---

# 39. Knowledge vs Structured Live Data

Knowledge no reemplaza consultas live.

Ejemplo:

```text
Notion page documentation
→ Knowledge search

Notion database current status field
→ Structured live query
```

Si el usuario pregunta:

> “¿Cuántos proyectos están en estado Active ahora?”

lo correcto puede ser consultar datos estructurados en vivo.

---

# 40. Search & Answer vs Live Data

User-facing model:

```text
Understand this source
→ Search & Answer / Knowledge

Read current data
→ Structured live query

Make changes
→ Structured write
```

Esta diferencia permanece oculta en términos técnicos.

---

# 41. Notion Knowledge

Notion puede utilizarse como Knowledge sin exigir una estructura predeterminada.

ELISE debe poder:

```text
discover selected pages
discover child pages
extract blocks
normalize
index
sync
```

No necesita que todas las páginas tengan las mismas properties.

---

# 42. Notion Databases

Para búsqueda semántica:

```text
Database pages
→ normalized knowledge items
```

Para operaciones estructuradas:

```text
Database schema
→ mapped capability/data model
```

Ambos modos pueden coexistir.

---

# 43. Google Drive Knowledge

Drive ingestion debe soportar progresivamente:

```text
Google Docs
PDF
DOCX
TXT
supported office/document formats
```

El sistema debe registrar:

```text
Drive file ID
Drive URL
modified time
mime type
parent structure
```

---

# 44. Folder Structure

La estructura original de Drive puede conservarse como metadata.

Sin embargo:

```text
Drive folders ≠ automatically Knowledge Spaces
```

ELISE puede sugerir mapping.

Ejemplo:

```text
Drive:
Clients / RSFA

Suggested:
Knowledge Space → RSFA
```

---

# 45. Direct Uploads

El usuario puede arrastrar o seleccionar archivos.

Flujo:

```text
Upload
 ↓
Validate type / size
 ↓
Store original
 ↓
Create KnowledgeItem
 ↓
Background processing
 ↓
Ready
```

Debe mostrarse progreso.

---

# 46. Upload Limits

El MVP debe definir límites explícitos para:

- file types;
- max file size;
- files per batch;
- total storage if needed.

Los límites exactos pueden definirse durante implementación según costos y capacidades reales.

No hardcodear decisiones comerciales prematuramente en el dominio.

---

# 47. ELISE Notes

Notes forman parte de My Elise y también pueden ser Knowledge.

Ejemplo:

```text
User:
"Guardá que el cliente pidió lanzar el lunes."

ELISE:
→ create note
→ link Client entity
→ assign RSFA Knowledge Space
→ index
```

La información queda disponible para retrieval futuro.

---

# 48. Save From Conversation

ELISE debe permitir convertir contenido de conversación en conocimiento persistente.

Ejemplos:

> “Guardá esto como una decisión del proyecto.”

> “Agregá esto a mis notas de Administración.”

ELISE propone destino cuando sea necesario.

---

# 49. Entity Linking

Knowledge Items pueden relacionarse con entities.

Ejemplo:

```text
Document
→ Client: RSFA
→ Project: Mortgage Application
→ Person: Rod
```

Esto mejora:

- retrieval;
- context resolution;
- meeting prep;
- client briefing.

El vínculo puede ser:

- explícito;
- inferido con confianza;
- confirmado por usuario.

---

# 50. Recent Changes

El sistema debe poder responder:

> “¿Qué cambió en RSFA esta semana?”

Fuentes:

```text
Knowledge versions
sync metadata
new notes
changed documents
```

ELISE resume cambios relevantes, no simplemente lista timestamps.

---

# 51. Search Inside a Single Item

El usuario puede abrir un documento y preguntar:

> “¿Qué dice este documento sobre cancelaciones?”

Scope:

```text
single KnowledgeItem
```

No se debe buscar globalmente salvo que el usuario lo solicite.

---

# 52. Summarize a Space

Caso:

> “Resumime todo Firbot.”

ELISE puede realizar retrieval progresivo o un proceso background si el Space es grande.

No intentar enviar el contenido completo al modelo en una sola request.

---

# 53. Large Knowledge Operations

Operaciones como:

- summarize entire large space;
- compare many files;
- migrate large source;
- re-index source;

pueden ejecutarse mediante Trigger.dev.

Resultado:

```text
Prepared in background
→ notification
→ user opens when ready
```

---

# 54. Deletions From External Sources

Si un documento desaparece de su source of truth:

```text
Drive file deleted
```

ELISE debe detectar el cambio.

Comportamiento conceptual:

```text
Mark source item as removed/unavailable
Stop returning it as current evidence
Preserve historical metadata/version when policy permits
```

No fingir que sigue siendo información actual.

---

# 55. Disconnecting a Knowledge Provider

Antes de desconectar:

```text
Notion Firbot

Used by:
• 3 Knowledge Spaces
• Study
• 2 Schedules
```

Al desconectar:

- detener sync;
- invalidar live access;
- deshabilitar dependencias;
- tratar indexed copies según retention/privacy policy.

---

# 56. Reindex

El usuario o sistema puede solicitar:

```text
Reindex source
```

Casos:

- parser update;
- corrupted index;
- embedding model migration;
- manual troubleshooting.

Debe ser una operación background.

---

# 57. Embedding Model Migration

Los chunks no deben estar acoplados a un único embedding model.

Registrar:

```text
embedding_model
embedding_version
```

Esto permite regenerar índices posteriormente.

---

# 58. Parsing Version

También registrar cuando sea útil:

```text
parser_version
chunking_version
```

Esto ayuda a migraciones y debugging.

---

# 59. Search Evaluation

El sistema deberá desarrollar tests de retrieval.

Casos:

```text
Known question
Expected source
Expected Space
Relevant answer evidence
```

Esto permitirá mejorar:

- chunking;
- embeddings;
- reranking;
- filters.

---

# 60. Permissions

Knowledge retrieval debe respetar permisos del workspace y source.

No permitir que:

```text
retrieval
```

salte:

```text
ownership
workspace
provider access
source restrictions
```

Los filtros de seguridad deben aplicarse antes de devolver evidencia al modelo.

---

# 61. Knowledge Isolation

Toda query debe incluir aislamiento por:

```text
workspace_id
```

y, cuando corresponda:

```text
space_id
source_id
```

RLS funciona como defensa adicional, no como única lógica de autorización.

---

# 62. Sensitive Knowledge

La arquitectura debe poder soportar en el futuro:

- source-level sensitivity;
- restricted Spaces;
- team permissions;
- confidential labels.

No es necesario construir RBAC avanzado en MVP personal.

---

# 63. Memory Is Not Knowledge

Knowledge:

```text
comes from identifiable sources
```

Memory:

```text
represents durable learned context about the user
```

Ejemplo:

```text
Knowledge:
"Proposal.pdf says launch is October 10."

Memory:
"Leo usually plans the next day the night before."
```

Nunca mezclar ambos como si fueran iguales.

---

# 64. Rules Are Not Knowledge

Rules son instrucciones explícitas.

Ejemplo:

```text
"Never include newsletters in my Morning Brief."
```

Esto no debe almacenarse como un document chunk.

Debe vivir en Rules/Preferences.

---

# 65. Knowledge Item Status

Estados sugeridos:

```text
Pending
Processing
Ready
Partial
Failed
Stale
Removed
Archived
```

La UI traduce estados técnicos a lenguaje simple.

---

# 66. Search Result Provenance

Cada resultado interno debe conservar:

```text
item_id
version_id
chunk_id
provider
source URL
space
score
```

Aunque la respuesta final no muestre toda esa metadata.

---

# 67. Ranking Across Sources

No asumir que todos los providers tienen igual relevancia.

El ranking puede considerar:

- active Space;
- entity match;
- exact keyword;
- semantic score;
- source freshness;
- user selection;
- source quality;
- explicit priority.

No usar provider brand como proxy automático de calidad.

---

# 68. Retrieval Confidence

ELISE puede calcular una señal interna de confianza basada en:

- evidence coverage;
- source agreement;
- relevance scores;
- recency;
- ambiguity.

La señal ayuda a decidir:

```text
answer
expand search
ask user
state uncertainty
```

No presentar un porcentaje artificial al usuario salvo que tenga significado real.

---

# 69. Knowledge Answer Flow Example

User:

> “¿Qué acordamos sobre el lanzamiento de Client X?”

```text
Active context
→ Client X

Scope
→ Client X Knowledge Space

Search
→ Notion
→ Drive
→ ELISE Notes

Retrieve
→ 12 candidates

Rerank
→ 4 strong chunks

Answer
→ synthesize

Citations
→ Decision Notes
→ Launch Plan.pdf
```

---

# 70. Study Example

User opens:

```text
Knowledge
→ UTN
→ Administración
→ Study
```

Then:

> “Tomame oral de esta unidad.”

Scope:

```text
Administración Space
```

Study Runtime retrieves only relevant study material.

It does not search Work or Personal Knowledge.

---

# 71. Meeting Prep Example

Upcoming meeting:

```text
Client X
```

ELISE may gather:

```text
Calendar event
+
Client Knowledge Space
+
Recent emails
+
Open tasks
+
Recent decisions
```

Knowledge is one component of a broader context package.

---

# 72. Knowledge API / Service Boundary

Application code should interact with services such as:

```text
searchKnowledge(...)
ingestSource(...)
syncSource(...)
getKnowledgeItem(...)
saveNote(...)
compareVersions(...)
```

UI or AI code should not query vector tables directly.

---

# 73. Infrastructure Separation

Conceptual structure:

```text
core/
  knowledge/
    models
    contracts
    policies

infrastructure/
  knowledge/
    embeddings
    parsers
    retrieval
    storage
    provider sync
```

Provider-specific ingestion belongs under infrastructure.

---

# 74. Suggested Data Entities

Initial data entities may include:

```text
knowledge_spaces
knowledge_sources
knowledge_items
knowledge_versions
knowledge_chunks
knowledge_item_entities
knowledge_sync_runs
knowledge_source_bindings
```

Exact SQL schema belongs in `16-data-model.md`.

---

# 75. MVP Knowledge Scope

MVP includes:

```text
Knowledge Spaces
Direct file uploads
Supabase Storage originals
Notion indexing
Google Drive indexing
ELISE Notes
Automatic ingestion
Incremental periodic sync
Manual Sync Now
Realtime processing status
Version history
Semantic + metadata search
Source citations
Open original source
Save note from chat
Space-scoped retrieval
Global contextual retrieval
Study integration
Work/client integration
```

---

# 76. Post-MVP Knowledge Scope

Potential additions:

```text
OneDrive / SharePoint
Slack / Teams knowledge
Web clipping
Audio/video transcription
Advanced OCR
Cross-workspace permissions
Shared Knowledge Spaces
Team Knowledge
Enterprise retention policies
Advanced knowledge graph
Dedicated vector infrastructure
```

---

# 77. What ELISE Must Not Do

Avoid:

- one giant unscoped vector search;
- silent duplication of external source-of-truth;
- invented citations;
- mixing stale external data with current data without warning;
- indexing unauthorized content;
- sending every retrieved chunk to AI;
- treating SQL/structured data as documents by default;
- forcing the user to design a database schema before using Knowledge;
- requiring manual reindexing for normal use.

---

# 78. Architecture Summary

```text
External / Native Source
        ↓
Knowledge Source
        ↓
Background Ingestion
        ↓
Normalized Item
        ↓
Version
        ↓
Chunks
        ↓
Embeddings + Metadata
        ↓
Scoped Hybrid Retrieval
        ↓
Reranking
        ↓
Context Builder
        ↓
AI
        ↓
Answer + Sources
```

---

# 79. North Star

> **ELISE should know where information came from, when it changed, what context it belongs to, and whether it is still trustworthy.**
>
> Users connect sources.
>
> ELISE handles the complexity.
>
> Retrieval stays contextual.
>
> Answers remain traceable.
