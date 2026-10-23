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
