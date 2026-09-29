# ELISE — Use Case Catalog

**Document:** `03-use-case-catalog.md`  
**Status:** Draft v1  
**Purpose:** Catalogar los principales casos de uso de ELISE, incluyendo MVP y futuras expansiones, de forma suficientemente estructurada como para orientar producto, arquitectura, UX, permisos, providers y desarrollo.

---

# 1. Cómo leer este documento

Cada caso de uso se describe mediante:

- **ID**: identificador estable.
- **Area**: dominio funcional.
- **Use Case**: nombre corto.
- **User Intent / Trigger**: qué pide el usuario o qué evento lo inicia.
- **Inputs**: datos necesarios.
- **Capabilities**: capacidades internas de ELISE.
- **Providers**: providers posibles.
- **Knowledge / Context Needed**: contexto requerido.
- **AI Role**: qué parte resuelve IA.
- **Deterministic Logic**: qué parte debe resolverse con código.
- **Output**: resultado esperado.
- **Write Actions**: si modifica datos o ejecuta acciones.
- **Approval Level**: nivel de confirmación.
- **Background Execution**: si requiere ejecución en background.
- **Scope**: MVP / Post-MVP / Future.
- **Priority**:
  - `P0`: esencial;
  - `P1`: importante;
  - `P2`: posterior;
  - `P3`: experimental.
- **Notes**: consideraciones adicionales.

---

# 2. Principios generales del catálogo

## 2.1 Configuración por defecto + personalización

Siempre que una experiencia sea configurable, ELISE debe ofrecer:

- smart defaults;
- controles simples;
- checkboxes/toggles;
- opciones recomendadas;
- texto adicional opcional para instrucciones personalizadas.

Ejemplo para Morning Brief:

```text
Include:
[x] Calendar
[x] Important Email
[x] Tasks
[x] Habits
[x] Relevant News
[ ] Finance
[ ] Goals

Additional instructions:
"Only show AI news if it materially affects automation or my business."
```

La configuración nunca debe depender exclusivamente de prompts libres.

---

## 2.2 Contextual relevance

La relevancia no debe ser global y rígida.

Puede depender de:

- usuario;
- momento;
- calendario;
- proyectos activos;
- ubicación;
- objetivos;
- reglas;
- relaciones;
- comportamiento previo.

Una noticia relevante para un usuario puede ser irrelevante para otro.

Una misma noticia también puede cambiar de relevancia según el contexto del día.

---

## 2.3 Configurable autonomy

Muchos casos de uso pueden operar en distintos niveles:

```text
Suggest
Prepare
Ask for approval
Execute automatically
```

El nivel debe depender de:

- permisos;
- riesgo;
- confianza;
- reglas;
- contexto.

---

# 3. Morning Brief & Daily Awareness

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BRIEF-001 | Brief | Morning Brief | Scheduled every morning | Calendar, email, tasks, habits, news, optional finance/goals | Calendar, Email, Tasks, Habits, News, Knowledge | Google + ELISE Native | User preferences, priorities, active projects | Prioritize and synthesize | Fetch sources, filtering, schedule | Personalized daily brief | No | None | Yes | MVP | P0 | Main MVP wow moment |
| BRIEF-002 | Brief | Configurable Brief Blocks | User edits preferences | Enabled modules + custom instructions | Rules, Preferences | Native | User configuration | Interpret free-text additions | Persist settings | Updated brief behavior | Yes | None | No | MVP | P0 | Checkboxes + optional free text |
| BRIEF-003 | Brief | Important Email Block | Morning Brief | Recent emails | Email | Gmail | Priority rules, senders, projects | Rank relevance | Query + dedupe | Important messages summary | No | None | Yes | MVP | P0 | Only useful email |
| BRIEF-004 | Brief | Calendar Block | Morning Brief | Daily/weekly events | Calendar | Google Calendar | Multiple accounts/calendars | Explain schedule pressure | Merge calendars | Agenda summary | No | None | Yes | MVP | P0 | Must understand overlaps |
| BRIEF-005 | Brief | Tasks Block | Morning Brief | Open/overdue tasks | Tasks | ELISE Tasks, Google Tasks | Priorities, due dates | Rank tasks | Query/filter | Today's priorities | No | None | Yes | MVP | P0 | |
| BRIEF-006 | Brief | Habit Block | Morning Brief | Habit progress | Habits | ELISE Habits, Notion | Weekly targets | Identify gaps | Aggregate check-ins | Habit progress | No | None | Yes | MVP | P1 | Configurable |
| BRIEF-007 | Brief | News Block | Morning Brief | Web/news | News/Search | Web provider | Interests, business context | Select relevance | Fresh search + source filtering | Relevant news | No | None | Yes | MVP | P0 | Avoid generic noise |
| BRIEF-008 | Brief | Finance Snapshot | Morning Brief | Transactions/budgets | Finance | ELISE Finance, Sheets | User preferences | Surface anomalies | Aggregate | Optional finance snapshot | No | None | Yes | MVP | P1 | Opt-in |
| BRIEF-009 | Brief | Goals Snapshot | Morning Brief | Goals + linked habits/tasks | Goals | ELISE Native | Active goals | Relate daily work to goals | Progress calculation | Goal context | No | None | Yes | MVP | P1 | Opt-in |
| BRIEF-010 | Brief | Meeting Prep Alerts | Morning Brief | Upcoming meetings | Calendar, Knowledge, Email | Google, Notion, Drive | People/project entities | Detect meetings needing prep | Time-window logic | Prep suggestions | No | None | Yes | MVP | P1 | |

---

# 4. Daily Planning

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PLAN-001 | Planning | Plan My Day | "Organizame el día" | Calendar, tasks, priorities, habits | Calendar, Tasks, Goals | Google + Native | User planning method | Build realistic schedule | Conflict detection | Proposed plan | Optional | Confirm before writes | No | MVP | P0 | Core personal use case |
| PLAN-002 | Planning | Plan Tomorrow | Evening/manual trigger | Tomorrow calendar + tasks | Calendar, Tasks | Google + Native | User preferred planning style | Build next-day plan | Availability calculation | Proposed blocks | Optional | Confirm | No | MVP | P0 | Matches founder workflow |
| PLAN-003 | Planning | Write Plan to Calendar | User accepts plan | Proposed time blocks | Calendar | Google Calendar | Calendar selection rules | Minimal | Create events | Calendar blocks | Yes | Confirm | No | MVP | P0 | Must support multiple calendars |
| PLAN-004 | Planning | Replan After Disruption | "Se me atrasó todo" | Current time, remaining events/tasks | Calendar, Tasks | Google + Native | Original plan | Re-prioritize | Time calculations | Revised plan | Optional | Confirm changes | No | MVP | P1 | |
| PLAN-005 | Planning | Weekly Planning | Scheduled/manual | Calendar, goals, tasks, habits | Calendar, Tasks, Goals, Habits | Mixed | Weekly priorities | Suggest week structure | Aggregations | Weekly plan | Optional | Confirm writes | Yes/No | MVP | P1 | Configurable |
| PLAN-006 | Planning | Reserve Focus Blocks | User asks | Tasks/goals + availability | Calendar | Google | Work hours/preferences | Suggest placement | Find availability | Proposed focus sessions | Yes | Confirm | No | MVP | P1 | |

---

# 5. Email

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EMAIL-001 | Email | Inbox Summary | "¿Qué tengo importante?" | Inbox | Email | Gmail | Importance rules | Rank/summarize | Fetch | Summary | No | None | No | MVP | P0 | |
| EMAIL-002 | Email | Search Email | Natural-language request | Search criteria | Email | Gmail | Entity context | Translate intent | Search API | Results | No | None | No | MVP | P0 | |
| EMAIL-003 | Email | Read Thread | User selects thread | Thread ID | Email | Gmail | Conversation context | Summarize | Fetch thread | Thread summary | No | None | No | MVP | P0 | |
| EMAIL-004 | Email | Detect Needs Reply | Inbox scan | Recent messages | Email | Gmail | User rules | Classify | Dedup/state tracking | Reply-needed list | No | None | Yes | MVP | P0 | Avoid unnecessary drafts |
| EMAIL-005 | Email | Create Draft | User asks or rule matches | Thread + context | Email | Gmail | Tone, project/client context | Draft reply | Create draft | Gmail draft | Yes | Configurable | No/Yes | MVP | P0 | |
| EMAIL-006 | Email | Send Email | User approves | Draft/message | Email | Gmail | Sending account | Final check | Send API | Sent email | Yes | Confirm/default rules | No | MVP | P0 | |
| EMAIL-007 | Email | Delete/Discard Draft | User asks | Draft ID | Email | Gmail | None | None | Delete draft | Draft removed | Yes | Low | No | MVP | P1 | |
| EMAIL-008 | Email | Clean Noise | User asks / configured process | Inbox | Email | Gmail | Spam/noise rules | Classify | Archive/delete/label | Cleaner inbox | Yes | Configurable | Yes | MVP | P1 | Safer default = archive |
| EMAIL-009 | Email | Waiting on Me | "¿Qué mails esperan respuesta?" | Threads | Email | Gmail | Sent/received state | Classify pending responsibility | Thread-state logic | Pending replies | No | None | No | MVP | P1 | |
| EMAIL-010 | Email | Waiting on Others | "¿A quién tengo que hacer follow-up?" | Threads | Email | Gmail | User sent mail history | Identify stalled threads | Time threshold | Follow-up suggestions | Optional | Confirm | Yes/No | MVP | P1 | |
| EMAIL-011 | Email | Email → Client Context | Incoming email | Message | Email, Entities | Gmail | Client/project graph | Associate context | Entity matching | Linked context | Optional metadata | None | Yes | MVP | P1 | |
| EMAIL-012 | Email | Multi-account Resolve | User says "respondé esto" | Context | Email | Gmail | Account bindings | Pick likely account | Confidence threshold | Selected account / question | Maybe | Ask if ambiguous | No | MVP | P0 | |

---

# 6. Calendar & Meetings

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CAL-001 | Calendar | Today's Agenda | "¿Qué tengo hoy?" | Calendars | Calendar | Google Calendar | Multi-account/calendar | Summarize | Merge/sort | Agenda | No | None | No | MVP | P0 | |
| CAL-002 | Calendar | Availability | "¿Cuándo puedo reunirme?" | Calendars | Calendar | Google Calendar | Work hours, buffers | Explain options | Free/busy calculation | Available slots | No | None | No | MVP | P0 | |
| CAL-003 | Calendar | Create Event | User asks | Time, title, participants | Calendar | Google Calendar | Default calendar rules | Interpret natural time | Validate/create | Event | Yes | Configurable | No | MVP | P0 | |
| CAL-004 | Calendar | Edit Event | User asks | Existing event | Calendar | Google Calendar | Correct calendar | Interpret changes | Update API | Updated event | Yes | Configurable | No | MVP | P0 | |
| CAL-005 | Calendar | Delete Event | User asks | Event | Calendar | Google Calendar | Identity confidence | Minimal | Delete API | Removed event | Yes | Confirm | No | MVP | P1 | |
| CAL-006 | Meetings | Meeting Prep | "Preparame para X" / pre-meeting | Calendar, email, knowledge, tasks | Calendar, Email, Knowledge | Google, Gmail, Notion/Drive | People/client/project entities | Synthesize briefing | Gather data | Meeting brief | No | None | Optional | MVP | P0 | |
| CAL-007 | Meetings | Recent Decisions | Meeting prep | Knowledge + emails + notes | Knowledge, Email | Mixed | Project context | Extract decisions | Retrieval | Decision summary | No | None | No | MVP | P1 | |
| CAL-008 | Meetings | What Did We Promise? | User asks | Notes/emails/docs | Knowledge, Email | Mixed | Client/project context | Identify commitments | Retrieval | Commitments list | No | None | No | MVP | P1 | |

---

# 7. Tasks, Lists & Goals

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TASK-001 | Tasks | Create Task | "Agregá X" | Title/details | Tasks | ELISE / Google Tasks | Project context | Extract fields | Persist/create | Task | Yes | Low | No | MVP | P0 | |
| TASK-002 | Tasks | Complete Task | "Ya hice X" | Task match | Tasks | Native/Google | Recent tasks | Match task | Update | Completed task | Yes | Low | No | MVP | P0 | |
| TASK-003 | Tasks | Prioritize Tasks | "¿Qué hago primero?" | Open tasks + calendar | Tasks, Calendar | Mixed | Goals, deadlines | Rank | Query | Priority list | No | None | No | MVP | P0 | |
| TASK-004 | Tasks | Reschedule Task | User asks | Task + availability | Tasks, Calendar | Mixed | Planning preferences | Suggest slot | Date update | Rescheduled task | Yes | Configurable | No | MVP | P1 | |
| LIST-001 | Lists | Shopping List | Add/remove/check items | List items | Lists | ELISE Native | Active list | Minimal | CRUD | Updated list | Yes | Low | No | MVP | P1 | |
| LIST-002 | Lists | Custom List | User creates any list | Items | Lists | ELISE Native | None | Minimal | CRUD | List | Yes | Low | No | MVP | P1 | |
| GOAL-001 | Goals | Create Goal | User defines goal | Goal details | Goals | ELISE Native | User context | Structure goal | Persist | Goal | Yes | Low | No | MVP | P1 | |
| GOAL-002 | Goals | Goal Progress Review | Manual/scheduled | Goals + tasks/habits | Goals, Tasks, Habits | Native | Goal relations | Analyze progress | Aggregate | Progress review | No | None | Yes/No | MVP | P1 | |
| GOAL-003 | Goals | Suggest Actions | Progress is behind | Goals + calendar | Goals, Tasks, Calendar | Mixed | User preferences | Recommend intervention | Availability | Suggestions | Optional | Confirm writes | No | MVP | P1 | |

---

# 8. Habits & Personal Progress

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HABIT-001 | Habits | Habit Check-in | "Hoy entrené" | Habit match | Habits | ELISE / Notion | Habit definitions | Match intent | Persist check-in | Updated habit | Yes | Low | No | MVP | P0 | |
| HABIT-002 | Habits | Weekly Progress | "¿Cómo vengo?" | Habit history | Habits | Native/Notion | Weekly targets | Explain progress | Aggregate | Progress summary | No | None | No | MVP | P0 | |
| HABIT-003 | Habits | Suggest Recovery Plan | Behind target | Habits + calendar | Habits, Calendar | Mixed | User schedule | Recommend realistic plan | Availability | Suggested blocks/actions | Optional | Confirm | No | MVP | P1 | |
| HABIT-004 | Habits | Habit Reminder | Scheduled | Habit + target | Habits | Native | Reminder preferences | Decide relevance | Schedule | Notification | No | None | Yes | Post-MVP | P1 | Should avoid noise |
| HABIT-005 | Habits | Adaptive Notification | Based on behavior/context | Habit history + day context | Habits, Calendar | Mixed | User patterns | Decide whether/when to notify | Rule thresholds | Contextual reminder | No | None | Yes | Future | P2 | |

---

# 9. Finance

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FIN-001 | Finance | Record Expense | "Gasté 25 USD en OpenAI" | Amount, currency, category | Finance | ELISE Finance | Category history | Extract/classify | Persist transaction | New expense | Yes | Low/configurable | No | MVP | P0 | |
| FIN-002 | Finance | Record Income | User states income | Amount/source | Finance | ELISE Finance | Client/project | Classify | Persist | Income record | Yes | Low | No | MVP | P1 | |
| FIN-003 | Finance | Monthly Spend | "¿Cuánto gasté este mes?" | Transactions | Finance | Native/Sheets | Currency rules | Explain | SQL/aggregation | Summary | No | None | No | MVP | P0 | |
| FIN-004 | Finance | Category Analysis | "¿Cuánto gasté en herramientas?" | Transactions | Finance | Native/Sheets | Categories | Interpret | Filter/sum | Breakdown | No | None | No | MVP | P0 | |
| FIN-005 | Finance | Project Profitability | User asks | Income + costs | Finance | Native/Sheets | Project mapping | Explain | Aggregate | Profit view | No | None | No | MVP | P1 | |
| FIN-006 | Finance | Edit Transaction | User corrects record | Transaction | Finance | Native | Identity | Interpret correction | Update | Corrected record | Yes | Low | No | MVP | P1 | |
| FIN-007 | Finance | Import Spreadsheet | User uploads/connects Sheet | Tabular data | Finance, Import | Sheets / Upload | Mapping | Infer columns | Validate/import | Imported ledger | Yes | Confirm mapping | Background | MVP | P1 | |
| FIN-008 | Finance | Finance Alert | Threshold/anomaly | Transactions | Finance | Native | Rules | Identify anomaly | Threshold check | Alert | No | None | Yes | Post-MVP | P2 | |

---

# 10. Knowledge & Documents

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| KNOW-001 | Knowledge | Upload Document | User uploads file | Supported file | Knowledge | ELISE Uploads | Target space | Extract metadata | Store/validate | Indexed doc | Yes | None | Yes | MVP | P0 | Size/type limits |
| KNOW-002 | Knowledge | Ask Across Documents | Natural-language query | Query | Knowledge | Uploads/Notion/Drive | Space/entity context | Semantic retrieval + synthesis | Filters/index | Answer + sources | No | None | No | MVP | P0 | |
| KNOW-003 | Knowledge | Multiple Knowledge Spaces | User organizes sources | Spaces + sources | Knowledge | Mixed | Workspace hierarchy | Help classify | CRUD | Logical spaces | Yes | Low | No | MVP | P0 | |
| KNOW-004 | Knowledge | Add New Source | User connects source | Provider content | Knowledge | Notion/Drive | Space assignment | Suggest destination | Sync/index | Source added | Yes | Confirm | Yes | MVP | P0 | |
| KNOW-005 | Knowledge | Save Note From Chat | "Guardá esto en..." | Conversation content | Notes, Knowledge | ELISE Native | Target entity/space | Summarize/title | Persist/index | Knowledge note | Yes | Low | No | MVP | P0 | |
| KNOW-006 | Knowledge | Find Original | "Abrime el documento" | Retrieval hit | Knowledge | Mixed | Source metadata | Match | Resolve URL | Original source | No | None | No | MVP | P1 | |
| KNOW-007 | Knowledge | Summarize Space | "Resumime este proyecto" | Space | Knowledge | Mixed | Scope | Synthesize | Retrieve batches | Space summary | No | None | Maybe | MVP | P1 | |
| KNOW-008 | Knowledge | Recent Changes | "¿Qué cambió esta semana?" | Changed items | Knowledge | Notion/Drive | Time window | Summarize changes | Sync metadata | Change digest | No | None | Yes/No | MVP | P1 | |
| KNOW-009 | Knowledge | Compare Document Versions | User asks | Two versions | Knowledge | Uploads/Drive/Notion | Version history | Diff meaning | Fetch/diff | Change summary | No | None | No | Post-MVP | P1 | |
| KNOW-010 | Knowledge | Move/Assign Note | User asks | Note + destination | Knowledge | Native | Space hierarchy | Resolve destination | Update relation | Moved note | Yes | Low | No | MVP | P1 | |
| KNOW-011 | Knowledge | Source Citation | Every knowledge answer | Retrieval evidence | Knowledge | Any | Provenance | Select useful citations | Preserve source refs | Sources | No | None | No | MVP | P0 | |

---

# 11. Study & Learning

ELISE Study should take inspiration from modern AI study interfaces that offer multiple ways to work with the same material. The exact UI does not need to clone any existing product.

Possible study experiences include:

- conversational tutor;
- quizzes;
- flashcards;
- summaries;
- study plans;
- oral exam mode;
- mind maps;
- structured reports;
- audio review;
- topic weakness tracking.

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| STUDY-001 | Study | Explain Topic | User asks | Study knowledge | Knowledge, Study | Any knowledge source | Subject/space | Tutor explanation | Retrieval | Explanation | No | None | No | MVP | P0 | |
| STUDY-002 | Study | Pre-Class Review | Before class/manual | Class materials | Study, Calendar | Knowledge + Calendar | Upcoming class | Select relevant topics | Time detection | Short review | No | None | Yes/No | MVP | P0 | |
| STUDY-003 | Study | Quiz Me | User asks | Knowledge | Study | Any | Subject | Generate/adapt questions | Track answers | Interactive quiz | Maybe progress | None | No | MVP | P0 | |
| STUDY-004 | Study | Oral Exam Simulation | User asks | Knowledge | Study, Voice | Any | Exam scope | Ask/follow-up/evaluate | Session tracking | Oral practice | Progress | None | No | MVP | P1 | |
| STUDY-005 | Study | Flashcards | User asks | Knowledge | Study | Any | Topic | Generate cards | Persist optionally | Flashcards | Optional | None | No | MVP | P1 | |
| STUDY-006 | Study | Weak Topic Detection | During practice | Answers/history | Study | Native | Progress history | Diagnose weaknesses | Score tracking | Weak-topic list | Yes | None | No | MVP | P1 | |
| STUDY-007 | Study | Study Plan | "Tengo examen el viernes" | Exam date, topics, calendar | Study, Calendar, Tasks | Mixed | Availability | Plan sessions | Scheduling math | Plan | Optional | Confirm writes | No | MVP | P1 | |
| STUDY-008 | Study | Mind Map | User asks | Knowledge | Study | Any | Topic | Structure relationships | Render structure | Mind map data | No | None | No | Post-MVP | P2 | |
| STUDY-009 | Study | Audio Summary | User asks | Knowledge | Study, Voice | Any | Topic | Summarize for audio | TTS | Audio review | No | None | Background | Post-MVP | P2 | |
| STUDY-010 | Study | Progress by Subject | User asks | Sessions/results | Study | Native | Subject entities | Explain progress | Aggregate | Progress dashboard | No | None | No | MVP | P1 | |

---

# 12. Client & Work Intelligence

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WORK-001 | Work | Client Brief | "Poneme al día con Cliente X" | Knowledge, email, tasks | Knowledge, Email, Tasks | Mixed | Client entity | Synthesize state | Retrieve | Client brief | No | None | No | MVP | P0 | |
| WORK-002 | Work | Project Status | "¿Cómo está Proyecto X?" | Project docs/tasks | Knowledge, Tasks | Mixed | Project entity | Summarize | Retrieve/query | Status | No | None | No | MVP | P0 | |
| WORK-003 | Work | Open Blockers | User asks | Tasks/docs/emails | Knowledge, Tasks, Email | Mixed | Project context | Identify blockers | Query | Blocker list | No | None | No | MVP | P1 | |
| WORK-004 | Work | Recent Decisions | User asks | Notes/docs/emails | Knowledge | Mixed | Time/project | Extract decisions | Retrieval | Decision log | No | None | No | MVP | P1 | |
| WORK-005 | Work | What Did We Promise? | User asks | Email/docs/notes | Knowledge, Email | Mixed | Client/project | Identify commitments | Retrieval | Commitments | No | None | No | MVP | P1 | |
| WORK-006 | Work | Prepare Client Reply | User asks | Email + client context | Email, Knowledge | Gmail + knowledge | Relationship/tone | Draft response | Create draft | Draft | Yes | Confirm/send rules | No | MVP | P0 | |
| WORK-007 | Work | Save New Decision | "Guardá que acordamos..." | Chat input | Knowledge, Entities | Native | Client/project | Structure | Persist | Decision note | Yes | Low | No | MVP | P0 | |
| WORK-008 | Work | Meeting Follow-up | After meeting | Notes/tasks/email | Knowledge, Tasks, Email | Mixed | Meeting context | Extract actions | Persist/create | Actions/draft | Yes | Confirm writes | No | Post-MVP | P1 | |

---

# 13. Scheduled Tasks

The final product name for this capability is not yet decided. Avoid using “Routines” as the final user-facing name until naming is resolved.

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SCHED-001 | Automation | Schedule Morning Brief | Natural language | Schedule + brief config | Scheduled Tasks | ELISE Runtime | User timezone | Parse request | Create schedule | Active task | Yes | Confirm creation | Yes | MVP | P0 | |
| SCHED-002 | Automation | Reminder | "Recordame X mañana" | Time + text | Scheduled Tasks | ELISE Runtime | Timezone | Parse time | Schedule | Notification | Yes | Low | Yes | MVP | P0 | |
| SCHED-003 | Automation | Weekly Review | User configures | Data sources | Scheduled Tasks | ELISE Runtime | Preferences | Synthesize | Schedule/fetch | Review | No | None | Yes | MVP | P1 | |
| SCHED-004 | Automation | Finance Review | User configures | Finance data | Scheduled Tasks | ELISE Runtime | Rules | Analyze | Aggregate | Report | No | None | Yes | MVP | P1 | |
| SCHED-005 | Automation | Pre-Class Review | Before event | Calendar + study knowledge | Scheduled Tasks | ELISE Runtime | Class mapping | Build review | Event timing | Review prompt | No | None | Yes | MVP | P1 | |
| SCHED-006 | Automation | Pre-Meeting Brief | Before meeting | Calendar + work context | Scheduled Tasks | ELISE Runtime | Entity mapping | Prepare brief | Time trigger | Brief | No | None | Yes | MVP | P1 | |
| SCHED-007 | Automation | Email Digest | User schedules | Emails | Scheduled Tasks | ELISE Runtime | Email rules | Summarize | Fetch | Digest | No | None | Yes | MVP | P1 | |
| SCHED-008 | Automation | Pause Scheduled Task | User action | Task ID | Scheduled Tasks | Runtime | Ownership | None | Disable | Paused | Yes | Low | No | MVP | P0 | |
| SCHED-009 | Automation | Edit Schedule | User action | Task ID + new timing | Scheduled Tasks | Runtime | Ownership | Parse | Update | Updated schedule | Yes | Low | No | MVP | P0 | |
| SCHED-010 | Automation | Run Now | User action | Task ID | Scheduled Tasks | Runtime | Config | None | Trigger execution | Run result | Maybe | Depends on task | Yes | MVP | P1 | |
| SCHED-011 | Automation | Event Trigger | Incoming event | Event | Events | Future | Rules | Decide action | Event matching | Action | Maybe | Configurable | Yes | Post-MVP | P1 | |
| SCHED-012 | Automation | Condition Trigger | State threshold | Data state | Conditions | Future | Rule config | Interpret state | Evaluate | Action/alert | Maybe | Configurable | Yes | Post-MVP | P1 | |

---

# 14. News & Web

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| NEWS-001 | News | Relevant News Brief | Morning Brief | Topics + web | News | Web Search | Interests/projects | Rank relevance | Fresh search | News summary | No | None | Yes | MVP | P0 | |
| NEWS-002 | News | Current Event Search | User asks | Query | Web Search | Web | User context | Search + synthesize | Fetch | Answer | No | None | No | MVP | P0 | |
| NEWS-003 | News | User-defined Relevance | Settings | Topics/rules | Preferences | Native | User interests | Interpret instructions | Persist | Relevance profile | Yes | None | No | MVP | P0 | |
| NEWS-004 | News | Context-aware Relevance | Automatic | Current projects/calendar | News, Entities | Web | User state | Infer what matters today | Ranking | Contextual news | No | None | Yes | MVP | P1 | |
| NEWS-005 | News | Topic Monitoring | User requests ongoing watch | Topic | News, Scheduled/Event | Web | Preferences | Determine meaningful changes | Schedule/search | Alert | No | None | Yes | Post-MVP | P1 | |

---

# 15. Voice & Mobile

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| VOICE-001 | Voice | Voice Chat | User speaks | Audio | Voice, Chat | MVP voice provider | Conversation | Understand/respond | Audio pipeline | Spoken answer | Maybe via tools | Same as tool | No | MVP | P0 | |
| VOICE-002 | Voice | Add Task by Voice | User speaks | Audio | Voice, Tasks | Mixed | Current context | Extract task | Create task | Confirmation/ack | Yes | Low | No | MVP | P0 | |
| VOICE-003 | Voice | Quick Urgent Brief | "Leeme solo lo urgente" | Brief data | Voice, Brief | Mixed | Priorities | Compress | Gather | Short spoken brief | No | None | No | MVP | P1 | |
| VOICE-004 | Voice | Driving Mode Brief | User asks from mobile | Context | Voice, Brief | Web mobile | Location/calendar optional | Prioritize for audio | Gather | 5-min audio brief | No | None | No | Post-MVP | P1 | |
| VOICE-005 | Voice | Custom Voice | User configures | Voice profile | Voice | ElevenLabs | User preference | None | Provider setup | Personalized voice | Yes config | None | No | Post-MVP | P2 | |

---

# 16. Location-Aware Experiences

Location is not required to close the initial MVP, but the architecture and product model should not prevent future location-aware capabilities.

Location access must always be permission-based and optional.

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LOC-001 | Location | Nearby Restaurants | "¿Qué hay para comer por acá?" | Current location | Location, Web/Places | Maps/Places | Preferences | Rank choices | Nearby search | Recommendations | No | Location permission | No | Future | P2 | |
| LOC-002 | Location | Parking Recommendation | "¿Dónde estaciono por acá?" | Current location | Location, Web/Maps | Maps/search | Destination/context | Compare options | Nearby search | Parking suggestions | No | Location permission | No | Future | P2 | |
| LOC-003 | Location | Contextual Commute | Upcoming event | Location + calendar | Location, Calendar | Maps + Calendar | Event location | Advise departure | ETA calculation | Leave-time suggestion | No | Permission | Yes/No | Future | P2 | |
| LOC-004 | Location | Nearby Utility Search | User asks | Location | Location, Web | Places | Query | Rank | Search | Nearby options | No | Permission | No | Future | P2 | |

---

# 17. Connections & Configuration

| ID | Area | Use Case | User Intent / Trigger | Inputs | Capabilities | Providers | Context Needed | AI Role | Deterministic Logic | Output | Write Actions | Approval | Background | Scope | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CONN-001 | Connections | Connect Provider | User onboarding/settings | OAuth | Connections | Google/Notion | Requested capabilities | Explain permissions | OAuth | Active connection | Yes | OAuth consent | No | MVP | P0 | |
| CONN-002 | Connections | Multiple Accounts | User adds second account | OAuth | Connections | Same provider | Scope labels | Suggest names/context | Store binding | Additional account | Yes | Consent | No | MVP | P0 | |
| CONN-003 | Connections | Set Default | User configures | Connections | Capability bindings | Any | Context | Suggest | Persist | Default binding | Yes | Low | No | MVP | P0 | |
| CONN-004 | Connections | Reconnect Expired | Token expires | Connection | Connections | Any | Ownership | Explain issue | OAuth refresh | Restored connection | Yes | Consent if needed | No | MVP | P0 | |
| CONN-005 | Connections | Disconnect | User action | Connection | Connections | Any | Ownership | Explain effect | Revoke/remove | Disconnected | Yes | Confirm | No | MVP | P0 | |

---

# 18. Guardrails & Failure Cases

These are first-class product behaviors, not edge cases.

| ID | Area | Use Case | Trigger | Expected Behavior | Scope | Priority |
|---|---|---|---|---|---|---|
| SAFE-001 | Safety | Ambiguous Account | More than one plausible account | Ask user instead of guessing if action has consequence | MVP | P0 |
| SAFE-002 | Safety | Ambiguous Entity | Multiple people/projects match | Ask a concise clarification | MVP | P0 |
| SAFE-003 | Safety | Missing Permission | Tool requires unavailable permission | Explain what is missing and offer reconnect/configure path | MVP | P0 |
| SAFE-004 | Safety | Missing Connection | Capability unavailable | Explain which connection is needed | MVP | P0 |
| SAFE-005 | Safety | Destructive Action | Delete/archive/send sensitive action | Require appropriate confirmation | MVP | P0 |
| SAFE-006 | Safety | Low-confidence Knowledge | Retrieval evidence weak | Say uncertainty and avoid invented answer | MVP | P0 |
| SAFE-007 | Safety | External Source Stale | Sync is outdated | Surface freshness status | MVP | P1 |
| SAFE-008 | Safety | Background Job Failed | Scheduled task fails | Log failure, retry where safe, surface actionable error | MVP | P0 |
| SAFE-009 | Safety | Duplicate Action Risk | Same write may run twice | Use idempotency/deduplication | MVP | P0 |
| SAFE-010 | Safety | User Revokes Access | Connection removed | Stop related background work and fail safely | MVP | P0 |

---

# 19. Post-MVP Communication & Business Integrations

| ID | Area | Use Case | Providers | Scope | Priority | Notes |
|---|---|---|---|---|---|---|
| FUT-001 | Messaging | Read WhatsApp Business messages | WhatsApp Business Platform | Post-MVP | P1 | Coexistence/provider constraints |
| FUT-002 | Messaging | Reply to WhatsApp Business | WhatsApp Business Platform | Post-MVP | P1 | Approval/rules |
| FUT-003 | Messaging | Slack summaries/actions | Slack | Post-MVP | P1 | |
| FUT-004 | Messaging | Teams summaries/actions | Microsoft Teams | Future | P2 | |
| FUT-005 | CRM | Monday project/client data | Monday | Post-MVP | P1 | |
| FUT-006 | CRM | HubSpot | HubSpot | Future | P2 | |
| FUT-007 | CRM | Salesforce | Salesforce | Future | P3 | |
| FUT-008 | Content | Content calendar | Notion / ELISE Native | Post-MVP | P1 | |
| FUT-009 | Content | Publishing | Metricool / social APIs | Future | P2 | |
| FUT-010 | Content | Analytics reports | Metricool / Meta / YouTube / TikTok | Future | P2 | |
| FUT-011 | Microsoft | Outlook Email | Microsoft Graph | Post-MVP | P1 | Alternative Email provider |
| FUT-012 | Microsoft | Outlook Calendar | Microsoft Graph | Post-MVP | P1 | Alternative Calendar provider |
| FUT-013 | Microsoft | OneDrive/SharePoint Knowledge | Microsoft | Future | P2 | |

---

# 20. Candidate User-Facing Configuration Patterns

Many cases above require customization. The preferred UX pattern is:

```text
Recommended defaults
+
Simple controls
+
Optional advanced instructions
```

Example:

## Morning Brief

```text
What should ELISE include?

[x] Today's calendar
[x] Important email
[x] Tasks due today
[x] Habit progress
[x] Relevant news
[ ] Finance snapshot
[ ] Goals

News interests:
AI, Automation, Business, Argentina

Additional instructions:
"Only include a news item if it may affect my work or decisions."
```

Example:

## Email

```text
Important email:
[x] Clients
[x] Team
[x] Direct questions
[ ] Newsletters

Create drafts:
[x] When a direct reply is clearly required
[ ] For every client email

Additional instructions:
"Do not draft replies to FYI messages."
```

This configuration style should remain consistent across ELISE.

---

# 21. Product Direction Implied by the Catalog

The catalog makes several important product directions explicit.

## 21.1 ELISE is broader than chat

Chat is the interaction layer.

The product value also comes from:

- scheduled execution;
- background context gathering;
- native structured data;
- provider connections;
- persistent knowledge;
- user rules;
- configurable proactive behavior.

## 21.2 Personalization is a core capability

Morning Brief, Email, News, Planning, Habits and other areas depend on user-specific relevance.

Configuration must therefore be treated as product functionality, not as an afterthought.

## 21.3 Multiple providers and multiple accounts are fundamental

The system must never assume:

```text
one capability = one account
```

A user may have:

- several Gmail accounts;
- several calendars;
- several Notion workspaces;
- several Drive accounts;
- native + external implementations of the same capability.

## 21.4 Context connects capabilities

The highest-value use cases often combine multiple domains.

Example:

```text
Meeting Prep
=
Calendar
+ Email
+ Client Knowledge
+ Tasks
+ Recent Decisions
```

This is one of ELISE's main differentiators.

---

# 22. Current Priority Summary

## P0 — Essential MVP experiences

- Universal Chat
- Morning Brief
- Gmail reading/search/importance/drafts
- Google Calendar
- ELISE Tasks + Google Tasks
- ELISE Habits
- Knowledge Uploads
- Knowledge Spaces
- Notion Knowledge
- Google Drive Knowledge
- News/Web Search
- Daily Planning
- Meeting Prep
- Client/Work Knowledge
- Study basics
- Scheduled tasks
- Multi-account support
- Core guardrails

## P1 — Important MVP depth

- Weekly planning
- follow-up detection;
- goals;
- finance;
- lists;
- structured Notion;
- richer Study experiences;
- progress tracking;
- finance imports;
- configurable proactive suggestions;
- execution history.

## P2/P3 — Later expansion

- location-aware assistance;
- WhatsApp;
- Slack/Teams;
- advanced content workflows;
- Microsoft ecosystem;
- custom voice;
- CRM expansion;
- advanced event/condition automation;
- broader marketplace.

---

# 23. Definition of Catalog Completeness

This document is intentionally a **broad v1 catalog**, not a permanent exhaustive list.

A new use case can be added whenever:

- a real user need appears;
- a provider enables a new capability;
- an existing capability becomes more mature;
- a new ELISE Native module is introduced.

New cases should preserve the same metadata structure and receive:

- unique ID;
- scope;
- priority;
- permission model;
- expected output;
- capability mapping.

---

# 24. Guiding Principle

> **A use case should describe what the user wants to achieve, not which application happens to implement it.**

ELISE should organize experiences around intent.

Providers, tools and models are implementation details behind that intent.
