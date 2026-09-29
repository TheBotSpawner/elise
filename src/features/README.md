# features

User-facing experiences (chat, onboarding, connections, knowledge, routines, native).

A feature composes UI + `src/core` + `src/infrastructure` through clear boundaries. Do not mix UI, DB queries, external SDKs and business logic in a single file. Business rules belong in `src/core`.
