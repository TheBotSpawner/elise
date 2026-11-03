# ELISE documentation

These documents are the source of truth for product and architecture decisions. They are written one by one, and a file listed here that does not exist yet has not been written.

## product/

| Doc                        | Topic              |
| -------------------------- | ------------------ |
| `00-product-vision.md`     | Product vision     |
| `01-product-principles.md` | Product principles |
| `02-mvp-scope.md`          | MVP scope          |
| `03-use-case-catalog.md`   | Use case catalog   |
| `04-user-experience.md`    | User experience    |
| `05-ui-design-system.md`   | UI design system   |

## architecture/

| Doc                                  | Topic                             |
| ------------------------------------ | --------------------------------- |
| `06-system-architecture.md`          | System architecture               |
| `07-capability-provider-model.md`    | Capability / provider model       |
| `08-connections-auth-permissions.md` | Connections, auth and permissions |
| `09-knowledge-system.md`             | Knowledge system                  |
| `10-native-structured-data.md`       | Native structured data            |
| `11-memory-entities-context.md`      | Memory, entities and context      |
| `12-agent-runtime.md`                | Agent runtime                     |
| `13-rules-routines.md`               | Rules and routines                |
| `14-background-execution.md`         | Background execution              |
| `15-tools-actions-approvals.md`      | Tools, actions and approvals      |
| `16-data-model.md`                   | Data model                        |

## engineering/

| Doc                                | Topic                           |
| ---------------------------------- | ------------------------------- |
| `17-security-multitenancy.md`      | Security and multi-tenancy      |
| `18-observability-errors-audit.md` | Observability, errors and audit |
| `19-engineering-standards.md`      | Engineering standards           |
| `20-testing-acceptance.md`         | Testing and acceptance          |
| `22-mvp-readiness.md`              | MVP readiness: deploy, QA, gaps |
| `23-music-setup.md`                | Music providers setup (ADR-042) |
| `24-microsoft-setup.md`            | Microsoft / Outlook setup (ADR-058) |
| `25-slack-setup.md`                | Slack setup and app manifest (ADR-062) |
| `26-elise-home-hub-dev.md`         | ELISE Home Hub development (ADR-079/080) |
| `27-elise-desktop.md`              | ELISE Desktop: develop, release, operate (ADR-081) |
| `28-voice-quality-2026-10.md`      | Voice quality and Desktop parity report (ADR-104) |
| `ELISE_Memory_Audit_vs_Honcho_Report.md` | Memory audit vs Honcho (2026-10, before ADR-107) |
| `30-native-memory-implementation.md` | Native continuous memory: implementation report (ADR-107) |
| `31-desktop-wake-and-audio.md` | Desktop wake word at a distance, speech beeps, interrupting with "ELISE" (ADR-108/109) |
| `32-broadlink-ir.md` | Broadlink infrared: controllers, learning buttons, TV/AC control, testing without hardware, first-day guide (ADR-110) |
| `33-supermarket-prices.md` | Supermarket prices from SEPA: providers assessed, ingestion, honest basket math, costs, manual steps (ADR-111) |
| `34-mercadolibre-shopping.md` | Mercado Libre first for products to buy: official API feasibility, web-search fallback, honest offers, setup (ADR-112) |
| `35-transit-routes.md` | Public transport with lines: Routes API transit details, itineraries, voice and card, live checks (ADR-113) |
| `36-notion-recurring-widgets.md` | Notion retrieval and "latest published", honest not-found, source management, one-answer widgets, recurring tasks (ADR-114/115) |
| `37-mercadolibre-official-prices.md` | Mercado Libre official prices by exact listing, OAuth for ELISE's account, SerpApi removed, article cards, newest-first Canvas, voice language (ADR-116) |
| ADR-117 | Broadlink found by Desktop (local hello; the engine in WSL2 only sees DHCP), published IR profiles (SmartIR) before learning |
| ADR-118 | Smart Life / Tuya: remotes already set up in Smart Life imported as ready devices, sent through Tuya's cloud (dev-linked account; consumer OAuth blocked), off by default |
| ADR-119 | Smart Life / Tuya multiusuario: cada persona conecta SU cuenta por el OAuth oficial de Tuya (H5, su centro de datos), tokens cifrados por conexión, dispositivos de nube sin hub (migración 067), aislamiento por workspace |
| ADR-120 | Imágenes reales con créditos: Wikimedia Commons (gratis), fotos de Places opcionales (pago, apagado), una galería por sujeto, web.images |
| ADR-121 | OCR sin claves: Workload Identity Federation desde Vercel (OIDC) y broker de tokens de 1 h para los jobs de Trigger.dev |
| ADR-122 | Descripciones de documentos, búsqueda por nombre/descripción y sin acentos, y bancos de preguntas en Estudio (preguntas textuales, nunca inventadas) |
| ADR-123 | Lecturas rápidas: preguntas simples de Mi ELISE (alarmas, timers) se responden sin el modelo; "hoy" incluye alarmas que ya sonaron |
| ADR-124 | Widget de Modo Estudio: registro de preguntas con su estado (bien/mal/sin responder) editable, navegación entre preguntas, "Modo Estudio" al entrar, evaluar = Modo Estudio, índice de Métodos solo con Métodos relacionados |
| ADR-125 | Conversación continua que se siente conversación: menos rellenos, escucha durante la búsqueda (interrumpible), calibración de interrupción por mediana, reposo a los 8 s, ELISE explica el modo |
| ADR-126 | Barra de progreso para objetivos que la conversación recorre paso a paso (ui.progress), solo cuando ELISE la ve útil |
| ADR-127 | Sin duplicados accidentales (alarma, timer, tarea: pregunta antes), interrumpir requiere voz real y sin bucle de reenvío, la charla no vacía el lienzo, el teclado se cierra tocando afuera |
| ADR-128 | Smart Life: vínculo de prueba solo para el workspace del dueño (cuenta vinculada en la consola, token del proyecto), estado real para clientes (OAuth no habilitado), uid nunca al navegador; Agregar dispositivos separa «en esta red ahora» de «encontrados anteriormente» (plegado), búsqueda con estados, descarta respuestas viejas, identidad por unique_id |
| ADR-129 | Smart Life para cada usuario: BLOQUEADO por Tuya (OAuth solo para apps OEM; QR solo desde la consola; Device Data Sharing solo UE; la vía de Home Assistant no trae controles IR). ADR-119 queda inactivo; el vínculo de prueba sigue solo para el dueño; consulta a Tuya pendiente |
| ADR-130 | Palabra de activación: todo candidato se transcribe antes de iniciar nada, también la palabra sola; una transcripción vacía no es un llamado y activa el modo guardado |
| ADR-131 | Voz: ELISE escucha hasta 2 s de silencio, en la sesión y en la captura de "Elise", sea cual sea la frase (2,4 s si suena sin terminar); la captura sube de 9 s a 20 s. Las respuestas arrancan hasta 1,3 s más tarde |
| ADR-133 | Recomendar lugares: "dónde comer" va a Maps, no a la web; una sola búsqueda trae precio, horarios, cierre y reseñas; ELISE suma cómo llegar. Pendiente revisar los términos de Google y el costo |
| ADR-132 | Búsquedas por parecido: palabras en cualquier orden, plurales, errores y sonido; exacto, luego parcial, luego parecido, y si hay empate ELISE pregunta. Tareas, listas, finanzas, Espacios, Métodos e Historial |

## roadmap/

| Doc                        | Topic              |
| -------------------------- | ------------------ |
| `21-capability-roadmap.md` | Capability roadmap |

## performance/

| Doc         | Topic                                                    |
| ----------- | -------------------------------------------------------- |
| `README.md` | Measured latency, AI profiles, cost and quality (ADR-025) |

## decisions/

Architecture Decision Records. See [decisions/README.md](decisions/README.md).
