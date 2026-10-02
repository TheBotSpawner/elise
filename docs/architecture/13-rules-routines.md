# ELISE — Rules & Schedules

**Document:** `13-rules-routines.md`  
**Status:** Draft v1  
**User-facing terminology:** `Schedules` / `Programados`  
**Internal note:** The filename remains `rules-routines` for roadmap consistency, but `Routines` should not be treated as the final product name.

**Purpose:** Definir cómo ELISE representa reglas explícitas del usuario, tareas programadas, recurrencias, configuración natural-language-first, ejecución futura, aprobaciones, resultados, notificaciones y futuras automatizaciones event/condition based.

---

# 1. Vision

ELISE debe poder actuar de forma consistente en dos dimensiones distintas:

```text
Rules
→ How ELISE should behave.

Schedules
→ What ELISE should do later or repeatedly.
```

Ejemplo:

```text
Rule:
Never send client emails without asking me first.

Schedule:
Every weekday at 07:30 prepare my Morning Brief.
```

Estos conceptos deben permanecer separados.

---

# 2. User-Facing Naming

El nombre provisional en inglés será:

```text
Schedules
```

En español:

```text
Programados
```

Alternativas futuras pueden explorarse durante UX testing, por ejemplo:

```text
Recurrentes
Automatizaciones
Planes
```

No utilizar `Routines` como nombre público definitivo.

---

# 3. Rules

Una Rule es una instrucción persistente que modifica cómo ELISE debe comportarse.

Ejemplos:

```text
Always ask before sending an email.

Use my Acme Gmail for client communication.

Don't include newsletters in my Morning Brief.

When planning my day, leave 15 minutes between meetings.

Never create calendar events in my Personal calendar for work.
```

Rules pueden influir sobre:

- AI behavior;
- provider resolution;
- approvals;
- planning;
- Morning Brief;
- notifications;
- email;
- calendar;
- Finance;
- Study;
- Schedules.

---

# 4. Rules Are Explicit

Rules deben ser principalmente explícitas.

Una preferencia inferida puede sugerirse como Rule, pero no debe convertirse silenciosamente en una instrucción operativa fuerte.

Ejemplo:

```text
ELISE notices:
User always chooses Acme Gmail for Client A.

Suggestion:
"Should I always use Acme Gmail for Client A?"
```

Si el usuario confirma:

```text
Rule created.
```

---

# 5. Rules vs Memory

Ejemplo Memory:

```text
Leo usually plans tomorrow in the evening.
```

Ejemplo Rule:

```text
When I ask to plan tomorrow, use my evening planning method.
```

Memory informa.

Rule instruye.

---

# 6. Rules vs Permissions

Una Rule no puede saltarse límites de seguridad.

Ejemplo:

```text
Rule:
Send emails automatically.
```

Si una hard security policy requiere aprobación para una categoría de acción:

```text
hard policy wins.
```

Orden conceptual:

```text
Hard security policy
Current explicit instruction
Explicit Rule
Confirmed preference
Inferred preference
Model inference
```

---

# 7. Rule Scope

Rules pueden tener distintos scopes.

Ejemplos:

```text
Global
Capability
Provider
Connection
Context
Entity
Schedule
Skill
```

---

# 8. Global Rules

Aplican ampliamente.

Ejemplo:

```text
Keep work summaries concise.
```

---

# 9. Capability Rules

Ejemplo:

```text
Email:
Never auto-send.

Calendar:
Create personal reminders without asking.
```

---

# 10. Connection Rules

Ejemplo:

```text
Gmail Acme:
Client emails → Always Ask before send.

Gmail Personal:
Family emails → Ask When Uncertain.
```

---

# 11. Context Rules

Ejemplo:

```text
Acme:
Use Work Gmail.
Use Acme Calendar.

Personal:
Use Personal Calendar.
```

---

# 12. Entity Rules

Ejemplo:

```text
Client A:
Always use Acme work email.
Include recent open tasks in meeting prep.
```

---

# 13. Planning Rules

ELISE debe soportar reglas específicas de planificación.

Ejemplo:

```text
Start planning after 08:00.
Never schedule lunch meetings.
Leave 15 minutes between meetings.
Prioritize gym before 18:00.
Keep deep work blocks at least 60 minutes.
```

Esto permite que el usuario configure su método personal de planificación.

---

# 14. Morning Brief Rules

Ejemplo:

```text
Include:
Calendar
Important Email
Tasks
Habits
Relevant News

Do not include:
Newsletters

News relevance:
AI, automation, business and topics related to active projects.
```

Checkboxes y configuración libre pueden coexistir.

---

# 15. Rule Model

Modelo conceptual:

```text
Rule

id
workspace_id
name
description
scope_type
scope_id
capability
operation
condition
instruction
priority
enabled
source
created_at
updated_at
```

---

# 16. Rule Priority

Cuando varias rules aplican:

```text
more specific rule
→ wins over broader rule
```

Ejemplo:

```text
Global:
Send Email → Always Ask

Client A:
Send internal Client A email → Allow Automatically
```

Si hard security policy lo permite:

```text
Client A-specific rule
→ wins
```

---

# 17. Rule Conflicts

Si existen reglas incompatibles:

```text
ELISE should not guess silently.
```

Opciones:

```text
resolve by specificity
resolve by explicit priority
ask user
surface conflict in Settings
```

---

# 18. Rule Creation

Rules pueden crearse desde:

```text
Settings
Chat
Approval flows
Provider setup
Planning setup
Morning Brief setup
```

Ejemplo:

> “Para clientes preguntame siempre antes de mandar mails.”

ELISE interpreta:

```text
Capability:
Email

Operation:
Send

Context:
Clients

Policy:
Always Ask
```

Luego muestra una representación estructurada antes de guardar si la regla tiene impacto importante.

---

# 19. Rule Editing

El usuario debe poder:

```text
enable
disable
edit
delete
inspect scope
```

UI:

```text
Rules

Email
• Always ask before sending client emails

Planning
• Leave 15 minutes between meetings
```

---

# 20. Rules Should Be Human-Readable

Aunque se almacenen estructuradamente, deben poder explicarse en lenguaje natural.

Ejemplo:

```text
"When communicating with Client A, use Acme Gmail."
```

No mostrar:

```text
context_id=8392
priority=80
provider_binding=12
```

salvo en modo técnico.

---

# 21. Schedules

Un Schedule representa una acción o experiencia que ELISE ejecutará en un momento futuro o repetidamente.

Ejemplos:

```text
Every weekday at 07:30 → Morning Brief

Every Friday → Finance Review

Tomorrow at 18:00 → Remind me to call Juan

30 minutes before class → Prepare review
```

---

# 22. Schedule Principles

Schedules deben ser:

- easy to create;
- easy to inspect;
- easy to pause;
- easy to edit;
- easy to delete;
- transparent;
- non-invasive;
- resumable;
- observable.

---

# 23. Natural Language First

El camino principal para crear un Schedule será lenguaje natural.

Ejemplo:

> “Todos los días de semana a las 7:30 preparame el Morning Brief.”

ELISE transforma esto en:

```text
Name:
Morning Brief

When:
Monday–Friday
07:30

Action:
Prepare Morning Brief

Delivery:
ELISE

Status:
Active
```

El usuario confirma.

---

# 24. Structured Representation

Nunca almacenar solamente un prompt libre como definición de Schedule.

Un Schedule debe tener estructura.

Modelo conceptual:

```text
Schedule

id
workspace_id
name
type
status
timezone
schedule_definition
action_type
configuration
instructions
delivery
approval_behavior
next_run_at
last_run_at
created_at
updated_at
```

---

# 25. Schedule Types — MVP

El MVP soportará principalmente:

```text
One-Time
Recurring
```

Ejemplos:

```text
Tomorrow 18:00

Every Monday 09:00

Weekdays 07:30
```

---

# 26. Future Trigger Types

Post-MVP:

```text
Event
Condition
Manual
```

Ejemplos:

```text
Event:
When a client email arrives.

Condition:
When weekly habit target is at risk.

Manual:
Run from button / API / shortcut.
```

---

# 27. Scheduled Task Configuration

Un Schedule puede incluir:

```text
trigger
action
capabilities
scope
inputs
rules
delivery
notification behavior
approval behavior
custom instructions
```

---

# 28. Schedule Example — Morning Brief

```text
Name:
Morning Brief

Trigger:
Weekdays 07:30

Inputs:
Calendar
Important Email
Tasks
Habits
News

Custom instructions:
Only include news relevant to AI, automation or my active projects.

Output:
Brief

Delivery:
ELISE Inbox

Notify:
Browser notification
```

---

# 29. Schedule Example — Weekly Finance Review

```text
Name:
Weekly Finance Review

Trigger:
Friday 18:00

Input:
ELISE Finance

Output:
Weekly summary

Include:
Expenses
Income
Category changes
Unusual spending

Delivery:
ELISE
```

---

# 30. Schedule Example — Pre-Meeting Brief

```text
Name:
Prepare meeting briefs

Trigger:
30 minutes before selected meetings

Capabilities:
Calendar
Email
Knowledge
Tasks

Output:
Meeting preparation brief
```

This is closer to an Event Schedule and may belong post-MVP if event-trigger infrastructure is not ready.

---

# 31. Schedule States

```text
Draft
Active
Paused
Running
Waiting for Approval
Completed
Failed
Disabled
Archived
```

Recurring Schedules normally return to:

```text
Active
```

after each execution.

---

# 32. Schedule Lifecycle

```text
Create
 ↓
Confirm
 ↓
Active
 ↓
Trigger fires
 ↓
Execution
 ↓
Result
 ↓
Next run
```

Optional:

```text
Pause
Edit
Run Now
Delete
```

---

# 33. Run Now

Every compatible Schedule should support:

```text
Run now
```

This lets the user:

- test configuration;
- consume result immediately;
- debug;
- preview behavior.

Running now does not modify the normal future cadence unless explicitly chosen.

---

# 34. Pause

Pause should:

```text
stop future triggers
preserve configuration
preserve history
```

Resume restores future execution.

---

# 35. Edit

When changing schedule timing or behavior:

```text
validate
update trigger
recalculate next_run_at
```

If currently running, the existing run may continue unless the user cancels it.

---

# 36. Delete

Deleting a Schedule must not silently delete its historical outputs unless retention policy says so.

It should remove future execution.

For important Schedules, a confirmation may be appropriate.

---

# 37. Schedule Execution

Trigger.dev handles durable execution.

Flow:

```text
Trigger
 ↓
Trigger.dev
 ↓
ScheduledTaskService
 ↓
Load Schedule
 ↓
Resolve user/workspace
 ↓
Load Rules
 ↓
Resolve capabilities
 ↓
Execute workflow
 ↓
Persist Run
 ↓
Persist Result
 ↓
Notify user
```

---

# 38. Trigger.dev Is Infrastructure

Schedules must not depend directly on Trigger.dev concepts.

Domain:

```text
Schedule
ScheduleRun
ScheduledAction
```

Infrastructure:

```text
TriggerDevRuntime
```

This keeps the runtime replaceable.

---

# 39. Schedule Run

Every execution creates a `ScheduleRun`.

Conceptual model:

```text
ScheduleRun

id
schedule_id
workspace_id
status
started_at
completed_at
result_reference
error_code
error_message
approval_id
runtime_metadata
```

---

# 40. Execution History

Each Schedule should expose a lightweight history.

Example:

```text
Morning Brief

Today      ✓ Completed
Yesterday  ✓ Completed
Sep 26     ⚠ Gmail unavailable
```

History is useful but should not dominate the UI.

---

# 41. Result Persistence

Scheduled output should remain available after execution.

Example:

```text
Morning Brief — Sep 28
Weekly Finance Review — Week 39
Meeting Prep — Client X
```

The user can open it later.

---

# 42. Non-Invasive Delivery

Scheduled outputs should normally become:

```text
Ready
```

not forcibly interrupt the user.

UI:

```text
Morning Brief ready

[ Read ]
[ Listen ]
```

Principle:

> **ELISE prepares. The user chooses when to consume.**

---

# 43. Notification Policy

A Schedule can define:

```text
No notification
In-app only
Browser notification
Future external channels
```

Notification behavior should be configurable per Schedule.

---

# 44. Future Delivery Channels

Potential future destinations:

```text
Email
WhatsApp
Slack
Teams
Mobile Push
Voice / Call
Webhook
```

These are delivery providers, not the Schedule itself.

---

# 45. Schedule Timezone

Every Schedule must have a timezone context.

Default:

```text
User / workspace timezone
```

Do not assume server timezone.

Store enough data to handle:

- daylight saving;
- travel;
- future timezone updates.

---

# 46. Relative Times

Natural language parser must resolve:

```text
tomorrow morning
every Friday
weekdays at 7:30
first day of every month
```

Before creation, show resolved schedule explicitly.

---

# 47. Ambiguous Time

Example:

> “Recordame a la tarde.”

ELISE should resolve using user defaults where appropriate or ask if precision matters.

A flexible reminder may use a broad daypart rather than inventing false precision.

---

# 48. Schedule Validation

Before activation:

- recurrence is valid;
- timezone exists;
- required capabilities available;
- necessary providers connected;
- required permissions granted;
- configuration valid.

---

# 49. Missing Connection

If Schedule requires Gmail but Gmail is disconnected:

```text
Morning Brief
Needs attention

Email connection unavailable.

[ Reconnect ]
```

Do not silently remove that block unless configured.

---

# 50. Partial Execution

A Schedule may succeed partially.

Example:

```text
Calendar ✓
Tasks ✓
Habits ✓
Email ✕
News ✓
```

Morning Brief can still complete:

```text
Completed with warning
```

The result should mention missing Email if relevant.

---

# 51. Retry Policy

Safe transient errors can retry.

Examples:

```text
provider timeout
temporary network issue
rate limit
```

Do not retry indefinitely.

Retries must avoid duplicate writes.

---

# 52. Idempotency

Every ScheduleRun should have an execution identity.

Write actions should use idempotency where possible.

Example:

```text
ScheduleRun ID
→ idempotency key
```

This avoids duplicate:

- events;
- tasks;
- messages;
- transactions.

---

# 53. Missed Runs

If infrastructure is temporarily unavailable:

ELISE must define behavior per schedule type.

Possible policies:

```text
Run when recovered
Skip missed run
Ask user
```

Defaults should depend on semantics.

Example:

```text
Morning Brief at 07:30
```

Running at 16:00 may be useless.

Example:

```text
Weekly Finance Review
```

Running a few hours late may still be useful.

---

# 54. Overlapping Runs

For recurring Schedules:

```text
if previous run still active
```

possible policy:

```text
skip
queue
cancel previous
allow parallel
```

Default should be chosen by schedule type.

---

# 55. Schedule Concurrency

Avoid duplicate executions for the same Schedule/time window.

Use locking/idempotency.

---

# 56. Approval During Schedule Run

Schedules obey the same approval policies as interactive actions.

Example:

```text
Schedule:
Send weekly follow-up emails

Policy:
email.send → Always Ask
```

Flow:

```text
Run starts
 ↓
Draft created
 ↓
Pending Approval
 ↓
ScheduleRun = Waiting for Approval
 ↓
User approves
 ↓
Continue
```

---

# 57. Approval Expiration

Pending approvals may expire.

Example:

```text
Send meeting reminder before 10:00
```

If user approves after the useful time window:

ELISE should not blindly execute.

The Schedule can mark:

```text
Expired
```

or revalidate before continuing.

---

# 58. Rules Applied to Schedules

Rules must be evaluated at execution time.

Why?

Because rules may change after Schedule creation.

Example:

```text
Schedule created:
auto-send report

Later rule:
Always ask before sending external email
```

Next run must respect the new rule.

---

# 59. Snapshot vs Live Configuration

Some Schedule data should be stored as configuration.

Other data should resolve live.

Example:

Store:

```text
Include Finance
Include News
Weekdays 07:30
```

Resolve live:

```text
current transactions
today's calendar
current account bindings
current Rules
```

---

# 60. Provider Resolution at Run Time

Do not permanently hardcode a provider unless user explicitly selected one.

Example:

```text
Morning Brief
Email capability
```

At run time:

```text
resolve enabled relevant email bindings
```

This allows connection updates without recreating the Schedule.

---

# 61. Explicit Connection Binding

Some Schedules may intentionally target a specific account.

Example:

```text
"Every Friday summarize only my Acme inbox."
```

Then persist:

```text
connection_id = Acme Gmail
```

---

# 62. Schedule Creation From Chat

Example:

> “Cada domingo a la noche haceme una planificación de la semana.”

ELISE:

```text
I’ll set this up as:

Weekly Planning
Sunday evening
Uses Calendar, Tasks, Habits and Goals
Result available in ELISE
```

Then:

```text
[ Create ]
[ Edit ]
```

---

# 63. Schedule Creation From UI

UI should offer a form without requiring technical syntax.

Sections:

```text
What should ELISE do?
When?
What should it use?
How should it notify you?
Additional instructions
```

---

# 64. Templates

MVP may provide suggested templates.

Examples:

```text
Morning Brief
Weekly Review
Finance Review
Pre-Class Review
Email Digest
Daily Planning
```

Templates must remain editable.

---

# 65. Smart Defaults

Example Morning Brief:

```text
Weekdays
07:30
Calendar
Tasks
Important Email
News
```

The user can adjust.

Do not force them to design automation from zero.

---

# 66. Rules UX

Settings can contain:

```text
Rules

General
Email
Calendar
Planning
Morning Brief
Finance
Notifications
```

Rules should be searchable and editable.

---

# 67. Schedule UX

Primary list:

```text
Programados

Morning Brief
Weekdays · 07:30
Next: Tomorrow
Active

Weekly Finance Review
Friday · 18:00
Next: Friday
Active
```

Actions:

```text
Run Now
Pause
Edit
History
Delete
```

---

# 68. Status Visibility

Status indicators should be simple:

```text
Active
Paused
Needs Attention
Running
Waiting Approval
```

Technical runtime status belongs in details.

---

# 69. Results Inbox

Schedules can feed a lightweight results area.

Example:

```text
Ready for you

Morning Brief
Today · 07:31

Finance Review
Friday · 18:02
```

This can also appear as subtle cards near Chat/Home.

---

# 70. Search and History

User should eventually be able to ask:

> “Mostrame el Morning Brief del lunes.”

Scheduled results should therefore have searchable metadata.

---

# 71. Schedule Result Model

Conceptual:

```text
ScheduledResult

id
schedule_run_id
workspace_id
type
title
content
artifact_reference
created_at
read_at
metadata
```

---

# 72. Rule Evaluation Engine

Rules should be resolved deterministically.

Conceptual input:

```text
user
workspace
capability
operation
provider
connection
context
entities
schedule
```

Output:

```text
applicable rules
resolved decision
```

---

# 73. Rule Specificity

Example precedence:

```text
Entity + Operation
Connection + Operation
Context + Capability
Capability
Global
```

Explicit priority can break ties.

---

# 74. Natural Language Rule Parsing

Example:

> “No me muestres noticias de deportes en el Morning Brief.”

Interpret:

```text
scope:
Morning Brief

condition:
news.category = sports

behavior:
exclude
```

Show understandable confirmation.

---

# 75. Free-Text Rules

Not all user instructions need full symbolic representation initially.

A Rule may include:

```text
structured scope
+
free-text instruction
```

Example:

```text
Scope:
Morning Brief / News

Instruction:
"Only include AI news if it could materially affect automation or my business."
```

---

# 76. Deterministic Rules vs AI-Interpreted Rules

Some rules are deterministic:

```text
Never send emails automatically.
```

Others require AI interpretation:

```text
Only show news that matters to my business.
```

Architecture should distinguish them.

---

# 77. Rule Types

Possible categories:

```text
Permission Rule
Routing Rule
Filtering Rule
Formatting Rule
Planning Rule
Notification Rule
Behavior Rule
Content Relevance Rule
```

---

# 78. Permission Rule

Example:

```text
email.send
→ Always Ask
```

Fully deterministic.

---

# 79. Routing Rule

Example:

```text
Client communication
→ Acme Gmail
```

Used by Provider Resolver.

---

# 80. Filtering Rule

Example:

```text
Morning Brief
→ exclude newsletters
```

---

# 81. Formatting Rule

Example:

```text
Meeting briefs
→ concise bullets
```

---

# 82. Planning Rule

Example:

```text
Never schedule gym after 20:00.
```

---

# 83. Notification Rule

Example:

```text
Only notify me for failed Schedules or urgent items.
```

---

# 84. Content Relevance Rule

Example:

```text
News is relevant when:
AI
automation
current clients
business opportunities
```

May require AI interpretation.

---

# 85. Rule Provenance

Each Rule should know its origin:

```text
user created
onboarding
approval remembered
settings
AI suggestion confirmed
migration
```

---

# 86. Rule Audit

Important Rule changes should be logged.

Example:

```text
Email Send
Always Ask
→ Allow Automatically
```

This is security-relevant.

---

# 87. Default Rules

ELISE ships with safe defaults.

Examples:

```text
Read operations → allowed
Send email → ask
Destructive delete → ask
External attendees → ask when uncertain
```

Users customize on top.

---

# 88. Default Schedules

ELISE should not activate many Schedules without consent.

Morning Brief can be configured during onboarding.

Other templates remain suggestions.

No surprise automation.

---

# 89. Schedule Ownership

Every Schedule belongs to:

```text
workspace_id
created_by
```

Future team workspaces may also require:

```text
owner
editors
visibility
```

Not needed in full for personal MVP.

---

# 90. Schedule Security

Before every run validate:

```text
workspace active
schedule enabled
user access
provider bindings
permissions
current rules
```

A Schedule is not a permanent bypass token.

---

# 91. Event Triggers — Future

Potential event examples:

```text
New important email
Calendar event created
Knowledge source updated
Task completed
Form submitted
Webhook received
```

Event trigger should map:

```text
event
→ condition
→ action
```

---

# 92. Condition Triggers — Future

Examples:

```text
Habit progress < target by Friday
Finance spending > threshold
Client has not replied in 5 days
Task overdue
Price below X
Weather condition
```

Condition evaluation may be:

- deterministic;
- AI-assisted;
- hybrid.

---

# 93. Condition Watch Frequency

Condition watches should run only as often as useful.

Avoid constant polling.

Use:

```text
provider events
webhooks
scheduled checks
```

depending on capability.

---

# 94. Manual Trigger — Future

A reusable Schedule/Automation may expose:

```text
Run
```

without time recurrence.

Example:

```text
"Prepare Client X Weekly Report"
```

One-click workflow.

---

# 95. Custom Actions — Future

Schedules may eventually invoke:

```text
Webhook
MCP Tool
Custom API
Make scenario
Power Automate flow
```

These are execution targets behind ELISE.

ELISE remains responsible for:

- authentication;
- permissions;
- logging;
- result state.

---

# 96. Make and External Automation Platforms

Make should not power the core ELISE product architecture.

It can be integrated in future as a custom action.

Example:

```text
Schedule
→ Custom Webhook Action
→ Make
```

But ELISE owns:

```text
Schedule
User
Permissions
Trigger
State
Result
```

---

# 97. Avoid Over-Automation

ELISE should not encourage creating a Schedule for every minor action.

Schedules are useful when:

- work repeats;
- timing matters;
- future execution matters;
- monitoring is valuable.

Simple one-off actions should remain direct.

---

# 98. MVP Scope

MVP Rules:

```text
Global rules
Capability rules
Context rules
Connection/provider routing rules
Planning rules
Morning Brief rules
Permission rules
Natural-language rule creation
Enable/disable/edit/delete
Basic conflict resolution
Audit for important changes
```

MVP Schedules:

```text
One-time
Recurring
Natural-language creation
Structured confirmation
Morning Brief
Weekly Review
Finance Review
Email Digest
Daily/Weekly Planning
Reminder
Run Now
Pause
Resume
Edit
Delete
History
Persistent results
In-app notification
Browser notification
Trigger.dev execution
Retries
Partial failure
Approval waits
```

---

# 99. Post-MVP Scope

```text
Event triggers
Condition triggers
Advanced manual workflows
Webhook triggers
Custom API actions
MCP actions
Make / Power Automate actions
WhatsApp delivery
Slack / Teams delivery
Mobile push
Advanced schedule templates
Team-owned automations
Conditional branching
Multi-step visual builder if ever justified
```

---

# 100. What ELISE Must Not Do

Avoid:

- storing only opaque prompts as schedules;
- ignoring changed Rules at execution time;
- auto-creating invasive notifications;
- executing ambiguous writes silently;
- binding unnecessarily to one provider forever;
- hiding failed runs;
- retrying destructive writes blindly;
- allowing expired approvals to execute without revalidation;
- making Trigger.dev part of product-facing concepts;
- becoming a full visual automation builder during MVP.

---

# 101. Architecture Summary

Rules:

```text
User Instruction
      ↓
Rule Parser
      ↓
Structured Scope + Instruction
      ↓
Rule Store
      ↓
Rule Resolver
      ↓
Runtime / Policy / Provider Resolution
```

Schedules:

```text
Natural Language / UI
      ↓
Structured Schedule
      ↓
User Confirmation
      ↓
Persist
      ↓
Trigger.dev
      ↓
Application Service / Skill
      ↓
Rules + Permissions
      ↓
Capabilities
      ↓
Result
      ↓
Notification
```

---

# 102. North Star

> **Rules make ELISE behave like your ELISE.**
>
> **Schedules make ELISE useful even when you are not actively talking to it.**
>
> Rules provide consistency.
>
> Schedules provide continuity.
>
> Both remain understandable, configurable and under the user's control.
