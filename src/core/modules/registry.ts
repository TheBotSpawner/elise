import type { CapabilityKey } from "../capabilities/types";

/**
 * Mi ELISE (ADR-064): the native modules a person chooses to use. This is the one place a native
 * module is declared; navigation, Connections, onboarding, route guards, tool/context gating,
 * the Morning Brief and search all derive from it. The database only stores each user's choice.
 *
 * A module is product experience, not a provider: turning Tasks off hides Mi ELISE → Tareas and
 * stops ELISE from using tasks on its own, but never touches ELISE Tasks or Google Tasks data,
 * bindings or connections.
 */

export interface NativeModuleDefinition {
  key: string;
  /** The capability whose tools and context the module gates (canonical, provider-independent). */
  capability: CapabilityKey;
  /** Its pages: everything under this path is behind the module guard. */
  route: string;
  /** Position in Mi ELISE (navigation, Connections, onboarding). */
  order: number;
  /** Exists in this version (a future plan or rollout can turn this off). */
  available: boolean;
  /** For people who used ELISE before this module existed. */
  defaultForExistingUsers: boolean;
  /** For people who never chose (e.g. skipped onboarding). */
  defaultForNewUsers: boolean;
  /** Preselected in onboarding's "¿Para qué querés usar ELISE?" (a suggestion, never forced). */
  suggested: boolean;
  /** Morning Brief blocks that read this module (skipped while it is off). */
  briefBlocks: readonly string[];
  /** Everyday words people search for, both languages (Connections search). */
  searchTerms: readonly string[];
}

export const NATIVE_MODULES = [
  {
    key: "tasks",
    capability: "tasks",
    route: "/my-elise/tasks",
    order: 10,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    briefBlocks: ["tasks"],
    searchTerms: ["tareas", "pendientes", "to do", "todo", "tasks", "google tasks"],
  },
  {
    key: "habits",
    capability: "habits",
    route: "/my-elise/habits",
    order: 20,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: false,
    briefBlocks: ["habits"],
    searchTerms: ["habitos", "rutinas", "rachas", "habits", "routines", "streaks"],
  },
  {
    key: "lists",
    capability: "lists",
    route: "/my-elise/lists",
    order: 30,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    briefBlocks: [],
    searchTerms: ["listas", "compras", "checklist", "lists", "shopping"],
  },
  {
    key: "goals",
    capability: "goals",
    route: "/my-elise/goals",
    order: 40,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: false,
    briefBlocks: ["goals"],
    searchTerms: ["objetivos", "metas", "visiones", "goals", "visions"],
  },
  {
    key: "notes",
    capability: "notes",
    route: "/my-elise/notes",
    order: 50,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    briefBlocks: [],
    searchTerms: ["notas", "apuntes", "notes"],
  },
  {
    key: "finance",
    capability: "finance",
    route: "/my-elise/finance",
    order: 60,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: false,
    briefBlocks: ["finance"],
    searchTerms: [
      "finanzas",
      "gastos",
      "ingresos",
      "presupuestos",
      "plata",
      "finance",
      "budget",
      "expenses",
    ],
  },
] as const satisfies readonly NativeModuleDefinition[];

export type NativeModuleKey = (typeof NATIVE_MODULES)[number]["key"];
export type ModuleStates = Record<NativeModuleKey, boolean>;

const BY_KEY = new Map<string, NativeModuleDefinition>(NATIVE_MODULES.map((m) => [m.key, m]));

export function isModuleKey(value: string): value is NativeModuleKey {
  return BY_KEY.has(value);
}

export function moduleDefinition(key: NativeModuleKey): NativeModuleDefinition {
  return BY_KEY.get(key)!;
}

/** The modules this version offers, in Mi ELISE order. */
export function availableModules(): NativeModuleDefinition[] {
  return [...NATIVE_MODULES]
    .filter((m) => m.available)
    .sort((a, b) => a.order - b.order) as NativeModuleDefinition[];
}

/**
 * The effective state of every module, from the rows a person saved. The one rule:
 * - unavailable → off;
 * - a saved choice wins;
 * - no choice for this module: someone who never chose anything (no rows at all) gets the
 *   new-user default; someone who chose before this module existed gets the existing-user default.
 * Existing accounts were given explicit rows when Mi ELISE became modular (migration 047), so a
 * module added later follows `defaultForExistingUsers` for them without another backfill.
 */
export function effectiveModules(
  saved: readonly { module_key: string; enabled: boolean }[],
): ModuleStates {
  const choice = new Map(
    saved.filter((r) => isModuleKey(r.module_key)).map((r) => [r.module_key, r.enabled]),
  );
  const neverChose = saved.length === 0;
  const out = {} as ModuleStates;
  for (const m of NATIVE_MODULES) {
    out[m.key] = !m.available
      ? false
      : (choice.get(m.key) ?? (neverChose ? m.defaultForNewUsers : m.defaultForExistingUsers));
  }
  return out;
}

export const enabledModuleKeys = (states: ModuleStates): NativeModuleKey[] =>
  availableModules()
    .map((m) => m.key as NativeModuleKey)
    .filter((k) => states[k]);

/** The module a capability belongs to (null: not a Mi ELISE capability — never gated). */
export function moduleOfCapability(capability: string): NativeModuleKey | null {
  return NATIVE_MODULES.find((m) => m.capability === capability)?.key ?? null;
}

/** Capabilities ELISE must not use on its own right now (their modules are off). */
export function disabledCapabilities(states: ModuleStates): Set<CapabilityKey> {
  return new Set(NATIVE_MODULES.filter((m) => !states[m.key]).map((m) => m.capability));
}

/** The module whose pages a path belongs to ("/my-elise/finance/reports" → finance). */
export function moduleOfPath(pathname: string): NativeModuleKey | null {
  return (
    NATIVE_MODULES.find((m) => pathname === m.route || pathname.startsWith(`${m.route}/`))?.key ??
    null
  );
}

/** The module a Morning Brief block reads, if any. */
export function moduleOfBriefBlock(block: string): NativeModuleKey | null {
  return (
    NATIVE_MODULES.find((m) => (m.briefBlocks as readonly string[]).includes(block))?.key ?? null
  );
}
