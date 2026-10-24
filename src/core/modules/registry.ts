import type { CapabilityKey } from "../capabilities/types";

/**
 * Mi ELISE (ADR-064, ADR-070): the native modules. This is the one place a native module is
 * declared; navigation (desktop and phone), Connections, onboarding and search derive from it.
 *
 * Three separate things (ADR-070):
 * - module data — the person's goals, tasks… never touched by any of this;
 * - module capability — ELISE's tools for it, always available;
 * - module visibility — whether it shows in Mi ELISE. The only thing the person's choice
 *   ("Conexiones › Mi ELISE", onboarding, "mostrá / ocultá Objetivos") changes.
 * Hiding a module is UX, never revocation: data, tools, the Morning Brief and its pages stay.
 */

export interface NativeModuleDefinition {
  key: string;
  /** The capability its data belongs to (canonical, provider-independent). Never gated. */
  capability: CapabilityKey;
  /** Its pages. They keep working when the module is hidden (bookmarks, links from ELISE). */
  route: string;
  /** Position in Mi ELISE (navigation, Connections, onboarding). */
  order: number;
  /** Exists in this version (a future rollout can leave it out entirely). */
  available: boolean;
  /** Shown for people who chose before this module existed. */
  defaultForExistingUsers: boolean;
  /** Shown for people who never chose (e.g. skipped onboarding). */
  defaultForNewUsers: boolean;
  /** Preselected in onboarding's "¿Para qué querés usar ELISE?" (a suggestion, never forced). */
  suggested: boolean;
  /** Everyday words people search for, both languages (Connections search). */
  searchTerms: readonly string[];
}

export const NATIVE_MODULES = [
  {
    key: "tasks",
    capability: "tasks",
    route: "/my-elise/tasks",
    order: 30,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    searchTerms: ["tareas", "pendientes", "to do", "todo", "tasks", "google tasks"],
  },
  {
    key: "habits",
    capability: "habits",
    route: "/my-elise/habits",
    order: 70,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: false,
    suggested: false,
    searchTerms: ["habitos", "rutinas", "rachas", "habits", "routines", "streaks"],
  },
  {
    key: "lists",
    capability: "lists",
    route: "/my-elise/lists",
    order: 40,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    searchTerms: ["listas", "compras", "checklist", "lists", "shopping"],
  },
  {
    key: "goals",
    capability: "goals",
    route: "/my-elise/goals",
    order: 55,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: false,
    suggested: false,
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
    searchTerms: ["notas", "apuntes", "notes"],
  },
  {
    key: "finance",
    capability: "finance",
    route: "/my-elise/finance",
    order: 60,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: false,
    suggested: false,
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
  {
    // Tiempos (ADR-045, ADR-100): alarms, timers and stopwatches.
    key: "time",
    capability: "time",
    route: "/my-elise/time",
    order: 20,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    searchTerms: [
      "tiempos",
      "alarmas",
      "alarma",
      "despertador",
      "temporizador",
      "timer",
      "cronometro",
      "pomodoro",
      "alarms",
      "stopwatch",
    ],
  },
  {
    // ELISE Home (ADR-079): hiding it never unpairs the hub or deletes rooms, modes or aliases.
    key: "home",
    capability: "home",
    route: "/my-elise/home",
    order: 10,
    available: true,
    defaultForExistingUsers: true,
    defaultForNewUsers: true,
    suggested: true,
    searchTerms: [
      "hogar",
      "casa",
      "luces",
      "aire",
      "dispositivos",
      "domotica",
      "smart home",
      "home",
      "lights",
      "devices",
    ],
  },
] as const satisfies readonly NativeModuleDefinition[];

export type NativeModuleKey = (typeof NATIVE_MODULES)[number]["key"];
/** Whether each module shows in Mi ELISE (visibility only, ADR-070). */
export type ModuleStates = Record<NativeModuleKey, boolean>;
export type ModuleVisibility = ModuleStates;

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
 * Which modules show in Mi ELISE, from the person's saved choices (null: never chose):
 * - unavailable → not shown;
 * - a saved choice wins;
 * - no choice for this module: someone who never chose gets the new-user default; someone who
 *   chose before this module existed gets the existing-user default.
 */
export function effectiveModules(
  saved: Readonly<Partial<Record<string, boolean>>> | null,
): ModuleStates {
  const out = {} as ModuleStates;
  for (const m of NATIVE_MODULES) {
    const choice = saved?.[m.key];
    out[m.key] = !m.available
      ? false
      : typeof choice === "boolean"
        ? choice
        : saved
          ? m.defaultForExistingUsers
          : m.defaultForNewUsers;
  }
  return out;
}

export const visibleModuleKeys = (states: ModuleStates): NativeModuleKey[] =>
  availableModules()
    .map((m) => m.key as NativeModuleKey)
    .filter((k) => states[k]);

/** The module whose pages a path belongs to ("/my-elise/finance/reports" → finance). */
export function moduleOfPath(pathname: string): NativeModuleKey | null {
  return (
    NATIVE_MODULES.find((m) => pathname === m.route || pathname.startsWith(`${m.route}/`))?.key ??
    null
  );
}
