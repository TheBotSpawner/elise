import type { AnyToolDefinition } from "./tools";

/**
 * Which tools a turn sees (ADR-025). ELISE has ~150 tools; sending all of them on every model
 * call costs ~20k input tokens and makes routing harder. A turn gets a small always-on core plus
 * the groups its message, the visible Surfaces and the recent turns point to. Nothing becomes
 * unreachable: the rest stays one `tools.more` call away (see the runtime).
 *
 * Groups are tool-name prefixes ("email", "finance"): the same names the registry uses.
 */

/** Everyday capabilities every turn keeps. */
export const CORE_GROUPS: ReadonlySet<string> = new Set([
  "ui",
  "appearance",
  "settings",
  "notifications",
  "voice",
  "connections",
  "planning",
  "meeting",
  "work",
  "briefs",
  "history",
  "knowledge",
  "calendar",
  "tasks",
]);

/** A message about places or travel (the browser also refreshes the device location for it). */
export const LOCATION_SIGNAL =
  /\b(tard[oa]\w*|ruta|c[oó]mo llego|d[oó]nde (queda|est[aá])|cerca|near\w*|mapa|maps?|direcci[oó]n|address|km|kil[oó]metros?|viaje|llegar|desde .+ hasta|caf[eé]s?|restaurant\w*|farmacias?|routes?|how long|drive|walk\w*|en auto|caminando|colectivo|subte|tr[aá]nsito|por ac[aá]|around here|d[oó]nde estoy|where am i)\b/i;

/** Words that point to a group (Spanish and English). Deliberately generous: a false positive
 * costs a few hundred tokens, a false negative an extra round trip. */
const SIGNALS: readonly [string, RegExp][] = [
  [
    "email",
    /\b(e-?mails?|mails?|correos?|casilla|inbox|gmail|bandeja|remitente|respond\w*|contest\w*|reenvi\w*|forward|reply)\b/i,
  ],
  [
    "finance",
    /\b(gast\w*|plata|dinero|finanz\w*|presupuest\w*|ingres\w*|expens\w*|budget|spend\w*|money|pesos|d[oó]lar\w*|transacci\w*|pagu[eé]|pag[oó]|cobr\w*|sueldo|salary)\b|\$/i,
  ],
  ["structured", /\b(base de datos|database|registros?|records?|crm|tablas?|notion)\b/i],
  [
    "contexts",
    /\b(contextos?|contexts?|clientes?|clients?|secci[oó]n|section|perfil|carrera|materias?|proyectos?|projects?|poneme al d[ií]a|catch me up)\b/i,
  ],
  ["shortcuts", /\b(atajos?|shortcuts?|rutinas?|routines?|cuando (te )?diga|when i say)\b/i],
  [
    "study",
    /\b(estudi\w*|study|quiz|ex[aá]men\w*|exams?|oral|repas\w*|tomame|preguntame|practic\w*|flashcards?|parcial\w*|evaluame)\b/i,
  ],
  ["goals", /\b(metas?|objetivos?|goals?)\b/i],
  ["habits", /\b(h[aá]bitos?|habits?|rachas?|streaks?|check-?in|gym|gimnasio|entren\w*)\b/i],
  ["lists", /\b(listas?|lists?|compras|shopping|packing|valija|supermercado)\b/i],
  ["notes", /\b(notas?|notes?|anot\w*|apunt[aá]\w*)\b/i],
  [
    "schedules",
    /\b(program[aá]\w*|todos los d[ií]as|cada (d[ií]a|lunes|martes|mi[eé]rcoles|jueves|viernes|semana|mañana)|every (day|morning|week\w*)|morning brief|resumen (matutino|diario)|recordame cada)\b/i,
  ],
  ["location", LOCATION_SIGNAL],
  [
    "web",
    /\b(noticias?|news|investig\w*|research|web|internet|google|[uú]ltim\w*|latest|actual\w*|precio\w*|prices?|versi[oó]n|version|qu[eé] pas[oó]|cotizaci\w*|clima|weather|publicaci\w*|anuncios?|listings?|ofertas?|productos?|opciones|departamentos?|alquiler\w*|en venta|comprar|usados?|cursos?|buscame|encontrame|find me)\b/i,
  ],
];

/** Visible Surfaces keep their capability's tools at hand ("open the second email"). */
const SURFACE_GROUPS: Readonly<Record<string, string>> = {
  email_list: "email",
  email_thread: "email",
  web_results: "web",
  web_source: "web",
  web_news: "web",
  web_research: "web",
  web_collection: "web",
  context_overview: "contexts",
  context_proposal: "contexts",
  study_question: "study",
  study_progress: "study",
  study_summary: "study",
  shortcut: "shortcuts",
  schedule: "schedules",
  map: "location",
  place: "location",
};

export interface ToolSelection {
  tools: AnyToolDefinition[];
  /** Everything else, loadable with `tools.more`. */
  rest: AnyToolDefinition[];
  groups: string[];
}

const groupOf = (t: AnyToolDefinition) => t.name.split(".")[0] ?? t.name;

export function selectTools(
  all: readonly AnyToolDefinition[],
  signals: {
    message: string;
    /** Types of the Surfaces on screen. */
    surfaceTypes?: readonly string[];
    /** Tool names used in recent turns (from their notes). */
    recentTools?: readonly string[];
    /** The active context's kind ("subject", "client"…), if any. */
    contextKind?: string | null;
  },
): ToolSelection {
  const groups = new Set(CORE_GROUPS);
  for (const [g, re] of SIGNALS) if (re.test(signals.message)) groups.add(g);
  for (const s of signals.surfaceTypes ?? []) if (SURFACE_GROUPS[s]) groups.add(SURFACE_GROUPS[s]);
  for (const n of signals.recentTools ?? []) groups.add(n.split(".")[0] ?? n);
  if (signals.contextKind) {
    groups.add("contexts");
    if (signals.contextKind === "subject") groups.add("study");
    else groups.add("email");
  }
  // Core groups first, in registry order, then the rest in registry order: the stable part of
  // the list stays a stable prefix for prompt caching.
  const core = all.filter((t) => CORE_GROUPS.has(groupOf(t)));
  const extra = all.filter((t) => !CORE_GROUPS.has(groupOf(t)) && groups.has(groupOf(t)));
  const rest = all.filter((t) => !groups.has(groupOf(t)));
  return { tools: [...core, ...extra], rest, groups: [...groups] };
}

/** Tool names a turn's notes mention ("email.search ✓ 3 messages" → "email.search"). */
export function toolsInNotes(notes: readonly string[]): string[] {
  return notes.map((n) => n.split(" ")[0] ?? "").filter((n) => /^[a-z]+\.[A-Za-z]+$/.test(n));
}
