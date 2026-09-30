# ELISE — User Experience

**Document:** `04-user-experience.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo se siente utilizar ELISE de punta a punta: onboarding, navegación, chat, configuración, conexiones, knowledge, módulos nativos, schedules, aprobaciones, notificaciones, voz, mobile y principios generales de interacción.

---

# 1. UX Vision

ELISE debe sentirse como una sola inteligencia disponible en todo momento.

La experiencia no debe girar alrededor de navegar entre muchas herramientas o módulos. El usuario debe poder entrar, hablar o escribir, y dejar que ELISE determine:

- qué información necesita;
- qué capability utilizar;
- qué provider consultar;
- qué contexto recuperar;
- qué acción ejecutar;
- qué permiso solicitar.

La interfaz debe ser:

- moderna;
- visualmente distintiva;
- simple;
- fluida;
- tecnológica;
- no intimidante;
- configurable sin resultar compleja.

La inspiración visual puede tomar elementos de interfaces tipo JARVIS, pero sin sacrificar claridad ni convertir la aplicación en una demo estética sin utilidad.

---

# 2. Chat as the Center

El chat es el centro de la experiencia.

La pantalla principal debe priorizar la interacción directa con ELISE.

El usuario debería poder:

- escribir;
- hablar;
- consultar información;
- ejecutar acciones;
- revisar contexto;
- continuar conversaciones anteriores;
- recibir resultados de tareas programadas.

El producto no debe girar alrededor de dashboards llenos de módulos.

La lógica principal es:

```text
User
  ↓
ELISE
  ↓
Everything else
```

---

# 3. Conversation History

ELISE debe guardar historial de conversaciones.

Sin embargo, el historial no debe ser tan protagonista como en productos centrados exclusivamente en chat.

La experiencia debe transmitir que existe una sola inteligencia continua.

El historial sirve como:

- referencia;
- auditoría;
- continuidad;
- búsqueda;
- consulta de conversaciones anteriores.

La navegación puede permitir acceder a conversaciones previas mediante una sidebar o panel secundario, pero el usuario no debe sentir que está creando “muchas ELISE diferentes”.

---

# 4. Home Experience

La Home debe mantener el chat como elemento principal.

No debe abrir automáticamente un Morning Brief invasivo.

Una estructura conceptual posible:

```text
┌─────────────────────────────────────┐
│ ELISE                               │
│                                     │
│          Animated ELISE Orb         │
│                                     │
│       Ask ELISE anything...         │
│                                     │
│  Morning Brief ready               │
│  [View] [Listen]                    │
│                                     │
│  2 scheduled results ready         │
│                                     │
└─────────────────────────────────────┘
```

Los resultados generados en background deben estar disponibles sin interrumpir innecesariamente al usuario.

---

# 5. Non-Invasive Proactivity

ELISE debe ser proactiva sin apropiarse de la pantalla.

Cuando una Scheduled Task termine, su resultado debe quedar disponible como:

- badge;
- notification;
- inbox item;
- small status card;
- browser notification cuando corresponda.

Ejemplo:

```text
Morning Brief
Ready at 07:30

[ Read ]
[ Listen ]
```

No debe aparecer automáticamente como modal salvo que el usuario configure expresamente ese comportamiento.

La regla general es:

> **ELISE prepares. The user decides when to consume.**

Esto aplica a:

- Morning Brief;
- weekly reviews;
- finance summaries;
- study reviews;
- meeting preparation;
- email digests;
- otros resultados programados.

---

# 6. Primary Navigation

La navegación principal debe mantenerse reducida.

Propuesta:

```text
Home
Chat
Knowledge
Connections
Schedules
My Elise
Settings
```

No se deben agregar Tasks, Habits, Finance, Study y otras capabilities como elementos principales separados.

Esas funcionalidades viven agrupadas dentro de áreas más amplias.

---

# 7. My Elise

`My Elise` agrupa las capabilities nativas personales.

```text
My Elise
├── Tasks
├── Habits
├── Lists
├── Finance
├── Goals
└── Notes
```

Esto mantiene la navegación principal limpia y permite agregar nuevos módulos nativos sin saturar la aplicación.

Cada módulo puede tener:

- vista propia;
- interacción desde chat;
- integración con Morning Brief;
- integración con Schedules;
- relación con Knowledge y otras capabilities.

---

# 8. Study Inside Knowledge

Study no debe ser una aplicación completamente separada.

Debe ser una experiencia disponible sobre Knowledge.

Ejemplo:

```text
Knowledge
└── University
    └── Administración

        [ Ask ]
        [ Study ]
```

Dentro de Study pueden aparecer opciones como:

- Tutor;
- Quiz;
- Oral Exam;
- Flashcards;
- Summary;
- Study Plan;
- Weak Topics;
- Future: mind maps, audio summaries, reports.

Esto permite que el material siga perteneciendo al mismo sistema de Knowledge.

---

# 9. Onboarding Philosophy

El onboarding debe ser:

- corto;
- visual;
- animado;
- progresivo;
- skippable cuando sea posible;
- altamente comprensible.

ELISE es un producto conceptualmente complejo.

El onboarding es una parte central del producto porque debe explicar su valor sin explicar su arquitectura.

Solo se debe exigir la configuración mínima necesaria para comenzar.

El resto podrá completarse posteriormente.

---

# 10. Onboarding Flow

## Step 1 — Welcome

Objetivo:

- introducir ELISE;
- transmitir identidad;
- explicar en pocas palabras qué hace.

No mostrar arquitectura técnica.

Ejemplo conceptual:

> **One intelligence. Everything under control.**

---

## Step 2 — What Should ELISE Help You With?

Mostrar capabilities, no providers.

Ejemplo:

```text
What do you want help with?

[x] Email
[x] Calendar
[x] Tasks
[x] Knowledge
[x] Habits
[ ] Finance
[ ] Study
```

La selección debe adaptar los pasos posteriores.

No se debe sobrecargar con demasiadas opciones a la vez.

---

## Step 3 — Connect Your Tools

Mostrar providers relevantes según las capabilities seleccionadas.

Ejemplo:

```text
Email
[ Connect Gmail ]

Calendar
[ Connect Google Calendar ]

Knowledge
[ Connect Notion ]
[ Connect Google Drive ]
[ Upload files ]
```

Cuando exista ELISE Native, debe aparecer como alternativa.

Ejemplo:

```text
Tasks

[ Use ELISE Tasks ]
[ Connect Google Tasks ]
```

ELISE Native debe presentarse como una opción oficial, no como fallback de menor calidad.

---

# 11. Morning Brief Setup During Onboarding

La configuración del Morning Brief debe formar parte del onboarding inicial.

Es una experiencia distintiva de ELISE.

El onboarding debe permitir seleccionar:

```text
Morning Brief

When?
Weekdays at 07:30

Include:
[x] Calendar
[x] Important email
[x] Tasks
[x] Habits
[x] Relevant news
[ ] Finance
[ ] Goals

Additional instructions:
[ Optional text ]
```

Debe existir una configuración recomendada lista para usar.

El usuario no debe necesitar redactar un prompt desde cero.

---

# 12. Future Personality Setup

La personalización avanzada de personalidad no forma parte del MVP inicial.

En versiones posteriores se podrá permitir configurar:

```text
Response detail
Concise ↔ Detailed

Proactivity
Quiet ↔ Proactive

Tone
Professional ↔ Casual
```

La arquitectura y UX deben dejar espacio para esta evolución.

---

# 13. Connections

Connections debe ofrecer una visión simple de qué servicios tiene conectados el usuario.

Ejemplo:

```text
Google
Connected

Gmail
✓ Enabled

Calendar
✓ Enabled

Drive
✓ Enabled

Tasks
✓ Enabled
```

El usuario debe poder:

- ver el estado;
- reconectar;
- desactivar capabilities;
- desconectar;
- agregar otra cuenta;
- cambiar alias/contexto.

---

# 14. Multiple Accounts

El soporte multi-account debe ser visible pero simple.

Ejemplo:

```text
Gmail

Personal
leo@gmail.com
Default for Personal

Firbot
leo@firbot.com
Default for Work

[ + Add account ]
```

Cada cuenta puede tener:

- nombre visible;
- provider;
- account identity;
- scope/context;
- default status;
- capabilities habilitadas;
- permissions.

ELISE puede sugerir alias automáticamente.

---

# 15. Source Permissions

Cuando una fuente soporte distintos niveles de acceso, la UI debe mostrar permisos con lenguaje simple.

Conceptualmente:

```text
ELISE can:

[x] Understand this source
[x] Read current data
[ ] Make changes
```

Equivalente en español:

```text
ELISE puede:

[x] Entender esta fuente
[x] Consultar datos actuales
[ ] Modificar información
```

Estos niveles corresponden internamente a distintos comportamientos, pero el usuario no necesita conocer términos como RAG, API read o tool write.

---

# 16. Knowledge Experience

Knowledge debe sentirse como una biblioteca inteligente.

Ejemplo:

```text
Knowledge

Firbot
Clients
Study
Personal

[ + New Space ]
```

Cada Space debe mostrar:

- Sources;
- Files;
- Notes;
- Sync status;
- last updated;
- search;
- Ask this Space;
- Study cuando corresponda.

---

# 17. Creating Knowledge Spaces

Los Knowledge Spaces pueden crearse de tres formas.

## Manual

El usuario crea:

```text
Firbot
Client A
University
Personal
```

Crear un Space es un diálogo de dos pasos que se puede cerrar en cualquier momento sin dejar
rastro:

1. **Create a Knowledge Space**: “What should ELISE understand here?”. Nombre y una descripción
   opcional.
2. **Add knowledge**: Upload files / Connect Google Drive / Connect Notion / Start empty. Crear un
   Space vacío está permitido.

Dentro de un Space, “+ Add source” ofrece las mismas opciones. Las fuentes (archivos subidos,
Drive, Notion, ELISE Notes) conviven en el mismo Space. Renombrar, mover, crear un sub-Space o
archivar quedan en “Space settings”.

Un archivo adjuntado en el chat nunca se guarda en silencio: el usuario elige sumarlo a un Space
(existente o nuevo). “Usarlo solo en esta conversación” aparece como próximamente, hasta que
existan archivos por conversación.

## Suggested by ELISE

ELISE puede detectar grupos y sugerir:

> “Encontré varias páginas relacionadas con RSFA. ¿Querés crear un Space para este cliente?”

## During connection

Al conectar Notion o Drive, ELISE puede proponer una organización inicial.

La propuesta nunca debe ser irreversible.

---

# 18. Knowledge Source Setup

Cuando el usuario agrega Notion, Drive u otra fuente, la experiencia debe evitar exigir estructuras predeterminadas.

Flujo conceptual:

```text
Connect source
    ↓
Select what ELISE may access
    ↓
Choose target Knowledge Space
    ↓
Choose permissions
    ↓
Index / Sync
```

ELISE debe encargarse de interpretar la estructura interna de la fuente.

---

# 19. Schedules

El nombre provisional de producto será:

**Schedules**

Para la interfaz en español se utilizará inicialmente:

**Programados**

Alternativas como `Recurrentes` pueden explorarse posteriormente durante diseño de UX.

Internamente puede existir otro nombre técnico.

El objetivo es representar acciones que ELISE ejecutará posteriormente o de forma recurrente.

---

# 20. Creating a Schedule

Crear un Schedule debe ser extremadamente simple.

La experiencia principal será lenguaje natural.

Ejemplo:

> “Todos los días de semana a las 7:30 preparame mi Morning Brief.”

ELISE transforma la intención en una configuración editable:

```text
Morning Brief

When
Monday – Friday
07:30

Sources
Calendar
Email
Tasks
Habits
News

Delivery
ELISE

[ Create ]
```

El usuario confirma la representación estructurada.

No debe necesitar comprender cron expressions.

---

# 21. Schedule Management

Cada Schedule debe permitir:

- activate;
- pause;
- edit;
- delete;
- run now;
- duplicate posteriormente;
- next run;
- last run;
- status.

La UI debe priorizar el estado actual y no los detalles técnicos.

---

# 22. Execution History

El historial de ejecuciones debe existir, pero no ser protagonista.

Ejemplo:

```text
Morning Brief

Last run
Today · 07:30
✓ Completed

Next run
Tomorrow · 07:30

[ History ]
```

Dentro de History:

```text
Today       ✓ Completed
Yesterday   ✓ Completed
Saturday    ⚠ Gmail unavailable
```

El usuario puede profundizar si necesita diagnosticar un problema.

---

# 23. Approvals

ELISE debe tener una experiencia centralizada de aprobaciones pendientes.

Puede aparecer como:

```text
Approvals
2 pending
```

Ejemplo:

```text
ELISE wants to send:

To: client@example.com
Subject: Proposal follow-up

[ Review ]
[ Approve ]
[ Reject ]
```

O:

```text
Delete calendar event?

Client Meeting
Tomorrow 14:00

[ Approve ]
[ Cancel ]
```

Las aprobaciones deben ser:

- claras;
- contextuales;
- rápidas;
- reversibles cuando sea posible.

---

# 24. Notifications

El MVP utilizará inicialmente:

- in-app notifications;
- browser notifications.

Las notificaciones deben ser configurables.

No todo resultado generado por ELISE debe producir una notificación.

El usuario podrá decidir qué merece interrupción.

Futuros canales pueden incluir:

- email;
- WhatsApp;
- mobile push;
- voice/call;
- Slack/Teams.

---

# 25. Voice Orb

La voz tendrá una representación visual central mediante un **ELISE Orb**.

El Orb puede tener estados visuales:

```text
Idle
Listening
Thinking
Speaking
Executing
Error / attention
```

Las animaciones deben comunicar estado, no ser solamente decorativas.

Ejemplo:

```text
Idle      → subtle breathing
Listening → audio-reactive
Thinking  → controlled motion
Speaking  → voice-reactive
Executing → progress/activity indication
```

El Orb será una pieza importante de identidad visual.

---

# 26. Voice Interaction

El usuario podrá:

- iniciar voz desde Home/Chat;
- hablar;
- interrumpir;
- volver a texto;
- ejecutar acciones mediante voz.

La conversación de voz debe compartir el mismo contexto que la conversación escrita.

No deben existir dos ELISE separadas.

---

# 27. Mobile UX

Mobile debe priorizar acciones rápidas.

Orden conceptual:

```text
Chat / Voice
Briefs
Tasks
Approvals
Notifications
```

Administración profunda como:

- provider mappings;
- sync settings;
- advanced permissions;
- large Knowledge management;

seguirá siendo accesible, pero no debe dominar la experiencia mobile.

La aplicación seguirá siendo completamente responsive.

---

# 28. ELISE Native Finance

Finance debe tener una interfaz visual básica dentro de My Elise.

El MVP debe incluir al menos:

```text
Current period
Income
Expenses
Net

Recent transactions

Categories

Accounts
```

Además de la interacción mediante chat.

El dashboard debe ayudar a leer rápidamente el estado financiero sin intentar competir inicialmente con aplicaciones financieras especializadas.

---

# 29. Progressive Disclosure

La configuración avanzada debe estar disponible sin invadir la experiencia normal.

Ejemplo:

```text
Connection Settings

General
...

Advanced
  Account priority
  Sync behavior
  Custom instructions
  Provider-specific settings
```

La mayoría de los usuarios no debería necesitar abrir `Advanced`.

---

# 30. Empty States

Todas las pantallas vacías deben explicar qué hacer después.

Ejemplo:

```text
No Knowledge Sources Yet

Give ELISE something to learn from.

[ Connect Notion ]
[ Connect Drive ]
[ Upload Files ]
```

Otro ejemplo:

```text
No Schedules Yet

Tell ELISE something you'd like handled automatically.

[ Create Schedule ]
```

Nunca dejar una pantalla vacía sin orientación.

---

# 31. Setup Health

ELISE debe ofrecer un indicador discreto de configuración.

Ejemplo:

```text
ELISE Setup

78%

✓ Email connected
✓ Calendar connected
✓ Tasks ready
✓ Morning Brief configured
! Knowledge not connected
! Notifications disabled
```

No debe sentirse como gamificación artificial.

Su función es ayudar al usuario a descubrir capacidades faltantes.

---

# 32. UI Naming Convention

Marca/logo:

```text
ELISE
```

Conversación y texto normal:

```text
Elise
```

Esto permite una marca visual fuerte sin forzar mayúsculas en toda la experiencia.

---

# 33. Language

ELISE debe estar preparada para:

- Spanish;
- English.

El mercado inicial incluye Argentina, por lo que español es una experiencia de primera clase.

La arquitectura frontend debe contemplar internacionalización desde el comienzo.

No hardcodear textos de interfaz directamente en componentes cuando pueda evitarse razonablemente.

---

# 34. Spanish / English Terminology

Algunos nombres iniciales:

| English | Spanish |
|---|---|
| Home | Inicio |
| Chat | Chat |
| Knowledge | Conocimiento |
| Connections | Conexiones |
| Schedules | Programados |
| My Elise | Mi Elise |
| Settings | Configuración |
| Approvals | Aprobaciones |
| Morning Brief | Morning Brief / Resumen del día |
| Tasks | Tareas |
| Habits | Hábitos |
| Lists | Listas |
| Finance | Finanzas |
| Goals | Objetivos |
| Notes | Notas |

Los nombres finales deberán validarse durante la etapa de diseño.

No es obligatorio traducir literalmente todos los conceptos si una expresión en inglés resulta más natural para el mercado objetivo.

---

# 35. Visual Motion Principles

La animación es una parte importante de la identidad.

Debe utilizarse para:

- onboarding;
- estados del Orb;
- transiciones;
- loading;
- ejecución;
- conexión exitosa;
- resultados disponibles;
- cambios de contexto.

Debe evitarse:

- motion constante sin propósito;
- efectos que dificulten lectura;
- tiempos de espera artificiales;
- sobrecarga visual.

Principio:

> **Motion should communicate intelligence and state.**

---

# 36. Desktop vs Mobile

## Desktop

Prioriza:

- chat;
- Knowledge management;
- Connections;
- configuration;
- Finance dashboards;
- Schedule management;
- advanced settings.

## Mobile

Prioriza:

- voice;
- chat;
- brief consumption;
- tasks;
- habit check-ins;
- approvals;
- quick capture.

Ambos deben acceder al mismo sistema y datos.

---

# 37. UX of Background Work

Cuando ELISE ejecute procesos en background, la interfaz debe reflejar estado sin bloquear.

Ejemplo:

```text
Indexing Google Drive
64%

You can keep using ELISE.
```

O:

```text
Preparing Morning Brief...
```

El usuario puede navegar fuera.

Cuando termine:

```text
Morning Brief ready.
```

---

# 38. Error Experience

Los errores deben mostrarse en lenguaje accionable.

Malo:

```text
OAuth token invalid.
```

Mejor:

```text
Google Calendar needs to be reconnected.

[ Reconnect ]
```

Malo:

```text
Vector indexing failed.
```

Mejor:

```text
We couldn't process 2 files.

[ Review files ]
```

La complejidad técnica queda disponible en logs avanzados, no en mensajes primarios.

---

# 39. Confidence and Clarification

Cuando ELISE no tenga suficiente confianza para realizar una acción con consecuencias, debe preguntar.

Ejemplo:

```text
Which account should I use?

Personal
Firbot
```

Las preguntas deben ser:

- breves;
- contextuales;
- presentadas preferentemente como choices cuando existan opciones claras.

No preguntar por detalles que ELISE pueda resolver con seguridad.

---

# 40. UX Principle Summary

La experiencia de ELISE debe seguir estas reglas:

1. Chat first.
2. One continuous intelligence.
3. Proactive but non-invasive.
4. Smart defaults before configuration.
5. Native alternatives when useful.
6. Multiple accounts without complexity.
7. Natural language before forms.
8. Structured confirmation before important automation.
9. Advanced settings remain available but hidden.
10. Voice and visual state work together.
11. Background work never blocks the user unnecessarily.
12. Empty states always guide.
13. Errors always suggest recovery.
14. Desktop handles depth.
15. Mobile handles immediacy.
16. Spanish and English are first-class.
17. A futuristic interface must remain usable.

---

# 41. North Star Experience

The ideal ELISE experience is:

> The user opens ELISE and immediately has one place to talk, ask, plan and act.
>
> ELISE has already prepared what matters, but waits for the user instead of interrupting unnecessarily.
>
> Connected tools, personal data, scheduled work and knowledge remain behind a simple interface.
>
> The user sees one intelligence.
>
> Everything else is infrastructure.
