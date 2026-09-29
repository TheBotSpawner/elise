# ADR-002 — Application layer, tenancy bootstrap and ELISE Native as a connection

**Status:** Accepted (2026-09-29)

## Context

`06-system-architecture.md` defines an application layer (`askElise()`, `createTask()`…) but the
repository map has no folder for it. `16-data-model.md` requires workspace ownership from day
one, a personal workspace per user, and bindings that always point to a connection.

## Decision

1. **`src/application/`** holds application services: they resolve the authenticated user and
   workspace (`auth-context.ts`), wire Core ports to infrastructure (`elise.ts`) and implement
   use cases (`chat-service.ts`, `tasks-service.ts`, `approvals-service.ts`). Features and route
   handlers call these; they never touch provider adapters directly.
2. **Tenancy bootstrap lives in the database** (`handle_new_user` trigger on `auth.users`): every
   sign-up method (password, magic link, Google) gets a profile, a personal workspace and an
   owner membership exactly once, atomically. This is provisioning, not business logic.
3. **ELISE Native is a connection.** Each workspace gets one built-in `elise_native` connection
   and default bindings for implemented native capabilities (today: Tasks), created by the
   `on_workspace_created` trigger. The resolver, policy and UI treat it exactly like an external
   account — no `if native` branches.
4. Catalog tables (`capability_definitions`, `provider_definitions`) use stable text keys as
   primary keys (`tasks`, `google`) instead of UUIDs; they mirror the code registries and a test
   asserts both stay equal.

## Consequences

- When a new native capability ships, its migration must add bindings for existing workspaces
  and extend `provision_native_connection()`.
- Team workspaces later only need membership changes; ownership columns already exist.
