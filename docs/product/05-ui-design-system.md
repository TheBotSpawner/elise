# ELISE — UI Design System

**Document:** `05-ui-design-system.md`  
**Status:** Draft v1  
**Purpose:** Definir la dirección visual, principios de interfaz, lenguaje de movimiento, estados de ELISE y criterios que deberán guiar el trabajo posterior en Claude Design y Claude Code.

---

# 1. Design Vision

ELISE debe combinar dos ideas que normalmente entran en tensión:

1. una interfaz futurista, viva y reconocible;
2. una aplicación real de productividad que siga siendo simple y fácil de usar.

La dirección visual inicial será:

> **Futuristic minimalism inspired by JARVIS. Dark or light, elegant, technical and alive, but designed as a real productivity product.**

JARVIS funciona como inspiración de lenguaje visual, no como interfaz a copiar literalmente.

ELISE debe evitar convertirse en:

- una HUD cinematográfica difícil de usar;
- una terminal técnica;
- un dashboard lleno de datos decorativos;
- un SaaS genérico con un color cyan agregado;
- una colección de efectos visuales sin función.

La interfaz debe sentirse avanzada porque responde, se adapta y comunica estado, no porque esté permanentemente llena de elementos animados.

---

# 2. Core Design Principles

La UI debe seguir estos principios:

## 2.1 Minimalism

Cada pantalla debe mostrar solamente lo necesario para la tarea actual.

## 2.2 Intelligence Through Motion

La interfaz debe sentirse viva.

Las animaciones tienen que comunicar:

- escucha;
- razonamiento;
- ejecución;
- progreso;
- éxito;
- error;
- transición entre contextos.

## 2.3 Futuristic but Familiar

La identidad puede ser novedosa, pero las interacciones principales deben seguir patrones que los usuarios ya entienden.

Por ejemplo:

- tablas siguen siendo tablas;
- formularios siguen siendo formularios;
- settings siguen siendo settings;
- botones destructivos siguen siendo claros;
- dashboards deben priorizar lectura antes que espectáculo.

## 2.4 One Intelligence

Todas las pantallas deben sentirse parte de la misma entidad.

ELISE no debe parecer una colección de mini-apps independientes.

## 2.5 State Is Visible

El usuario debe poder entender qué está haciendo ELISE sin tener que adivinar.

---

# 3. Theme

ELISE debe soportar desde el MVP:

- **Dark Mode**
- **Light Mode**

Dark Mode será la dirección visual más cercana a la identidad JARVIS inicial, pero Light Mode debe considerarse una experiencia de primera clase y no una inversión automática de colores realizada al final.

Ambos modos deben compartir:

- jerarquía;
- componentes;
- motion;
- spacing;
- identidad;
- estados;
- contraste suficiente.

---

# 4. Initial Color Direction

La primera exploración visual utilizará una paleta inspirada en JARVIS.

## Dark Mode

Conceptualmente:

```text
Background
near-black / deep blue-black

Surface
dark blue / graphite

Primary accent
electric cyan / turquoise

Secondary accent
cold blue

Text primary
near-white

Text secondary
muted cool gray
```

## Functional Colors

Los colores adicionales deben reservarse principalmente para significado:

```text
Success  → green
Warning  → amber
Error    → red
Info     → blue/cyan
```

No se definirá todavía un segundo color de marca dominante.

La intención inicial es mantener una identidad visual fuertemente cyan/JARVIS y evaluar variaciones durante el trabajo con Claude Design.

---

# 5. Light Mode

Light Mode no debe parecer una aplicación distinta.

Debe conservar:

- accent cyan;
- líneas técnicas sutiles;
- Orb;
- motion;
- jerarquía;
- componentes;
- estados.

La exploración de Claude Design deberá determinar cómo trasladar la sensación tecnológica a fondos claros sin depender de glows excesivos.

---

# 6. The ELISE Orb

El Orb será el elemento visual más icónico de ELISE.

Debe funcionar como una representación abstracta de la inteligencia.

No debe copiar:

- Arc Reactor;
- JARVIS HUD rings;
- ningún elemento reconocible de Iron Man.

Debe desarrollar una identidad propia.

---

# 7. Orb Visual Direction

La dirección inicial será más **orgánica y basada en ondas** que mecánica.

Conceptos a explorar:

- esfera abstracta;
- ondas concéntricas;
- deformación suave;
- partículas discretas;
- halos;
- energía;
- audio-reactivity;
- response to pointer;
- response to speech;
- response to execution state.

Una interacción deseada:

> Cuando el usuario mueve el mouse cerca o sobre el Orb, pequeñas ondas o deformaciones pueden expandirse hacia la posición del cursor.

Durante voz:

> Las ondas pueden expandirse, respirar o responder a la intensidad de la conversación.

El Orb debe sentirse vivo sin convertirse en una distracción permanente.

---

# 8. Orb Interaction States

El Orb debe tener estados visuales diferenciables.

Como mínimo:

```text
Idle
Listening
Thinking
Speaking
Executing
Waiting for Approval
Success
Error
Attention
```

Ejemplos conceptuales:

## Idle

Movimiento mínimo y respiración visual sutil.

## Listening

Respuesta más directa al audio, apertura o expansión.

## Thinking

Movimiento interno, ondas controladas o reorganización visual.

## Speaking

Reactividad sincronizada con salida de voz.

## Executing

Indicadores de actividad o progresión vinculados a herramientas.

## Waiting for Approval

Estado visual estable que indique que ELISE está esperando al usuario.

## Success

Confirmación breve.

## Error

Cambio reconocible sin usar únicamente color.

---

# 9. Logo

El logo todavía no está definido.

Claude Design deberá explorar varias propuestas.

Requisitos:

- minimalista;
- innovador;
- reconocible;
- compatible con la identidad del Orb;
- usable como app icon;
- usable en favicon;
- usable junto al wordmark `ELISE`;
- legible en dark y light mode;
- evitar clichés visuales genéricos de IA.

El logo no tiene que ser literalmente el Orb, pero debería convivir naturalmente con él.

---

# 10. Typography

La tipografía definitiva será explorada por Claude Design.

La dirección deseada es:

## Primary UI Font

- sans serif;
- moderna;
- extremadamente legible;
- limpia;
- tecnológica sin ser sci-fi.

## Optional Technical Font

Una tipografía monoespaciada podrá utilizarse de forma puntual para:

- system states;
- timestamps;
- technical metadata;
- execution information;
- pequeñas etiquetas de sistema.

No usar una fuente futurista como tipografía principal de lectura.

---

# 11. Information Density

La densidad definitiva deberá validarse mediante prototipos.

No se fija todavía un nivel rígido.

La exploración debe comparar:

- interfaces con mucho espacio negativo;
- densidad media;
- vistas de datos más compactas cuando la tarea lo necesite.

Principio:

> La densidad debe depender del trabajo que el usuario está realizando.

Home y Chat pueden ser muy aireados.

Finance, Knowledge, Tasks o logs pueden necesitar una densidad mayor.

---

# 12. Panels and Cards

La dirección provisional será:

> **Dark/light surfaces with subtle borders, using cyan primarily for active state, focus, connection or energy.**

Evitar convertir cada card en un rectángulo con borde cyan completo.

Los elementos HUD más marcados pueden reservarse para:

- estados activos;
- execution;
- voice;
- system feedback;
- momentos especiales de onboarding.

Glassmorphism puede explorarse de manera moderada, pero no debe convertirse en el lenguaje visual principal si compromete contraste o legibilidad.

---

# 13. Motion

Las animaciones serán una parte importante de la experiencia.

Deben estar especialmente presentes en:

- Orb;
- onboarding;
- cambios de estado;
- conexiones;
- tool execution;
- transiciones;
- loading;
- background processing;
- notifications;
- confirmations.

La presencia de motion debe sentirse sofisticada y deliberada.

Evitar:

- movimiento constante sin significado;
- tiempos artificialmente largos;
- animaciones que bloqueen acciones;
- transiciones excesivas entre cada click.

---

# 14. Home Composition

La Home debe mantener al chat como protagonista.

Dirección conceptual desktop:

```text
┌────────────────────────────────────────────────────┐
│ Minimal Navigation                                 │
│                                                    │
│                                                    │
│                     ELISE ORB                      │
│                                                    │
│              Conversation / Response               │
│                                                    │
│          [ Ask ELISE anything...   Mic ]           │
│                                                    │
│   Morning Brief ready · 2 approvals · 1 result     │
│                                                    │
└────────────────────────────────────────────────────┘
```

La Home no debe convertirse en un dashboard con veinte widgets.

Los datos deben aparecer cuando son relevantes.

---

# 15. Tool Execution Visualization

Cuando ELISE utiliza herramientas, el usuario debe poder ver qué está ocurriendo de forma elegante.

Ejemplo:

```text
Preparing your meeting brief

✓ Calendar
✓ Recent email
● Searching client knowledge
○ Reviewing open tasks
```

Cuando finaliza, el detalle puede colapsarse:

```text
✓ Prepared using 4 sources
```

El usuario podrá expandirlo si quiere inspeccionar el proceso.

Esto aporta:

- confianza;
- transparencia;
- sensación de inteligencia activa;
- debugging comprensible.

---

# 16. Operational Interfaces

No todas las pantallas deben parecer una HUD.

Módulos como:

- Finance;
- Tasks;
- Habits;
- Knowledge;
- Connections;
- Settings;
- Schedules;

deben utilizar componentes familiares y eficientes.

La identidad ELISE estará presente mediante:

- color;
- tipografía;
- spacing;
- motion;
- microinteractions;
- iconografía;
- Orb/branding;
- estados.

La usabilidad tiene prioridad sobre la estética cinematográfica.

---

# 17. Data Visualization

Los gráficos deben ser:

- claros;
- minimalistas;
- animados de forma sutil;
- fáciles de interpretar;
- consistentes entre dark/light.

Evitar por defecto:

- excesivas gridlines;
- 3D;
- decoración innecesaria;
- demasiados colores;
- labels redundantes.

Los charts deben comunicar una pregunta concreta.

---

# 18. Iconography

La iconografía principal utilizará line icons consistentes.

Dirección inicial:

- Lucide;
- stroke fino/moderado;
- tamaños consistentes;
- uso funcional.

Evitar utilizar emojis como iconos centrales del producto.

Los emojis pueden seguir apareciendo dentro de contenido generado o creado por usuarios cuando tenga sentido.

---

# 19. Shapes and Geometry

La interfaz combinará:

- geometría moderna;
- radios moderados;
- detalles técnicos;
- elementos circulares/orgánicos en el Orb.

Cards y formularios:

- modernos;
- suavemente redondeados.

Detalles de sistema/HUD:

- pueden introducir esquinas técnicas;
- líneas;
- brackets;
- segmentos.

Debe evitarse tanto:

- una terminal militar agresiva;
- como una estética SaaS completamente genérica.

---

# 20. Sound Design

El sistema de diseño deberá contemplar sound design futuro.

Posibles eventos:

- start listening;
- stop listening;
- confirmation;
- action completed;
- warning;
- error;
- notification;
- approval requested.

Los sonidos deben ser:

- sutiles;
- modernos;
- breves;
- configurables;
- completamente desactivables.

No son requisito para cerrar la primera implementación visual.

---

# 21. Onboarding Visual Experience

El onboarding debe ser uno de los momentos visuales más importantes de ELISE.

Puede tener una presentación más cinematográfica que las vistas administrativas normales.

Ideas:

- Orb aparece progresivamente;
- capabilities se conectan visualmente al core;
- conexiones exitosas generan feedback energético;
- el Morning Brief se configura como una extensión de la inteligencia;
- pequeños movimientos explican relaciones entre sistemas.

La experiencia debe seguir siendo rápida.

Nunca introducir animaciones largas obligatorias.

---

# 22. Mobile

Mobile debe adaptar la identidad sin intentar comprimir el layout desktop.

Dirección:

```text
Top / minimal state

        ELISE Orb

Conversation

Conversation

Conversation

[ Ask ELISE...   Mic ]

Bottom Navigation
```

La navegación mobile podrá utilizar bottom navigation.

Prioridades:

- Chat;
- Voice;
- Briefs;
- Tasks;
- Approvals;
- Notifications.

Configuraciones avanzadas permanecen disponibles pero son secundarias.

---

# 23. Accessibility

La estética futurista nunca debe romper accesibilidad.

Requisitos:

- contraste adecuado;
- focus states visibles;
- soporte de teclado;
- no depender únicamente del color;
- labels accesibles;
- semantic HTML;
- estados de error comprensibles;
- targets táctiles adecuados;
- `prefers-reduced-motion`;
- posibilidad de reducir o desactivar animaciones intensas.

Cuando `prefers-reduced-motion` esté activo, el Orb y las transiciones deben mantener significado sin movimiento innecesario.

---

# 24. Visual Personalization

La personalización visual queda fuera del MVP inicial.

Posibles opciones futuras:

- accent color;
- Orb variants;
- intensity;
- background;
- animation level;
- sound profile.

Primero debe existir una identidad visual ELISE reconocible y consistente.

---

# 25. Responsive Philosophy

No diseñar desktop y luego “hacerlo responsive”.

Las pantallas clave deben pensarse para:

- desktop;
- tablet;
- mobile.

Las prioridades pueden cambiar según dispositivo.

Ejemplo:

```text
Desktop
Knowledge management → prominent

Mobile
Voice / quick actions → prominent
```

---

# 26. Loading States

Evitar spinners genéricos cuando exista información útil que comunicar.

Ejemplo:

```text
Preparing brief...

✓ Calendar
✓ Tasks
● Checking important email
○ Relevant news
```

Para operaciones simples, skeletons o loaders mínimos siguen siendo apropiados.

---

# 27. Background Work

Los procesos que continúan fuera de la interacción principal deben mostrar estados discretos.

Ejemplo:

```text
Knowledge
Google Drive

Indexing...
64%

You can keep using ELISE.
```

Al terminar:

```text
Google Drive
✓ Up to date
```

---

# 28. Success Feedback

Las acciones exitosas deben tener confirmación breve.

Ejemplo:

```text
✓ Event created
```

No abrir grandes modals para acciones rutinarias.

Las animaciones de éxito pueden utilizar energía/onda del Orb o pequeños highlights.

---

# 29. Error Feedback

Los errores deben ser:

- visibles;
- accionables;
- humanos.

Ejemplo:

```text
Google Calendar needs to be reconnected.

[ Reconnect ]
```

y no:

```text
OAuth refresh token rejected.
```

Información técnica puede existir detrás de:

```text
View details
```

cuando corresponda.

---

# 30. Approval States

Cuando ELISE espere una aprobación, la UI debe cambiar de manera clara.

Ejemplo:

```text
Waiting for your approval

Send email to:
client@example.com

[ Review ]
[ Approve ]
[ Reject ]
```

El Orb puede adoptar un estado visual específico de `Waiting`.

---

# 31. Conversation Components

Las respuestas de ELISE no deben limitarse a bubbles de texto.

El sistema visual debe soportar respuestas enriquecidas:

- text;
- lists;
- source citations;
- task cards;
- calendar cards;
- email previews;
- approval cards;
- finance summaries;
- charts;
- schedules;
- knowledge references;
- execution traces.

El chat debe funcionar como una superficie dinámica.

---

# 32. Cards Inside Conversation

Los componentes embebidos deben sentirse parte de la conversación.

Ejemplo:

```text
I found a time tomorrow.

┌──────────────────────────────┐
│ Client Meeting               │
│ Tuesday · 15:00–15:45        │
│ Firbot Calendar              │
│                              │
│ [ Create event ]             │
└──────────────────────────────┘
```

Esto reduce la necesidad de navegar hacia otra pantalla.

---

# 33. Design Tokens

Claude Design deberá proponer tokens para:

```text
colors
spacing
radius
shadows
glow
typography
motion duration
motion easing
borders
opacity
z-index
breakpoints
```

Estos tokens deberán implementarse de forma centralizada.

Evitar valores arbitrarios repetidos por componentes.

---

# 34. Motion Tokens

Debe existir una escala coherente.

Ejemplo conceptual:

```text
instant
fast
normal
slow
ambient
```

Y curvas de easing consistentes.

El movimiento ambiental del Orb puede ser continuo, mientras que las interacciones normales deben permanecer rápidas.

---

# 35. Design Exploration With Claude Design

No se le pedirá inicialmente a Claude Design que diseñe toda la aplicación.

Proceso recomendado:

## Phase 1 — Visual Directions

Generar al menos tres direcciones.

```text
Direction A
Clean JARVIS Minimal

Direction B
Organic Intelligence

Direction C
Technical Futurism
```

Todas deben respetar los principios del producto.

## Phase 2 — Selection

Comparar:

- legibilidad;
- personalidad;
- diferenciación;
- motion;
- escalabilidad a dashboards;
- dark/light;
- mobile.

Elegir una dirección o combinar elementos deliberadamente.

## Phase 3 — Design System

Definir:

- typography;
- palette;
- layout;
- components;
- Orb;
- motion;
- states.

## Phase 4 — Key Screens

Diseñar como mínimo:

- onboarding;
- Home / Chat;
- Knowledge;
- Connections;
- Schedules;
- My Elise;
- Finance;
- mobile Home;
- approval flow.

## Phase 5 — Interactive Prototype

Validar:

- navegación;
- chat;
- Orb;
- onboarding;
- responsive behavior;
- key transitions.

## Phase 6 — Claude Code Handoff

Solo entonces trasladar componentes y specs al repositorio.

---

# 36. Visual References

Las referencias iniciales del proyecto incluyen interfaces inspiradas en JARVIS:

- dark technical HUD;
- cyan energy;
- circular intelligent core;
- visible system state;
- floating information;
- futuristic minimalism.

Estas referencias deben utilizarse como **mood and interaction inspiration**, no como layouts que deban copiarse.

---

# 37. What Must Be Avoided

Claude Design y Claude Code deben evitar:

- cyberpunk neon overload;
- fake system metrics;
- meaningless CPU/RAM panels;
- decorative charts without user value;
- cyan borders around everything;
- excessive glassmorphism;
- tiny sci-fi text;
- constant particle noise;
- long cinematic intros;
- hidden standard actions;
- low contrast;
- interfaces that require desktop-only precision;
- copying copyrighted JARVIS layouts or assets.

---

# 38. First Impression Goal

Aunque todavía se deberá validar mediante prototipos, la primera impresión buscada es:

> **ELISE should feel intelligent, minimal, innovative and alive.**

El usuario debe percibir inmediatamente que no está frente a un chatbot convencional.

Sin embargo, después del impacto inicial debe poder entender rápidamente qué hacer.

---

# 39. Design Quality Bar

Una pantalla de ELISE debería superar estas preguntas:

1. ¿Sé inmediatamente qué puedo hacer?
2. ¿La jerarquía está clara?
3. ¿Hay información decorativa que podría eliminarse?
4. ¿El motion comunica algo?
5. ¿Funciona en dark y light?
6. ¿La pantalla sigue siendo útil sin animación?
7. ¿Parece parte de la misma ELISE?
8. ¿Se siente moderna sin ser confusa?
9. ¿Podría usarla todos los días sin cansarme?
10. ¿El componente funciona correctamente en mobile?

---

# 40. North Star

> **ELISE debe sentirse como una inteligencia viva, no como un dashboard futurista.**
>
> El Orb expresa presencia.
>
> El motion expresa estado.
>
> El cyan expresa energía.
>
> La interfaz expresa control.
>
> Y la simplicidad mantiene todo usable.
