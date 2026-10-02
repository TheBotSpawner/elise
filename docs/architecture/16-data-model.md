# ELISE — Data Model

**Document:** `16-data-model.md`  
**Status:** Draft v1  
**Purpose:** Definir el modelo de datos conceptual del MVP de ELISE sobre PostgreSQL/Supabase, incluyendo tenancy, usuarios, conexiones, capabilities, conversaciones, memory, entities, Knowledge, ELISE Native, Rules, Schedules, Actions, Approvals, Notifications y ejecución background.

> Este documento define la **estructura lógica recomendada**, no el SQL final.  
> Las migraciones reales deberán implementarse progresivamente en `supabase/migrations/`.

---

# 1. Data Model Goals

El modelo debe:

- soportar múltiples usuarios desde el comienzo;
- aislar datos por workspace;
- permitir múltiples cuentas por provider;
- preservar source-of-truth;
- soportar ELISE Native y providers externos;
- permitir realtime;
- preservar provenance;
- soportar background execution;
- mantener auditabilidad;
- evitar modelos genéricos excesivos;
- permitir evolución hacia Teams/Business.

---

# 2. Primary Technology

MVP:

```text
Supabase
├── PostgreSQL
├── Auth
├── Storage
├── Realtime
└── pgvector
```

PostgreSQL será la fuente de verdad para el estado propio de ELISE.

---

# 3. Global Data Principles

Todas las tablas relevantes deben seguir, cuando corresponda:

```text
id
workspace_id
created_at
updated_at
```

Preferencias:

```text
UUID primary keys
timestamptz
JSONB only for extensible metadata
explicit relational columns for important semantics
foreign keys
indexes on ownership + lookup fields
```

---

# 4. Naming Conventions

Recommended:

```text
snake_case
plural table names
singular conceptual entity names
```

Ejemplos:

```text
knowledge_items
provider_connections
schedule_runs
habit_entries
```

Foreign keys:

```text
workspace_id
user_id
connection_id
entity_id
```

---

# 5. Multi-Tenant Foundation

Primary ownership boundary:

```text
workspace_id
```

Relationship:

```text
auth.users
    ↓
user_profiles
    ↓
workspace_members
    ↓
workspaces
```

Durante MVP:

```text
User
→ Personal Workspace
```

Futuro:

```text
User
├── Personal
├── Acme Team
└── Organization Workspace
```

---

# 6. `user_profiles`

Extiende `auth.users`.

Suggested fields:

```text
id                  uuid PK / FK auth.users
display_name
preferred_language
timezone
locale
avatar_url
onboarding_status
created_at
updated_at
```

No duplicar credenciales de Supabase Auth.

---

# 7. `workspaces`

```text
id
name
slug
type
owner_user_id
default_language
timezone
created_at
updated_at
archived_at
```

`type`:

```text
personal
team
business
```

MVP utiliza principalmente `personal`.

---

# 8. `workspace_members`

```text
id
workspace_id
user_id
role
status
joined_at
created_at
updated_at
```

Future roles:

```text
owner
admin
member
viewer
```

Aunque el MVP sea personal, esta tabla evita rediseñar ownership después.

---

# 9. `user_preferences`

Preferencias generales de producto.

```text
id
workspace_id
user_id
key
value_json
source
created_at
updated_at
```

Útil para settings simples que no justifican tabla propia.

No usar como reemplazo de Rules.

---

# 10. Provider Layer Overview

Core entities:

```text
provider_definitions
provider_connections
capability_bindings
connection_capabilities
```

---

# 11. `provider_definitions`

Catálogo interno de providers soportados.

```text
id
provider_key
display_name
auth_type
status
supports_multiple_accounts
metadata
created_at
updated_at
```

Ejemplos:

```text
google
notion
elise_native
web_search
```

---

# 12. `capability_definitions`

Catálogo de capabilities.

```text
id
capability_key
display_name
description
risk_metadata
status
created_at
updated_at
```

Ejemplos:

```text
email
calendar
tasks
knowledge
finance
habits
voice
web_search
```

---

# 13. `provider_capabilities`

Qué capabilities ofrece cada provider.

```text
id
provider_id
capability_id
supported_operations
metadata
created_at
updated_at
```

Ejemplo:

```text
Google
→ email
→ calendar
→ drive knowledge
→ tasks
→ sheets
```

---

# 14. `provider_connections`

Representa una cuenta externa concreta.

```text
id
workspace_id
provider_id
created_by_user_id
external_account_id
display_name
account_label
status
auth_metadata
last_health_check_at
last_connected_at
last_error_code
last_error_at
created_at
updated_at
disconnected_at
```

No guardar tokens sin protección adecuada en campos comunes.

---

# 15. Connection Secret Storage

Credentials sensibles deben almacenarse mediante mecanismo seguro server-side.

Conceptualmente:

```text
connection_secrets
```

pero su implementación puede usar:

- encrypted storage;
- Supabase Vault/secret mechanism;
- server-side encrypted table.

Nunca devolver estos valores al cliente.

---

# 16. `connection_capabilities`

Capabilities habilitadas por connection.

```text
id
workspace_id
connection_id
capability_id
enabled
permission_level
authorized_scopes
created_at
updated_at
```

---

# 17. `capability_bindings`

Relaciona capability + provider/connection + contexto.

```text
id
workspace_id
capability_id
connection_id
context_type
context_id
priority
is_default
enabled
configuration
created_at
updated_at
```

Ejemplo:

```text
email
→ Gmail Acme
→ context = work.acme
```

---

# 18. Conversation Domain

Core:

```text
conversations
messages
conversation_summaries
ai_runs
```

---

# 19. `conversations`

```text
id
workspace_id
user_id
title
status
last_message_at
active_context
created_at
updated_at
archived_at
```

Historial accesible pero no protagonista.

---

# 20. `messages`

```text
id
conversation_id
workspace_id
role
content
content_format
run_id
created_at
metadata
```

Roles:

```text
user
assistant
system_internal
tool_summary
```

No almacenar secretos en mensajes.

---

# 21. `conversation_summaries`

```text
id
conversation_id
workspace_id
summary
current_objective
open_questions
relevant_entity_ids
version
created_at
updated_at
```

Permite mantener contexto de conversaciones largas.

---

# 22. `ai_runs`

Representa cada ejecución de ELISE Runtime.

```text
id
workspace_id
user_id
conversation_id
ai_provider
model_key
skill_key
status
started_at
completed_at
latency_ms
token_usage
cost_metadata
context_snapshot_metadata
error_code
created_at
```

No guardar prompts completos indiscriminadamente si contienen información sensible.

---

# 23. Memory Domain

Core:

```text
memories
memory_sources
```

---

# 24. `memories`

```text
id
workspace_id
user_id
memory_type
content
status
confidence
strength
confirmed
importance
last_used_at
confirmed_at
superseded_by_id
created_at
updated_at
```

Possible `memory_type`:

```text
preference
stable_fact
work_context
relationship
workflow_preference
```

---

# 25. `memory_sources`

Provenance de una memory.

```text
id
memory_id
source_type
source_reference
evidence_summary
created_at
```

Ejemplos:

```text
conversation
user_confirmation
repeated_behavior
entity
manual_edit
```

---

# 26. Rules Domain

Core:

```text
rules
rule_audit_events
```

---

# 27. `rules`

```text
id
workspace_id
name
description
rule_type
scope_type
scope_id
capability_id
operation
condition_json
instruction
priority
enabled
source
created_by_user_id
created_at
updated_at
```

`rule_type`:

```text
permission
routing
filtering
formatting
planning
notification
behavior
content_relevance
```

---

# 28. `rule_audit_events`

```text
id
workspace_id
rule_id
user_id
event_type
previous_value
new_value
created_at
```

Especialmente útil para cambios de autonomía.

---

# 29. Entity Domain

Core:

```text
entities
entity_aliases
entity_relationships
entity_links
```

---

# 30. `entities`

```text
id
workspace_id
entity_type
name
description
status
importance
metadata
created_at
updated_at
archived_at
```

Possible types:

```text
person
organization
client
project
course
subject
location
account
goal_reference
custom
```

---

# 31. `entity_aliases`

```text
id
workspace_id
entity_id
alias
normalized_alias
source
created_at
```

Useful for:

```text
Alex
Alex Morgan
```

---

# 32. `entity_relationships`

```text
id
workspace_id
source_entity_id
relationship_type
target_entity_id
confidence
confirmed
source
created_at
updated_at
```

Ejemplos:

```text
person → works_at → organization
project → belongs_to → client
```

---

# 33. `entity_links`

Generic relation from domain records to entities.

```text
id
workspace_id
entity_id
resource_type
resource_id
relationship_type
confidence
source
created_at
```

Ejemplo:

```text
Task #123
→ Project ELISE
```

Puede evaluarse posteriormente si algunas relaciones merecen tablas explícitas.

---

# 34. Knowledge Domain

Core:

```text
knowledge_spaces
knowledge_sources
knowledge_items
knowledge_versions
knowledge_chunks
knowledge_sync_runs
knowledge_item_entities
```

---

# 35. `knowledge_spaces`

```text
id
workspace_id
parent_space_id
name
description
slug
status
created_by_user_id
created_at
updated_at
archived_at
```

Supports hierarchy.

---

# 36. `knowledge_sources`

Representa una fuente conectada o nativa.

```text
id
workspace_id
space_id
provider_id
connection_id
source_type
external_root_id
display_name
source_url
sync_mode
status
last_synced_at
next_sync_at
configuration
created_at
updated_at
```

---

# 37. `knowledge_items`

```text
id
workspace_id
space_id
source_id
source_provider
external_id
item_type
title
source_url
mime_type
status
current_version_id
external_modified_at
last_synced_at
metadata
created_at
updated_at
archived_at
```

---

# 38. `knowledge_versions`

```text
id
workspace_id
knowledge_item_id
version_number
source_revision
content_hash
extracted_content
parser_version
chunking_version
created_at
is_current
metadata
```

---

# 39. `knowledge_chunks`

```text
id
workspace_id
space_id
knowledge_item_id
version_id
chunk_index
content
embedding
heading_path
page_number
token_count
metadata
created_at
```

Indexes:

```text
workspace_id
space_id
knowledge_item_id
vector index
text search index
```

---

# 40. `knowledge_item_entities`

Optional explicit entity relationship.

```text
id
workspace_id
knowledge_item_id
entity_id
relationship_type
confidence
source
created_at
```

---

# 41. `knowledge_sync_runs`

```text
id
workspace_id
source_id
background_job_id
status
started_at
completed_at
items_discovered
items_created
items_updated
items_removed
items_failed
error_summary
created_at
```

---

# 42. Native Structured Data Overview

Native modules:

```text
tasks
task_lists
habits
habit_entries
lists
list_items
finance_accounts
finance_categories
finance_transactions
goals
goal_links
notes
```

Cada dominio permanece separado.

---

# 43. `task_lists`

```text
id
workspace_id
name
description
status
created_at
updated_at
```

---

# 44. `tasks`

```text
id
workspace_id
task_list_id
title
description
status
priority
start_at
due_at
completed_at
created_by_user_id
source
metadata
created_at
updated_at
archived_at
```

Suggested status:

```text
pending
in_progress
completed
cancelled
```

---

# 45. `habits`

```text
id
workspace_id
name
description
frequency_type
target_value
target_period
unit
schedule_definition
active
start_date
created_at
updated_at
archived_at
```

---

# 46. `habit_entries`

```text
id
workspace_id
habit_id
occurred_at
value
status
notes
source
created_at
updated_at
```

Unique/dedup constraint may depend on habit semantics.

---

# 47. `lists`

```text
id
workspace_id
name
description
status
created_at
updated_at
archived_at
```

---

# 48. `list_items`

```text
id
workspace_id
list_id
content
checked
position
notes
created_at
updated_at
archived_at
```

---

# 49. Finance Domain

Core:

```text
finance_accounts
finance_categories
finance_transactions
finance_imports
finance_import_rows
```

---

# 50. `finance_accounts`

Represents conceptual accounts/payment sources.

```text
id
workspace_id
name
account_type
currency
status
metadata
created_at
updated_at
```

No implica conexión bancaria real.

---

# 51. `finance_categories`

```text
id
workspace_id
parent_category_id
name
category_type
status
created_at
updated_at
```

Possible `category_type`:

```text
income
expense
both
```

---

# 52. `finance_transactions`

```text
id
workspace_id
transaction_type
amount
currency
transaction_date
account_id
category_id
subcategory_text
counterparty
payment_method
status
notes
source
import_id
created_at
updated_at
archived_at
```

Nunca mezclar monedas silenciosamente en queries.

---

# 53. `goals`

```text
id
workspace_id
title
description
status
target_date
progress_type
progress_value
target_value
metric
parent_goal_id
created_at
updated_at
archived_at
```

---

# 54. `goal_links`

Relates goals to native records/entities.

```text
id
workspace_id
goal_id
resource_type
resource_id
relationship_type
created_at
```

Ejemplos:

```text
Goal → Habit
Goal → Task
Goal → Project Entity
```

---

# 55. `notes`

```text
id
workspace_id
title
content
space_id
status
created_by_user_id
created_at
updated_at
archived_at
```

Notes are source-of-truth Native records and can be indexed into Knowledge.

---

# 56. Notes ↔ Knowledge

Recommended relation:

```text
notes.id
→ knowledge_items.external_id / native reference
```

Prefer explicit reference field:

```text
native_resource_type
native_resource_id
```

rather than duplicating editable content.

---

# 57. Import Domain

Generic import infrastructure:

```text
imports
import_rows
```

May serve Finance and future modules.

---

# 58. `imports`

```text
id
workspace_id
import_type
source_type
source_reference
status
mapping_config
total_rows
valid_rows
invalid_rows
created_by_user_id
started_at
completed_at
created_at
```

---

# 59. `import_rows`

```text
id
workspace_id
import_id
source_row_number
raw_data
normalized_data
status
error_details
created_resource_type
created_resource_id
created_at
```

Useful for review and rollback.

---

# 60. Schedules Domain

Core:

```text
schedules
schedule_runs
scheduled_results
```

---

# 61. `schedules`

```text
id
workspace_id
created_by_user_id
name
schedule_type
status
timezone
schedule_definition
action_type
configuration
instructions
delivery_config
approval_behavior
next_run_at
last_run_at
runtime_reference
created_at
updated_at
archived_at
```

Types MVP:

```text
one_time
recurring
```

---

# 62. `schedule_runs`

```text
id
workspace_id
schedule_id
background_job_id
status
scheduled_for
started_at
completed_at
approval_id
result_id
error_code
error_message
runtime_metadata
created_at
```

---

# 63. `scheduled_results`

```text
id
workspace_id
schedule_run_id
result_type
title
content
artifact_reference
read_at
metadata
created_at
```

Examples:

```text
Morning Brief
Weekly Finance Review
Planning Result
```

---

# 64. Background Domain

Core:

```text
background_jobs
background_job_events
```

---

# 65. `background_jobs`

```text
id
workspace_id
user_id
job_type
status
progress_current
progress_total
progress_message
runtime_provider
runtime_job_id
result_reference
error_code
error_message
started_at
completed_at
created_at
updated_at
```

---

# 66. `background_job_events`

Optional detailed timeline.

```text
id
background_job_id
workspace_id
event_type
step_key
message
metadata
created_at
```

Useful for debugging/realtime history.

---

# 67. Tools & Actions Domain

Core:

```text
actions
tool_executions
approvals
```

---

# 68. `actions`

```text
id
workspace_id
user_id
ai_run_id
capability_id
operation
provider_id
connection_id
target_type
target_id
risk_level
status
input_snapshot
approval_id
idempotency_key
result_reference
created_at
executed_at
updated_at
```

---

# 69. `tool_executions`

```text
id
workspace_id
action_id
ai_run_id
tool_name
provider_id
connection_id
status
latency_ms
retry_count
error_code
result_metadata
started_at
completed_at
created_at
```

Do not store full sensitive payloads unnecessarily.

---

# 70. `approvals`

```text
id
workspace_id
user_id
action_id
capability_id
operation
provider_id
connection_id
risk_level
payload_snapshot
summary
reason
status
expires_at
created_at
resolved_at
resolved_by_user_id
```

---

# 71. Approval Integrity

An Approval must refer to a specific action/version.

If the action materially changes:

```text
old approval → superseded
new approval → required
```

---

# 72. Notifications Domain

Core:

```text
notifications
notification_deliveries
```

---

# 73. `notifications`

```text
id
workspace_id
user_id
notification_type
title
content
priority
source_type
source_id
action_url
read_at
created_at
expires_at
metadata
```

---

# 74. `notification_deliveries`

Tracks channels.

```text
id
notification_id
channel
status
sent_at
error_code
metadata
created_at
```

MVP channels:

```text
in_app
browser
```

Future:

```text
email
whatsapp
mobile_push
slack
```

---

# 75. Audit Domain

Core:

```text
audit_events
```

---

# 76. `audit_events`

```text
id
workspace_id
user_id
event_type
resource_type
resource_id
action
provider_id
connection_id
approval_id
result
metadata
created_at
```

Examples:

```text
connection.created
email.sent
rule.updated
schedule.paused
transaction.deleted
```

---

# 77. Audit Data Policy

Audit records should preserve:

```text
who
what
when
where
result
```

Avoid storing:

- credentials;
- full email bodies unless necessary;
- secrets;
- excessive sensitive content.

---

# 78. Realtime Strategy

Tables likely subscribed through Supabase Realtime:

```text
notifications
approvals
background_jobs
schedule_runs
scheduled_results
knowledge_sources / sync state
tasks
habit_entries
```

Do not subscribe every table globally.

---

# 79. Realtime Ownership

Every realtime query must be scoped by:

```text
workspace_id
```

RLS must still apply.

---

# 80. RLS Strategy

All workspace-owned tables should have RLS.

Policy concept:

```text
authenticated user
must be member of workspace
```

Future role permissions may refine writes.

---

# 81. Defense in Depth

RLS is not the only authorization layer.

Application Services must also verify:

```text
workspace
connection ownership
operation permissions
resource ownership
```

---

# 82. Soft Delete Strategy

Use `archived_at` or status instead of immediate physical delete where useful.

Candidates:

```text
tasks
notes
goals
finance_transactions
knowledge_spaces
schedules
```

Physical deletion may occur later based on retention/privacy policies.

---

# 83. Foreign Key Deletion Behavior

Avoid aggressive cascading from user-visible domain objects if it could erase audit/history unexpectedly.

Examples:

```text
Schedule deleted
→ preserve schedule_runs where policy permits

Connection disconnected
→ preserve audit events
```

Use deliberate FK policies.

---

# 84. JSONB Usage

Good uses:

```text
provider-specific metadata
extensible configuration
runtime metadata
optional source attributes
```

Bad use:

```text
entire Task stored as JSON
entire Finance model stored as JSON
```

Important searchable semantics deserve real columns.

---

# 85. Enums

Postgres enums may be used selectively.

For rapidly evolving product states, lookup/text constraints may offer easier migrations.

Avoid irreversible enum overuse early.

---

# 86. Time Storage

Use:

```text
timestamptz
```

Store timezone identifiers separately for schedules:

```text
America/Argentina/Buenos_Aires
```

Never store user-facing schedule semantics only as UTC.

---

# 87. Currency Storage

Store amounts using exact numeric types.

Example:

```text
numeric(18, 4)
```

Avoid floating point.

Currency:

```text
ISO 4217 code
```

Example:

```text
ARS
USD
EUR
```

---

# 88. Text Search

Use PostgreSQL full-text indexes where useful.

Candidates:

```text
notes
tasks
entities
knowledge metadata
conversation titles
```

Hybrid Knowledge retrieval combines full-text + vector.

---

# 89. Vector Search

`knowledge_chunks.embedding`

Use pgvector index appropriate to scale.

Also persist:

```text
embedding_model
embedding_version
```

either on chunk or related metadata.

---

# 90. Source Provenance

Every externally sourced object should preserve where it came from.

Examples:

```text
provider_id
connection_id
external_id
source_url
external_modified_at
```

Provenance should survive normalization.

---

# 91. Canonical IDs vs External IDs

Internal relationships always use ELISE UUIDs.

External provider identifiers are metadata.

Example:

```text
knowledge_item.id
→ ELISE UUID

knowledge_item.external_id
→ Google Drive file ID
```

Never use provider IDs as primary database keys.

---

# 92. Context References

Do not create one universal `context` table immediately.

Use:

```text
workspace
entities
knowledge spaces
capability bindings
rules
active_context JSON snapshots
```

Introduce additional normalized context models only when real usage requires them.

---

# 93. Cross-Domain Linking

Preferred mechanism:

```text
entities
+
entity_links
```

rather than direct nullable columns for every possible relationship.

However, when a relation is core and high-volume, explicit FK may be better.

Use judgment.

---

# 94. Model for Native vs External

Native record:

```text
Task
→ row in tasks
```

External task:

```text
Provider Adapter
→ live external object
```

Do not mirror all external objects into Native tables unless specifically creating cache/sync models.

---

# 95. External Cache Tables

If needed later, caches should clearly declare:

```text
source
freshness
external ID
last_synced_at
```

Never confuse cache with source-of-truth.

---

# 96. Searchable External Email

MVP may query Gmail live.

If derived metadata is stored for intelligence, keep separate from canonical external email.

Potential future:

```text
email_metadata_cache
```

Do not prematurely replicate entire mailbox.

---

# 97. Morning Brief Configuration

Could live in:

```text
schedules.configuration
```

and/or dedicated experience settings.

Recommended MVP:

```text
schedule
+
typed configuration JSON
```

Because Morning Brief is a specific Schedule type.

If configuration grows significantly, extract dedicated table later.

---

# 98. Study Progress

Potential tables:

```text
study_sessions
study_attempts
study_topic_progress
```

MVP can introduce these when Study implementation begins.

Avoid creating speculative tables before required.

---

# 99. Voice Sessions

Potential:

```text
voice_sessions
```

Only needed if we persist voice-specific metadata beyond Conversation.

Text transcript can remain in Messages.

---

# 100. Location Data

Do not persist exact location by default.

Future location requests should be treated as ephemeral context unless the user explicitly stores a place/entity.

If saved:

```text
Entity type = location
```

---

# 101. Web Search Results

Normally transient.

Do not persist every search result permanently.

Persist only:

- references used in durable results;
- saved user research;
- necessary audit metadata.

---

# 102. Data Retention

Each domain should define retention later.

Examples:

```text
audit
AI runs
tool execution details
background logs
old Knowledge versions
notifications
```

Retention should balance:

- privacy;
- debugging;
- cost;
- user value.

---

# 103. Data Deletion

Deleting a user/workspace eventually requires coordinated cleanup across:

```text
Native data
Knowledge
Storage
Connections
Credentials
Memory
Conversations
Schedules
Notifications
```

Audit/legal retention policies may require exceptions.

Detailed lifecycle belongs in security/privacy implementation.

---

# 104. Suggested MVP Schema Groups

Recommended migration grouping:

```text
001_core_tenancy
002_provider_registry
003_connections
004_conversations
005_memory_entities_rules
006_knowledge
007_native_tasks_habits_lists
008_native_finance_goals_notes
009_schedules_background
010_actions_approvals
011_notifications_audit
012_indexes_rls
```

Actual migration sequence can change.

---

# 105. Indexing Strategy

At minimum index:

```text
workspace_id
foreign keys
status fields used in queues
next_run_at
created_at where sorted
external_id + connection/source
normalized aliases
due_at
transaction_date
last_synced_at
```

Composite indexes should reflect real queries.

---

# 106. Unique Constraints

Examples:

```text
workspace + provider + external_account_id
entity alias where appropriate
knowledge source + external item ID
schedule idempotency windows
import row identity
```

Do not over-constrain aliases where legitimate duplicates exist.

---

# 107. Idempotency Storage

Actions requiring idempotency may use:

```text
actions.idempotency_key
```

Unique within appropriate scope.

Example:

```text
UNIQUE(workspace_id, idempotency_key)
```

when semantics support it.

---

# 108. Background Locking

For concurrency-sensitive resources, use:

- DB uniqueness;
- advisory locks;
- runtime concurrency controls;
- state transitions.

Example:

```text
one active Knowledge sync per source
```

---

# 109. Status Transitions

Critical objects should have controlled transitions.

Example `approval`:

```text
Pending
→ Approved / Rejected / Expired / Cancelled
```

Do not allow:

```text
Approved → Pending
```

without explicit new version.

---

# 110. Transactional Updates

Use DB transactions for local multi-table changes.

Example:

```text
Approve action
+
mark approval approved
+
transition action to executing
```

must avoid race conditions.

---

# 111. Optimistic UI

UI may optimistically update low-risk Native data.

Example:

```text
check task complete
```

But backend remains authoritative.

External actions should generally wait for provider confirmation.

---

# 112. Supabase Storage Model

Suggested buckets:

```text
knowledge-originals
generated-artifacts
user-avatars
```

Paths should include workspace boundaries.

Example:

```text
workspace/{workspace_id}/knowledge/{item_id}/...
```

---

# 113. Storage Metadata

Postgres remains source of metadata.

Do not rely solely on object-storage folder names.

---

# 114. File Version Storage

For uploaded Knowledge:

```text
KnowledgeVersion
→ storage object reference
```

Avoid overwriting original bytes if version history should remain available.

---

# 115. Data Model and AI Boundaries

AI should interact through services/tools, not directly with database tables.

Correct:

```text
AI
→ tasks.list
→ TaskService
→ Repository
→ PostgreSQL
```

Incorrect:

```text
AI generates arbitrary SQL
```

---

# 116. Repository Layer

Conceptually:

```text
TaskRepository
KnowledgeRepository
MemoryRepository
ScheduleRepository
ApprovalRepository
```

Application Services consume repositories.

This keeps DB details out of domain logic.

---

# 117. Schema Evolution

Prefer additive migrations.

Avoid destructive schema changes unless:

- data migrated;
- deployment coordinated;
- rollback considered.

Provider metadata should tolerate evolution.

---

# 118. Development Seed Data

Local/staging can include synthetic:

```text
users
workspaces
tasks
habits
Knowledge Spaces
providers
schedules
```

Never copy production data casually into development.

---

# 119. Observability Fields

Useful shared IDs:

```text
request_id
run_id
action_id
background_job_id
```

Not every table needs every ID.

Use where tracing matters.

---

# 120. MVP Entity Relationship Overview

```text
User
 └── Workspace
      ├── Provider Connections
      │    └── Capability Bindings
      │
      ├── Conversations
      │    ├── Messages
      │    └── AI Runs
      │
      ├── Memory
      ├── Rules
      ├── Entities
      │    └── Relationships
      │
      ├── Knowledge Spaces
      │    └── Sources
      │         └── Items
      │              └── Versions
      │                   └── Chunks
      │
      ├── My Elise
      │    ├── Tasks
      │    ├── Habits
      │    ├── Lists
      │    ├── Finance
      │    ├── Goals
      │    └── Notes
      │
      ├── Schedules
      │    └── Schedule Runs
      │         └── Results
      │
      ├── Background Jobs
      ├── Actions
      │    └── Approvals
      │
      ├── Notifications
      └── Audit Events
```

---

# 121. Tables Recommended for Initial MVP

Core:

```text
user_profiles
workspaces
workspace_members
```

Providers:

```text
provider_definitions
capability_definitions
provider_capabilities
provider_connections
connection_capabilities
capability_bindings
```

Chat:

```text
conversations
messages
conversation_summaries
ai_runs
```

Context:

```text
memories
memory_sources
rules
entities
entity_aliases
entity_relationships
entity_links
```

Knowledge:

```text
knowledge_spaces
knowledge_sources
knowledge_items
knowledge_versions
knowledge_chunks
knowledge_sync_runs
```

Native:

```text
task_lists
tasks
habits
habit_entries
lists
list_items
finance_accounts
finance_categories
finance_transactions
goals
goal_links
notes
imports
import_rows
```

Automation:

```text
schedules
schedule_runs
scheduled_results
background_jobs
```

Actions:

```text
actions
tool_executions
approvals
```

System:

```text
notifications
notification_deliveries
audit_events
```

---

# 122. Tables That Should Wait Until Needed

Do not implement prematurely:

```text
team billing
subscription plans
enterprise roles
advanced CRM
study graph
voice analytics
location history
custom provider marketplace
advanced notification routing
bank connections
organization hierarchy
```

---

# 123. RLS Requirement

Before a table holding user data is considered production-ready:

```text
RLS enabled
membership policy defined
service-role access understood
tests written
```

No “temporary” public tables containing user data.

---

# 124. Data Model Testing

Tests should cover:

- cross-workspace isolation;
- cascade behavior;
- duplicate external IDs;
- approval races;
- schedule concurrency;
- import rollback;
- Knowledge version switching;
- entity merge behavior;
- soft-delete filtering;
- idempotent actions.

---

# 125. Migration Acceptance Checklist

Before merging migration:

```text
[ ] workspace ownership defined
[ ] foreign keys defined
[ ] indexes considered
[ ] RLS enabled
[ ] status transitions valid
[ ] timestamps consistent
[ ] secret data avoided
[ ] rollback/migration impact reviewed
[ ] repository/service usage planned
```

---

# 126. North Star

> **The database should model the user's world clearly without becoming the user's interface.**
>
> Workspaces create boundaries.
>
> Entities create relationships.
>
> Native modules create structured truth.
>
> Knowledge preserves evidence.
>
> Connections preserve external ownership.
>
> Runs, Actions and Audit preserve what happened.

---

# Implementation note (2026-10-01)

Migration `20261001000019_contexts_study.sql` adds `context_profiles`, `context_links`, `entities`, `context_interactions`, `study_concepts`, `study_sessions` and `study_attempts`, and `live_workspaces.context_profile_id` (ADR-016). §92's "no universal context table yet" is superseded by real usage: Context Profiles organize, they never become a source of truth.
