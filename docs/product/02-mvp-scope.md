# ELISE — MVP Scope

**Document:** `02-mvp-scope.md`  
**Status:** Draft v1  
**Purpose:** Definir con precisión qué debe incluir la primera versión funcional de ELISE, qué queda explícitamente fuera, qué experiencias son prioritarias y qué condiciones deben cumplirse para considerar el MVP terminado.

---

# 1. Objetivo del MVP

El objetivo del MVP es que **ELISE ya pueda utilizarse de forma real en el día a día**, inicialmente para la organización personal y operativa de su creador, pero desde una interfaz y una arquitectura entendibles, configurables y reutilizables por otros usuarios.

El MVP no debe ser solamente una demo técnica.

Debe permitir comenzar a depender de ELISE para tareas reales como:

- organizar el día;
- revisar calendario;
- revisar correos;
- recibir un Morning Brief útil;
- consultar tareas;
- seguir hábitos;
- revisar finanzas;
- consultar conocimiento;
- estudiar;
- crear y consultar información;
- ejecutar acciones básicas;
- programar tareas recurrentes;
- conversar por texto y voz.

El producto inicial debe ser suficientemente flexible para que otros usuarios puedan conectarlo a sus propias cuentas y configurarlo según su forma de trabajar.

---

# 2. Momento principal de valor

El principal “wow moment” del MVP será el **Morning Brief**.

Al comenzar el día, ELISE debe poder presentar un resumen útil y personalizado basado en información real proveniente de distintas fuentes.

El Morning Brief debe poder combinar, según configuración del usuario:

- calendario;
- agenda de la semana;
- tareas;
- hábitos;
- correos importantes;
- borradores pendientes;
- información relevante de proyectos;
- noticias y actualidad;
- recordatorios;
- prioridades del día;
- información personal relevante;
- otros módulos habilitados por el usuario.

El Brief no debe ser rígido.

Debe existir un comportamiento predeterminado razonable, pero el usuario podrá definir:

- qué fuentes consultar;
- qué información incluir;
- qué excluir;
- qué considera importante;
- qué tipo de noticias le interesan;
- nivel de detalle;
- prioridades;
- estilo del resumen;
- horario;
- días de ejecución.

La utilidad del Morning Brief será uno de los principales criterios de éxito del MVP.

---

# 3. Principios de alcance

El MVP debe cumplir estos principios:

1. Debe ser funcional, no solamente demostrativo.
2. Debe estar diseñado para múltiples usuarios desde el comienzo.
3. Debe soportar múltiples cuentas de un mismo provider.
4. Debe ofrecer smart defaults.
5. Debe permitir configuración sin exponer complejidad técnica.
6. Debe incluir una identidad visual fuerte desde la primera versión.
7. Debe ser web-first y responsive.
8. Debe permitir uso real desde desktop y mobile browser.
9. Debe mantener una arquitectura extensible para futuros providers.
10. Debe evitar dependencias innecesarias de herramientas externas cuando exista una alternativa ELISE Native útil.

---

# 4. Usuario objetivo inicial

El público inicial sigue siendo:

- founders;
- emprendedores;
- dueños de negocio;
- profesionales que manejan múltiples proyectos;
- power users con varias herramientas digitales.

Sin embargo, determinadas experiencias como Study Mode se incluirán desde el MVP porque también aportan valor a este público en:

- formación continua;
- cursos;
- certificaciones;
- aprendizaje profesional;
- estudio formal;
- capacitación interna.

---

# 5. Universal Chat

El MVP debe incluir un **chat central único con ELISE**.

Este chat será la interfaz principal para:

- preguntas;
- instrucciones;
- consultas de conocimiento;
- ejecución de tools;
- manejo de tareas;
- consulta de calendario;
- consulta de correo;
- estudio;
- hábitos;
- finanzas;
- interacción con rutinas;
- otras capacidades habilitadas.

## Historial

Las conversaciones deben quedar registradas.

El usuario debe poder consultar conversaciones anteriores de manera similar a un historial de chats.

El historial debe servir principalmente como:

- log de interacciones;
- referencia;
- continuidad de conversación;
- fuente eventual de memoria.

No es necesario replicar exactamente la UX de ChatGPT.

ELISE sigue siendo una sola inteligencia aunque existan múltiples conversaciones almacenadas.

---

# 6. Voz

La voz entra en el MVP.

## MVP

Debe existir:

- speech input;
- respuesta hablada;
- interacción básica por voz;
- posibilidad de alternar entre texto y voz.

La personalización avanzada de voz queda fuera.

El objetivo inicial es demostrar que ELISE puede utilizarse de manera natural mediante conversación hablada.

## Posterior al MVP

Queda para versiones posteriores:

- ElevenLabs;
- selección avanzada de voces;
- voice cloning;
- múltiples voice providers visibles al usuario;
- tuning detallado de expresividad;
- llamadas telefónicas;
- wake word persistente.

La arquitectura debe evitar acoplar el producto a un único proveedor de voz.

---

# 7. Morning Brief

El Morning Brief es una capability central del MVP.

## Fuentes previstas

El usuario podrá habilitar o deshabilitar fuentes como:

- Email;
- Calendar;
- Tasks;
- Habits;
- Finance;
- News / Web;
- Knowledge;
- información de proyectos;
- datos futuros de otras capabilities.

## Configuración

Debe existir:

- un preset inicial útil;
- configuración simple;
- instrucciones personalizadas opcionales.

Ejemplos:

```text
Include:
- important emails
- today's calendar
- overdue tasks
- habit progress
- relevant AI news

Ignore:
- newsletters
- low priority emails
- sports news
```

El usuario no debe necesitar escribir un prompt técnico.

La interfaz deberá convertir preferencias en configuración interna.

---

# 8. Email Copilot

El MVP debe incluir Email como capability.

## Provider inicial

- Gmail

Otros providers quedan fuera del MVP inicial.

## Multi-account

Un mismo usuario debe poder conectar múltiples cuentas de Gmail.

Ejemplos:

```text
Personal Gmail
Acme Gmail
Another business Gmail
```

Cada conexión puede tener:

- nombre;
- contexto;
- prioridad;
- reglas;
- comportamiento propio.

ELISE debe poder seleccionar la cuenta adecuada cuando exista suficiente contexto y preguntar cuando exista ambigüedad relevante.

## Capacidades mínimas

ELISE debe poder:

- buscar emails;
- leer mensajes;
- leer threads;
- resumir emails;
- identificar mensajes importantes;
- detectar potencial spam o ruido;
- identificar mensajes que probablemente requieren respuesta;
- preparar drafts cuando corresponda;
- descartar drafts desde la experiencia ELISE;
- incluir emails relevantes en el Morning Brief;
- ayudar a limpiar emails innecesarios según reglas configuradas.

## Reglas

La importancia y necesidad de respuesta deben poder configurarse.

Debe existir un default, pero el usuario podrá definir criterios como:

- remitentes prioritarios;
- clientes;
- palabras clave;
- newsletters;
- notificaciones automáticas;
- tipos de email que nunca necesitan respuesta;
- tipos de email que suelen necesitar draft;
- criterios para incluir un mensaje en el Morning Brief.

El sistema no debe generar drafts indiscriminadamente.

---

# 9. Calendar

Calendar entra en el MVP.

## Provider inicial

- Google Calendar

## Multi-account y multi-calendar

ELISE debe contemplar desde el comienzo que:

- un usuario puede conectar varias cuentas de Google;
- una misma cuenta puede tener múltiples calendarios.

Ejemplos:

```text
Google Account A
├── Personal
├── Acme
└── University

Google Account B
├── Client Calendar
└── Shared Team Calendar
```

ELISE debe poder considerar múltiples calendarios al responder preguntas sobre disponibilidad o planificación.

## Capacidades mínimas

- consultar eventos;
- mostrar agenda;
- ver próximos eventos;
- consultar disponibilidad;
- crear eventos;
- modificar eventos;
- eliminar eventos con confirmación apropiada;
- utilizar calendario dentro del Morning Brief;
- utilizar calendario como contexto para planificación del día o semana.

---

# 10. Tasks

Tasks entra en el MVP con dos alternativas iniciales.

## Providers

- ELISE Tasks Native;
- Google Tasks.

## ELISE Tasks Native

Debe soportar inicialmente:

- title;
- description;
- status;
- due date;
- priority;
- created date;
- completed date;
- optional project/category;
- basic notes.

Capacidades:

- crear;
- editar;
- completar;
- reabrir;
- eliminar;
- listar;
- filtrar;
- priorizar;
- utilizar tareas dentro del Morning Brief.

## Google Tasks

Debe poder conectarse como provider externo manteniendo Google Tasks como source of truth.

---

# 11. Habits

Habits forma parte del MVP.

## Providers iniciales

- ELISE Habits Native;
- Notion, cuando una base estructurada pueda mapearse a Habits.

## ELISE Habits Native

El modelo debe contemplar como mínimo:

- habit;
- target;
- frequency;
- check-ins;
- streak;
- weekly progress;
- history.

Ejemplos:

```text
Workout
Goal: 3 / week

Read
Goal: 4 / week
```

El usuario debe poder registrar hábitos desde chat:

> "Elise, hoy entrené."

y desde la UI.

Los hábitos deben poder incorporarse al Morning Brief.

---

# 12. Lists

ELISE Lists Native entra en el MVP.

Debe permitir listas simples como:

- shopping lists;
- pendientes;
- ideas;
- packing lists;
- listas personalizadas.

Operaciones mínimas:

- crear lista;
- agregar ítem;
- completar ítem;
- editar;
- eliminar;
- consultar.

Debe poder utilizarse desde el chat y desde una interfaz simple.

---

# 13. Goals

ELISE Goals Native entra en el MVP.

Debe permitir representar objetivos personales o profesionales.

Modelo inicial:

- title;
- description;
- status;
- target date;
- progress;
- category;
- optional related tasks/habits.

El objetivo no es construir un sistema complejo de OKRs en el MVP.

Debe servir principalmente para aportar contexto a ELISE y relacionar acciones diarias con objetivos de mayor nivel.

---

# 14. Notes

ELISE Notes Native entra en el MVP en forma básica.

Debe permitir:

- guardar notas rápidas;
- consultar notas;
- relacionarlas a Knowledge Spaces;
- crear notas desde conversación.

Ejemplo:

> "Elise, guardá esto en el proyecto Fernández López."

Las notas podrán alimentar el sistema de Knowledge.

---

# 15. Finance

Finance entra en el MVP.

## Providers iniciales

- ELISE Finance Native;
- Google Sheets como fuente externa.

Excel puede formar parte del roadmap inmediatamente posterior, pero no es obligatorio para cerrar el primer MVP si complica el release.

## ELISE Finance Native

Modelo inicial:

- accounts;
- transactions;
- type;
- date;
- amount;
- currency;
- category;
- subcategory;
- payment method;
- vendor/client;
- project;
- status;
- notes.

Casos de uso:

- registrar un gasto;
- registrar un ingreso;
- consultar gastos por período;
- consultar ingresos;
- filtrar por categoría;
- analizar gastos por proyecto;
- generar resúmenes;
- mostrar información relevante dentro del Morning Brief si el usuario lo desea.

No incluye:

- conexión bancaria directa;
- ejecución de pagos;
- inversiones automáticas;
- operaciones financieras sensibles.

---

# 16. Knowledge

Knowledge entra en el MVP como una capability central.

## Providers iniciales

- ELISE Uploads;
- Notion;
- Google Drive.

## Archivos permitidos

El MVP debe soportar un conjunto controlado de formatos útiles.

Ejemplos previstos:

- PDF;
- DOCX;
- TXT;
- MD;
- archivos de texto compatibles.

Otros formatos podrán incorporarse posteriormente.

Deben existir:

- límites de tamaño;
- límites por usuario/plan en el futuro;
- validación de MIME type;
- rechazo explícito de formatos no soportados.

No se debe aceptar cualquier archivo de forma indiscriminada.

---

# 17. Knowledge Spaces

Un Knowledge Space es un contenedor lógico de conocimiento.

No representa necesariamente una carpeta física.

Sirve para agrupar información por contexto.

Ejemplos:

```text
Acme
├── Client A
├── Client B
└── Internal

University
├── Administration
├── Legislation
└── Systems
```

Un Knowledge Space puede tener múltiples fuentes.

Ejemplo:

```text
Acme / Client A

Sources:
- Notion Account A
- Google Drive
- Uploaded PDFs
- ELISE Notes
```

ELISE debe poder buscar dentro del espacio sin obligar al usuario a recordar en qué aplicación vive cada documento.

El MVP debe permitir:

- crear spaces;
- renombrar;
- organizar;
- agregar fuentes;
- subir nuevos documentos progresivamente;
- buscar;
- responder utilizando contenido indexado;
- mostrar fuentes utilizadas.

---

# 18. Notion

Notion entra en el MVP.

## Multi-account

Un usuario debe poder conectar múltiples cuentas/workspaces de Notion.

Esto es un requisito explícito.

Ejemplo:

```text
Personal Notion
Acme Notion
Client Notion
```

## Usos iniciales

Notion deberá poder utilizarse para:

### Search & Answer

ELISE puede indexar páginas autorizadas y utilizarlas como Knowledge.

### Read Live Data

Cuando el usuario configure una database estructurada, ELISE podrá consultar sus valores actuales.

### Make Changes

Para determinadas bases configuradas, ELISE podrá realizar modificaciones si el usuario concede permisos.

No se debe asumir una estructura universal de Notion.

El sistema deberá adaptarse a distintas estructuras mediante discovery, metadata y mapping asistido.

---

# 19. Google Drive

Google Drive entra en el MVP como Knowledge Provider.

Debe permitir:

- conectar cuenta;
- seleccionar contenido autorizado;
- indexar archivos soportados;
- mantener referencia al original;
- detectar cambios cuando sea posible;
- utilizar documentos como Knowledge.

Debe soportar múltiples cuentas por usuario.

---

# 20. Google Sheets

Google Sheets entra en el MVP.

Se utilizará principalmente como structured data provider.

Casos iniciales:

- Finance;
- datos personalizados;
- tablas que el usuario quiera consultar;
- importaciones hacia ELISE Native.

Debe existir un mecanismo de mapping entre columnas externas y modelos canónicos de ELISE.

La IA podrá proponer mappings.

El usuario deberá poder revisar y confirmar mappings importantes.

---

# 21. Study Mode

Study Mode entra en el MVP.

No será una aplicación separada.

Será una experiencia especializada dentro de ELISE.

Debe permitir:

- seleccionar o inferir una materia/Knowledge Space;
- explicar contenido;
- resumir;
- realizar repasos;
- hacer preguntas;
- simular examen oral;
- generar preguntas de práctica;
- consultar documentos;
- utilizar exclusivamente fuentes relevantes cuando corresponda.

Debe aprovechar el mismo Knowledge System general.

---

# 22. Client / Work Knowledge

El MVP debe permitir organizar conocimiento por:

- cliente;
- proyecto;
- empresa;
- área.

Ejemplo:

```text
Work
└── Acme
    ├── Client A
    ├── Client B
    └── Internal
```

Casos de uso:

> "¿Qué habíamos acordado con Client A?"

> "¿Cuál era el último requerimiento del proyecto?"

> "Preparame para la reunión."

Esto debe resolverse mediante Knowledge Spaces y contexto, no mediante un agente diferente por cliente.

---

# 23. Scheduled Tasks

Durante el desarrollo evitaremos utilizar “Routines” como nombre definitivo de producto para no confundirlo con conceptos similares de otros productos.

El nombre final se definirá más adelante.

Conceptualmente, el MVP debe permitir **tareas programadas administradas por ELISE**.

## MVP

Debe permitir:

- crear una tarea programada desde lenguaje natural;
- definir horario;
- definir recurrencia;
- activar;
- pausar;
- editar;
- ejecutar manualmente;
- eliminar;
- visualizar próxima ejecución;
- visualizar historial básico.

Ejemplo:

> "Todos los días de semana a las 7:30 preparame mi Morning Brief."

## Fuera del alcance inicial

Los event triggers y condition triggers complejos no son requisito para considerar terminado el MVP.

La arquitectura debe permitir agregarlos posteriormente.

---

# 24. Rules and Preferences

La configuración de comportamiento entra en el MVP.

No se construirá inicialmente un rule builder visual genérico.

Cada capability podrá ofrecer configuración clara.

Ejemplos:

## Email

- qué se considera importante;
- qué se considera ruido;
- cuándo crear draft;
- remitentes prioritarios;
- tono;
- comportamiento de limpieza.

## Morning Brief

- fuentes;
- horario;
- noticias;
- longitud;
- prioridades.

## Habits

- qué incluir;
- objetivos;
- frecuencia.

## Study

- estilo de explicación;
- nivel de dificultad;
- tipo de repaso.

Debe existir:

- smart default;
- controles simples;
- instrucciones personalizadas opcionales.

---

# 25. News and Web Search

News / Web Search entra en el MVP.

No requiere una conexión personal del usuario.

Debe poder utilizarse:

- dentro del Morning Brief;
- desde Universal Chat;
- para consultas de actualidad.

## Personalización

El usuario podrá definir intereses.

Ejemplo:

```text
Topics:
- AI
- Automation
- Business
- Argentina
- Technology

Avoid:
- celebrity news
- sports
```

ELISE debe priorizar relevancia sobre volumen.

---

# 26. Connections del MVP

Providers externos iniciales:

## Google

- Gmail;
- Google Calendar;
- Google Drive;
- Google Sheets;
- Google Tasks.

## Other

- Notion.

## ELISE Native

- Tasks;
- Habits;
- Lists;
- Finance;
- Goals;
- Notes;
- Uploads / Knowledge.

---

# 27. Multiple Accounts

El soporte de múltiples conexiones a un mismo provider es un requisito del MVP.

Ejemplos:

```text
2 Gmail accounts
3 Google Calendars/accounts
2 Notion workspaces
2 Google Drive accounts
```

Cada conexión debe poder tener:

- display name;
- account identity;
- context/scope;
- default status;
- enabled capabilities;
- permissions.

El sistema no debe asumir “un provider = una cuenta”.

---

# 28. User Interface

La identidad visual de ELISE es parte del MVP.

No se considera aceptable lanzar una interfaz genérica para “diseñarla después”.

La UI debe transmitir desde temprano:

- modernidad;
- simplicidad;
- inteligencia;
- sensación tecnológica;
- inspiración tipo JARVIS sin copiar literalmente su diseño;
- claridad;
- animaciones funcionales;
- excelente visualización de información.

Claude Design se utilizará para explorar y definir la dirección visual.

## Principio

La estética futurista no debe sacrificar usabilidad.

Pantallas administrativas como:

- Connections;
- Knowledge;
- Settings;
- Finance;
- Habits;

deben seguir siendo claras y familiares.

---

# 29. Mobile

El MVP será web-first pero completamente responsive.

Debe funcionar correctamente en:

- desktop;
- tablet;
- mobile browser.

No se requiere una aplicación iOS o Android nativa.

La experiencia mobile debe permitir como mínimo:

- chat;
- voz;
- Morning Brief;
- tareas;
- hábitos;
- listas;
- consultas principales.

---

# 30. Multi-user

El MVP debe estar preparado para múltiples usuarios reales.

No debe construirse como una aplicación exclusiva para una sola persona.

Cada usuario tendrá:

- autenticación;
- datos propios;
- conexiones propias;
- knowledge propio;
- configuración propia;
- tareas programadas propias;
- permisos propios.

La seguridad multi-tenant debe considerarse desde el comienzo.

---

# 31. Technical Observability

Debe existir observabilidad técnica suficiente para desarrollar y operar el MVP.

Debe ser posible inspeccionar:

- errores;
- tool calls;
- background jobs;
- connection failures;
- scheduled task runs;
- ingestion failures;
- AI errors.

No se requiere todavía un panel comercial de administración completo.

---

# 32. Fuera del MVP

Quedan explícitamente fuera del MVP inicial:

- WhatsApp;
- WhatsApp Business Coexistence;
- Slack;
- Microsoft Teams;
- Outlook;
- Microsoft Calendar;
- OneDrive;
- SharePoint;
- Monday.com;
- HubSpot;
- Salesforce;
- Metricool;
- Instagram API;
- TikTok API;
- YouTube analytics/publishing;
- ElevenLabs;
- voice cloning;
- llamadas telefónicas;
- mobile apps nativas;
- Teams / Business workspaces;
- pagos;
- suscripciones;
- Stripe;
- admin comercial;
- conexión bancaria;
- ejecución de pagos;
- event triggers avanzados;
- condition triggers avanzados;
- marketplace de capabilities;
- custom MCP marketplace;
- custom connector builder completo.

Estos elementos pertenecen al roadmap posterior.

---

# 33. MVP por slices internos

Aunque todas las capabilities anteriores formen parte del MVP definido, no deben desarrollarse simultáneamente.

El desarrollo debe dividirse en slices funcionales.

Una posible secuencia inicial será:

### Slice 1 — Foundation

- Auth;
- multi-user;
- base UI;
- Universal Chat;
- conversations;
- provider architecture;
- Supabase;
- basic AI runtime.

### Slice 2 — Calendar + Tasks

- Google Calendar;
- ELISE Tasks;
- Google Tasks;
- planning del día.

### Slice 3 — Email

- Gmail;
- email rules;
- summaries;
- importance;
- draft assistance.

### Slice 4 — Morning Brief

- schedule;
- calendar;
- email;
- tasks;
- news;
- configurable output.

### Slice 5 — Knowledge

- uploads;
- Knowledge Spaces;
- indexing;
- citations;
- search;
- Google Drive;
- Notion Knowledge.

### Slice 6 — Habits + Goals + Lists + Notes

- ELISE Native modules;
- chat integration;
- Morning Brief integration.

### Slice 7 — Finance

- ELISE Finance;
- Google Sheets;
- mapping/import;
- summaries.

### Slice 8 — Structured Notion

- database discovery;
- mappings;
- live reads;
- controlled writes.

### Slice 9 — Study + Work Knowledge

- Study Mode;
- client/project contexts;
- specialized experiences.

### Slice 10 — Voice

- speech input;
- speech output;
- chat continuity.

### Slice 11 — Visual refinement

- Claude Design direction;
- animation;
- responsive refinement;
- final MVP polish.

El orden puede modificarse durante implementación, pero cada slice debe producir una parte utilizable del sistema.

---

# 34. Definition of Done

El MVP se considera funcionalmente terminado cuando un usuario nuevo puede:

1. crear una cuenta;
2. iniciar sesión;
3. completar un onboarding simplificado;
4. conectar múltiples cuentas compatibles;
5. conectar Gmail;
6. conectar Google Calendar;
7. conectar Google Drive;
8. conectar Google Sheets;
9. conectar Google Tasks;
10. conectar Notion;
11. utilizar alternativas ELISE Native;
12. conversar con ELISE por texto;
13. conversar con ELISE por voz básica;
14. consultar información real de sus herramientas;
15. crear y gestionar tareas;
16. registrar y consultar hábitos;
17. utilizar listas;
18. definir objetivos;
19. almacenar notas;
20. registrar y consultar información financiera;
21. cargar documentos;
22. crear múltiples Knowledge Spaces;
23. realizar preguntas sobre Knowledge;
24. ver las fuentes utilizadas;
25. utilizar Study Mode;
26. consultar contexto de clientes/proyectos;
27. crear tareas programadas;
28. pausar, editar y eliminar esas tareas;
29. recibir un Morning Brief personalizado;
30. personalizar qué considera importante;
31. utilizar News / Web Search;
32. revisar historial de conversaciones;
33. utilizar ELISE correctamente desde desktop y mobile;
34. entender de forma simple qué herramientas están conectadas;
35. controlar sus permisos y configuraciones.

---

# 35. Criterio cualitativo de éxito

El MVP no estará terminado solamente porque todas las checkboxes técnicas funcionen.

Debe alcanzar un punto donde ELISE sea realmente útil en el día a día.

La pregunta principal será:

> **¿Puedo empezar a utilizar ELISE todos los días para organizarme, entender qué requiere mi atención y operar sobre mi información sin volver constantemente a mis aplicaciones originales?**

Si la respuesta es sí, el MVP habrá alcanzado su propósito.

---

# 36. North Star del MVP

> **El primer MVP de ELISE debe dejar de sentirse como una demo y empezar a sentirse como un asistente que realmente forma parte del día del usuario.**

El Morning Brief debe ser útil.

El chat debe tener contexto.

Las conexiones deben ser reales.

La configuración debe ser entendible.

Las acciones deben funcionar.

Y la experiencia debe sentirse como ELISE.
