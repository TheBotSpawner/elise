# ELISE — Product Principles

**Document:** `01-product-principles.md`  
**Status:** Draft v1  
**Purpose:** Definir los principios de producto y arquitectura que deben guiar las decisiones de ELISE a medida que evoluciona. Estos principios no describen features específicas; funcionan como criterios permanentes para evitar complejidad innecesaria, mantener coherencia y proteger la experiencia del usuario.

---

## 1. Simplicity First

ELISE es un producto complejo por naturaleza.

Conecta múltiples herramientas, fuentes de conocimiento, reglas, rutinas, agentes, permisos y capacidades. Por eso, la simplicidad debe ser una prioridad explícita.

La complejidad interna no debe trasladarse al usuario.

ELISE debe:

- utilizar lenguaje simple;
- ocultar detalles técnicos cuando no sean necesarios;
- presentar decisiones complejas como opciones claras;
- evitar términos como MCP, webhook, OAuth scope, vector store o runtime en la experiencia normal;
- mostrar opciones avanzadas solamente cuando el usuario las necesite;
- reducir al mínimo la cantidad de configuración requerida para comenzar.

El objetivo es que una persona pueda usar ELISE sin entender cómo funciona por detrás.

---

## 2. Smart Defaults

ELISE debe intentar funcionar correctamente antes de exigir configuración.

Cuando exista una opción razonable, debe proponerla automáticamente.

Ejemplos:

- detectar el calendario principal;
- sugerir qué cuenta utilizar;
- proponer mappings para una base de Notion;
- detectar columnas relevantes en una planilla;
- inferir categorías iniciales;
- sugerir reglas;
- proponer una estructura de conocimiento;
- elegir configuraciones seguras por defecto.

El usuario siempre debe poder revisar o corregir estas decisiones.

La filosofía es:

> **Configure less. Correct when necessary.**

---

## 3. User Control Is Non-Negotiable

El usuario siempre debe mantener control sobre lo que ELISE puede ver y hacer.

Toda conexión, permiso, rutina o automatización debe poder:

- inspeccionarse;
- pausarse;
- modificarse;
- revocarse;
- eliminarse.

Las acciones autónomas nunca deben ser irreversibles desde la perspectiva del usuario sin una justificación clara y un nivel de autorización apropiado.

ELISE puede ser proactiva, pero el usuario sigue siendo la autoridad final.

---

## 4. Proactive, Not Noisy

La proactividad es parte central de ELISE.

Pero ELISE no debe transformarse en otra fuente de notificaciones.

El sistema debe priorizar:

- relevancia;
- urgencia;
- contexto;
- impacto;
- preferencias del usuario.

Cuando no haya nada importante que comunicar, el silencio es una respuesta válida.

ELISE debe aprender a diferenciar entre:

- información que merece una interrupción inmediata;
- información que puede esperar al próximo brief;
- información que solo debe almacenarse;
- información que no requiere ninguna acción.

> **Silence is a feature.**

---

## 5. Risk-Based Autonomy

El nivel de autonomía debe depender del impacto de la acción.

Cuanto más sensible, irreversible o costosa sea una acción, mayor debe ser el nivel de confirmación requerido.

Ejemplos conceptuales:

| Acción | Comportamiento esperado |
|---|---|
| Leer información | Automático |
| Buscar documentos | Automático |
| Crear un draft | Automático |
| Crear una sugerencia | Automático |
| Crear una tarea | Configurable |
| Modificar calendario | Según permisos |
| Enviar un email | Confirmación o regla explícita |
| Borrar información | Confirmación |
| Realizar una acción financiera | Confirmación reforzada |

Las políticas concretas se definirán en documentos posteriores, pero el principio general es:

> **Autonomy increases only when trust and permission increase.**

---

## 6. AI for Interpretation, Code for Reliability

No todo problema debe resolverse con un modelo de IA.

ELISE debe utilizar IA cuando se necesite:

- interpretar intención;
- clasificar;
- resumir;
- decidir entre alternativas;
- adaptar respuestas;
- extraer estructura de información desordenada;
- razonar sobre contexto.

Debe utilizar lógica determinística cuando se necesite:

- precisión;
- consistencia;
- cálculos exactos;
- validaciones;
- permisos;
- reglas de seguridad;
- transformación de datos conocida;
- operaciones transaccionales.

El objetivo es evitar que funcionalidades críticas dependan exclusivamente de prompts cuando pueden resolverse de manera confiable con software tradicional.

---

## 7. Capabilities Before Providers

ELISE debe pensar en capacidades, no en aplicaciones específicas.

Ejemplos:

```text
Email
Calendar
Tasks
Knowledge
Finance
Messaging
CRM
Voice
```

No:

```text
Gmail
Google Calendar
Todoist
Notion
ElevenLabs
```

Las aplicaciones externas son providers intercambiables que implementan capacidades.

Esto permite que distintos usuarios utilicen stacks diferentes sin cambiar el funcionamiento conceptual de ELISE.

Por ejemplo:

```text
Email
├── Gmail
└── Outlook
```

o:

```text
Finance
├── Elise Native
├── Google Sheets
├── Excel
└── Future Providers
```

Ningún proveedor externo debe convertirse en una dependencia conceptual obligatoria del producto.

---

## 8. ELISE Native as an Official Alternative

ELISE deberá ofrecer implementaciones nativas para determinadas capacidades donde tenga sentido.

Esto no busca reemplazar todas las herramientas especializadas del mercado.

ELISE Native existe para:

- permitir que el usuario empiece sin conectar aplicaciones externas;
- ofrecer una experiencia integrada;
- simplificar casos de uso básicos;
- reducir dependencias;
- servir como alternativa cuando el usuario no tiene una herramienta previa;
- facilitar una experiencia coherente entre capacidades.

Áreas candidatas incluyen:

- Tasks;
- Habits;
- Lists;
- Finance;
- Goals;
- Notes;
- otras capacidades personales o estructuradas.

Para founders y empresas que ya utilizan herramientas externas, ELISE Native debe coexistir como alternativa, no como obligación.

---

## 9. Migration Into ELISE Native Should Be Easy

Siempre que una capacidad ELISE Native pueda reemplazar una herramienta previa, la migración debe ser sencilla.

ELISE debería permitir importar información desde fuentes como:

- Excel;
- CSV;
- Google Sheets;
- exportaciones de otras plataformas;
- archivos estructurados;
- otras fuentes compatibles.

Cuando la estructura no coincida exactamente con el modelo de ELISE, la IA puede ayudar a:

- detectar columnas;
- identificar entidades;
- mapear campos;
- normalizar categorías;
- proponer transformaciones;
- detectar inconsistencias;
- mostrar una preview antes de importar.

El usuario debe confirmar el mapping antes de ejecutar una migración importante.

La migración asistida por IA debe reducir el costo de cambiar de herramienta sin comprometer la integridad de los datos.

---

## 10. External Sources Remain the Source of Truth

Cuando un usuario conecta una herramienta externa, esa herramienta continúa siendo la fuente principal de verdad salvo que el usuario migre explícitamente los datos a ELISE Native.

Por ejemplo:

```text
Notion
→ source of truth

ELISE
→ index, normalize, query, reason
```

ELISE puede almacenar:

- metadata;
- índices;
- representaciones normalizadas;
- embeddings;
- referencias;
- caches;
- estados derivados.

Pero no debe crear silenciosamente una segunda versión independiente que pueda divergir de la fuente original.

Si el usuario decide migrar información a ELISE Native, ese cambio debe ser explícito.

---

## 11. Transparency Without Clutter

ELISE debe poder explicar de dónde obtuvo información y qué acciones realizó.

Ejemplos:

```text
Source:
Notion → Acme → Best Practices
```

```text
Actions:
✓ Checked Gmail
✓ Reviewed Calendar
✓ Queried Tasks
```

Esta información no debe saturar la interfaz principal.

Debe aparecer cuando:

- aumenta la confianza;
- la fuente es relevante;
- hubo una acción importante;
- el usuario quiere inspeccionar el proceso;
- existe incertidumbre;
- ocurrió un error.

La experiencia debe ser simple por defecto y auditable cuando sea necesario.

---

## 12. Correctness Scales With Risk

No todas las interacciones necesitan el mismo nivel de verificación.

Para preguntas de bajo riesgo puede priorizarse velocidad.

Para datos importantes o acciones sensibles deben priorizarse:

- validación;
- contexto correcto;
- fuentes actualizadas;
- confirmación;
- consistencia.

ELISE debe adaptar su nivel de cautela al impacto potencial del error.

> **Fast when safe. Careful when it matters.**

---

## 13. Confidence-Aware Behavior

ELISE debe actuar automáticamente cuando existe suficiente confianza.

Cuando una suposición pueda generar consecuencias incorrectas, debe preguntar.

Ejemplo:

Si el usuario dice:

> "Respondé a Alex."

y existe una única conversación claramente identificada, ELISE puede proceder dentro de los permisos configurados.

Si existen múltiples cuentas, personas o contextos posibles, puede preguntar:

> "¿Querés responder desde tu cuenta de Acme o desde la personal?"

La interacción ideal minimiza preguntas innecesarias sin inventar certezas.

---

## 14. Privacy by Design

Los datos del usuario pertenecen al usuario.

La arquitectura de ELISE debe asumir desde el comienzo que:

- los datos son privados;
- cada usuario accede solamente a su información;
- cada workspace está aislado;
- los permisos deben ser explícitos;
- solo debe accederse a los datos necesarios para una capacidad;
- las conexiones pueden revocarse;
- los datos deben poder eliminarse;
- los datos deben poder exportarse cuando sea razonable.

La privacidad no debe agregarse al final del proyecto.

Debe formar parte del modelo de producto.

---

## 15. Dynamic and Extensible by Default

ELISE debe poder crecer sin convertir cada nuevo feature en un caso especial.

Cuando tenga sentido, las nuevas funcionalidades deben modelarse como piezas reutilizables:

```text
Capability
Provider
Skill
Routine
Rule
Native Module
Tool
```

El producto debe favorecer patrones extensibles en lugar de lógica hardcodeada para usuarios o integraciones específicas.

Sin embargo, la abstracción no debe frenar innecesariamente el MVP.

La regla es:

> **Abstract where repetition or future variability is real, not where it is hypothetical.**

---

## 16. Opinionated by Default, Configurable by Choice

ELISE no debe ser una plataforma vacía que obligue al usuario a diseñar su propio asistente desde cero.

Debe ofrecer:

- una experiencia recomendada;
- configuraciones iniciales coherentes;
- reglas seguras;
- rutinas sugeridas;
- buenos defaults;
- una estructura clara.

Luego, los usuarios que lo necesiten podrán profundizar la personalización.

Esto permite combinar:

```text
Simple for beginners
+
Powerful for advanced users
```

La configuración avanzada debe ser una posibilidad, no un requisito.

---

## 17. One Intelligence, Many Systems

Aunque internamente ELISE utilice múltiples modelos, agentes, tools, providers y motores de ejecución, la experiencia del usuario debe mantenerse unificada.

El usuario interactúa con:

> **ELISE**

No con una colección de agentes independientes.

La orquestación debe permanecer detrás del producto.

---

## 18. External Tools Are Replaceable Components

ELISE podrá utilizar tecnologías externas como:

- modelos de IA;
- proveedores de voz;
- bases de datos;
- runtimes de background execution;
- servicios de almacenamiento;
- APIs;
- integraciones.

Estas tecnologías pueden ser esenciales para una implementación concreta, pero no deben definir la identidad del producto.

Siempre que sea razonable, la lógica central debe permanecer desacoplada detrás de interfaces o adapters.

Esto permite cambiar proveedores sin reconstruir ELISE.

---

## 19. Trust Must Be Earned

ELISE manejará información sensible y eventualmente ejecutará acciones importantes.

Por eso, la confianza no debe suponerse.

Debe construirse mediante:

- comportamiento predecible;
- permisos claros;
- confirmaciones apropiadas;
- trazabilidad;
- resultados consistentes;
- explicaciones cuando sean necesarias;
- capacidad de revertir o cancelar acciones;
- historial de ejecución.

Cuanto más confiable sea ELISE, más autonomía podrá concederle el usuario.

---

## 20. Product Principle Summary

Las decisiones futuras de producto y arquitectura deberían poder evaluarse contra estas preguntas:

1. ¿Esto hace ELISE más simple o más difícil de entender?
2. ¿Existe un smart default razonable?
3. ¿El usuario mantiene control?
4. ¿Estamos siendo proactivos sin generar ruido?
5. ¿El nivel de autonomía coincide con el riesgo?
6. ¿Estamos usando IA donde aporta valor y código donde necesitamos fiabilidad?
7. ¿Estamos diseñando una capability o acoplándonos a un provider?
8. ¿ELISE Native aporta valor real?
9. ¿La fuente de verdad está clara?
10. ¿El usuario puede entender de dónde salió la información?
11. ¿El nivel de verificación coincide con el impacto?
12. ¿Estamos actuando con suficiente confianza?
13. ¿Los datos siguen siendo privados y controlables?
14. ¿La solución puede extenderse sin hardcodear casos particulares?
15. ¿Estamos ofreciendo buenos defaults sin eliminar flexibilidad?
16. ¿La experiencia sigue sintiéndose como una sola inteligencia?

---

## North Star Principle

> **ELISE debe ocultar complejidad, no crearla.**
>
> Una sola inteligencia debe poder comprender, coordinar y actuar sobre un ecosistema digital cada vez más complejo sin obligar al usuario a convertirse en experto en ese ecosistema.
