# ADR-064: Modular Mi ELISE

**Status:** Accepted (2026-10-15).

## Context

Mi ELISE (Tareas, Hábitos, Listas, Objetivos, Notas, Finanzas, Atajos) was a fixed menu. Not
everyone uses every module, and more native modules are coming (Time, Health, Study, …). The
list was hardcoded in navigation, and every module was always in ELISE's tools and context.

## Decision

- **One registry.** `src/core/modules/registry.ts` (`NATIVE_MODULES`) is the only place a native
  module is declared:
  - key, capability, route and order;
  - `available`, `defaultForExistingUsers`, `defaultForNewUsers`;
  - `suggested` (preselected in onboarding);
  - the Morning Brief blocks it feeds, and search words.
  - Names and descriptions live in the i18n dictionaries, typed by module key.
- **Module ≠ capability ≠ provider.** A module is ELISE's own product area. Turning it off never
  touches providers, bindings or connections: Google Tasks stays connected while Tareas is off.
- **One preference.** Table `user_module_preferences` (migration 047): one row per workspace,
  user and module, under RLS (own rows, member of the workspace). `application/modules-service.ts`
  is the only reader and writer. The effective state:
  - an unavailable module is off;
  - a saved row wins;
  - a person with no rows at all never chose: `defaultForNewUsers`;
  - otherwise (existing person, module added later): `defaultForExistingUsers`.
- **Existing users keep everything.** The migration backfills the six modules on for every active
  workspace member. Idempotent (`on conflict do nothing`).
- **Disabling never deletes.** Data, history, Knowledge and Recall are untouched. Old History
  surfaces keep rendering.
- **Where it is enforced:**
  - **Navigation:** the Mi ELISE menu lists enabled modules only, in order. With none: "Todavía
    no activaste módulos" + "Elegir módulos".
  - **Routes:** each `/my-elise/<module>` layout wraps the page in `NativeModuleGuard`. When off:
    a calm screen with Activar / Volver, no 404.
  - **Chat:** a disabled module's capability leaves the turn's capability set (its tools are not
    offered). The context builder names the inactive modules.
  - **Executor:** refuses a disabled module's tools (`CAPABILITY_UNAVAILABLE`, `reason:
    module_disabled`). The message tells the model to offer activation.
  - **Orchestrations** (`planning.today`, `meeting.prepare`, `work.brief`): a module that is off is
    skipped quietly, never reported as an unavailable source.
  - **Morning Brief:** skips the module's blocks with `{ reason: "module_disabled" }`. No warning;
    the block returns when the module is turned on again.
  - **Home:** only shows signals from enabled modules (tasks).
- **Self-control tools.** `modules.list`, `modules.enable` and `modules.disable` are typed and
  audited (`module.enabled` / `module.disabled`). ELISE uses them only on a clear request or a
  clear yes to its offer, never silently. "No uso mucho finanzas" is not a request.
- **Where people choose:**
  - **Connections → Mi ELISE:** at the top, above external connections, replacing "Integrado en
    ELISE". Searchable by name, description and everyday words.
  - **Onboarding:** a new step "¿Para qué te gustaría usar ELISE?" writes the same preference.
    Tareas, Listas and Notas are suggested; continuing with none is fine.
- **Atajos is not a module.** It moved to Settings (`/settings/shortcuts`). The old route
  redirects permanently.

## Adding a module

1. Add an entry to `NATIVE_MODULES`, with its defaults.
2. Add names, descriptions and intents to both dictionaries (the types require them).
3. Add an icon to `MY_ELISE_ICONS`.
4. Add `app/(app)/my-elise/<key>/layout.tsx` with `NativeModuleGuard`.

No migration is needed: absence of a row means "use the default".

## Consequences

- **Old code:** brief blocks and chat tools of a disabled module are not loaded, so prompts get
  smaller. Code that bypasses the executor (direct service calls from pages) is guarded at the
  route.
- **Before migration 047 is applied:** reads fall back to defaults (everything on) and saving
  answers "needs the latest database update".
- **Scope:** per user and workspace. Workspace-level policies or plans can later set `available`
  without changing the preference model.
