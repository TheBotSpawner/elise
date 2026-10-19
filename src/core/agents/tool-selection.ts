import type { AnyToolDefinition } from "./tools";
import { namesAList } from "../capabilities/lists";

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
  // "Activame Hábitos", "quiero registrar gastos" (a module that is off): always reachable.
  "modules",
  "planning",
  "meeting",
  "work",
  "briefs",
  "history",
  "knowledge",
  "calendar",
  "tasks",
  // Two small tools; "¿cómo va a estar esta semana?" names no keyword and must never fall to web.
  "weather",
  // "¿Cuánto falta?", "pausalo", "¿qué hora es?" name no keyword; five small tools.
  "time",
]);

/**
 * A message about public markets: tickers (2–5 capitals), stock/market words, indices. Market
 * tools are loaded for these only; "¿cuánto gasté?" is Finance, never markets.
 */
const MARKET_WORDS =
  /(?<!\p{L})(acci[oó]n(es)?|stocks?|shares?|bolsa|burs[aá]til|mercados?|markets?|cotiza\p{L}*|ticker|nasdaq|nyse|s&p|sp500|dow jones|merval|etf|[ií]ndice|index|wall street|subi[oó]|baj[oó]|cay[oó]|cerr[oó]|cierre|apertura|inversion\p{L}*|invest\p{L}*|watchlist|activos?)(?!\p{L})/iu;
/** A ticker in capitals ("AAPL", "GOOGL") ending a question or before "hoy", "en bolsa"… */
const TICKER = /(?<!\p{L})[A-Z]{2,5}(?=\s*(\?|$|,| hoy| ahora| esta| en bolsa))/u;
/** "Seguí Alphabet en mis resúmenes", "lo que sigo": following assets names no market word. */
const FOLLOWING =
  /(?<!\p{L})(segu[ií]|seguir|follow|dej[aá] de seguir|sac[aá])(?!\p{L})[^.?!]*(?<!\p{L})(res[uú]menes|resumen|brief|programados)(?!\p{L})|(?<!\p{L})(lo que sigo|what I follow)(?!\p{L})/iu;
/** "Prendé la luz", "poné el aire a 24", "apagá todo el living", "activá Modo Estudio". */
const HOME_WORDS =
  /(?<!\p{L})(luz|luces|l[aá]mpara\p{L}*|foco\p{L}*|aire( acondicionado)?|split|ventilador\p{L}*|humidificador\p{L}*|enchufe\p{L}*|tele|tv|televisor|calefacci[oó]n|termostato|persiana\p{L}*|living|dormitorio|habitaci[oó]n|cocina|ba[ñn]o|modo (estudio|cine|dormir|trabajo|lectura|fiesta)|modos?|escenas?|hogar|dispositivos?|prend[eéií]\p{L}*|apag[aáuo]\p{L}*|encend[eé]\p{L}*|light|lights|lamp|thermostat|turn (on|off)|scene)(?!\p{L})/iu;
export const HOME_SIGNAL = { test: (m: string) => HOME_WORDS.test(m) };
export const MARKET_SIGNAL = {
  test: (m: string) => MARKET_WORDS.test(m) || TICKER.test(m) || FOLLOWING.test(m),
};

/** A message about places or travel (the browser also refreshes the device location for it). */
export const LOCATION_SIGNAL =
  /\b(tard[oa]\w*|ruta|c[oó]mo llego|d[oó]nde (queda|est[aá])|cerca|near\w*|mapa|maps?|direcci[oó]n|address|km|kil[oó]metros?|viaje|llegar|desde .+ hasta|caf[eé]s?|restaurant\w*|farmacias?|routes?|how long|drive|walk\w*|en auto|caminando|colectivo|subte|tr[aá]nsito|por ac[aá]|around here|d[oó]nde estoy|where am i)\b/i;

/** Weather "here" questions: the browser refreshes the device position for them too. */
export const WEATHER_HERE_SIGNAL =
  /(?<!\p{L})(llov\p{L}*|lluev\p{L}*|lluvia|clima|tiempo hace|temperatura|pron[oó]stico|fr[ií]o|calor|weather|rain\p{L}*|forecast)(?!\p{L})[^.?!]*(?<!\p{L})(ac[aá]|aqu[ií]|donde estoy|here|where i am)(?!\p{L})/iu;

/** Words that point to a group (Spanish and English). Deliberately generous: a false positive
 * costs a few hundred tokens, a false negative an extra round trip. */
const SIGNALS: readonly [string, { test(message: string): boolean }][] = [
  [
    "email",
    /\b(e-?mails?|mails?|correos?|casilla|inbox|gmail|bandeja|remitente|respond\w*|contest\w*|reenvi\w*|forward|reply)\b/i,
  ],
  [
    "finance",
    /\b(gast\w*|plata|dinero|finanz\w*|presupuest\w*|ingres\w*|expens\w*|budget|spend\w*|money|pesos|d[oó]lar\w*|transacci\w*|pagu[eé]|pag[oó]|cobr\w*|sueldo|salary)\b|\$/i,
  ],
  [
    "teamMessaging",
    /\b(slack|canal(es)?|channels?|threads?|hilos?|dijeron|dijo|habl[oó]|hablaron|hablamos|coment[oó]|mensajes?|mand[aá]le|escribile|avisale|reacci[oó]n|reaccion[aá]|workspace|equipo|team)\b|#[\w-]+|👍|✅/i,
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
  // "¿Cómo vengo con Vida saludable?" names a Vision, not the word "objetivo" (ADR-055).
  [
    "goals",
    /\b(metas?|objetivos?|goals?|visi[oó]n(es)?|visions?|logros?|c[oó]mo (vengo|voy)|how am i doing|progreso|avance)\b/i,
  ],
  ["habits", /\b(h[aá]bitos?|habits?|rachas?|streaks?|check-?in|gym|gimnasio|entren\w*)\b/i],
  ["lists", /\b(listas?|lists?|compras|shopping|packing|valija|supermercado)\b/i],
  ["notes", /\b(notas?|notes?|anot\w*|apunt[aá]\w*)\b/i],
  [
    "schedules",
    /\b(program[aá]\w*|todos los d[ií]as|cada (d[ií]a|lunes|martes|mi[eé]rcoles|jueves|viernes|semana|mañana)|every (day|morning|week\w*)|morning brief|resumen (matutino|diario)|recordame cada)\b/i,
  ],
  ["location", LOCATION_SIGNAL],
  // Public markets (ADR-074): tickers, listed companies in a market context, prices, indices.
  ["markets", MARKET_SIGNAL],
  // ELISE Home (ADR-079): devices, rooms, modes, on/off — never a Finance or Knowledge question.
  ["home", HOME_SIGNAL],
  [
    "music",
    /\b(m[uú]sica|music|canci[oó]n\w*|songs?|temas?|playlists?|[aá]lbum(es)?|albums?|spotify|youtube|reproduc\w*|videos?|videoclips?|canal(es)? de youtube|youtube channels?|pon[eé]me|pas[aá] (esta|este)|siguiente canci[oó]n|paus[aá] la m[uú]sica|volumen|volume|subilo|bajalo|parlante|speaker)\b/i,
  ],
  [
    "methods",
    /\b(m[eé]todos?|methods?|procedimientos?|procedures?|a partir de ahora|de ahora en (m[aá]s|adelante)|siempre|always|from now on|next time|la pr[oó]xima vez|aprend[eé]\w*|learn|guard[aá] (esta|este) (forma|manera)|formato|plantilla|template)\b/i,
  ],
  [
    "web",
    /\b(noticias?|news|investig\w*|research|web|internet|google|[uú]ltim\w*|latest|actual\w*|precio\w*|prices?|versi[oó]n|version|qu[eé] pas[oó]|cotizaci\w*|publicaci\w*|anuncios?|listings?|ofertas?|productos?|opciones|departamentos?|alquiler\w*|en venta|comprar|usados?|cursos?|buscame|encontrame|find me)\b/i,
  ],
];

/**
 * The user names a database, not documents (ADR-048): "mi base de Oportunidades en Notion",
 * "la database de Proyectos", "mi CRM", "los registros de…". Then the structured source is the
 * answer's source; Knowledge search isn't offered up front (still loadable with tools.more for
 * an intentional supplement). Pages and documents ("la página de Notion que dice…") are Knowledge.
 */
const DATABASE_WORDS =
  /\b(bases? de datos|databases?|crm|tablas?|registros?|records?|filas|rows|pipeline|embudo|base de (?!conocimiento)\p{L}+|base \p{L}+ (en|de) notion)\b/iu;
const DOCUMENT_WORDS =
  /\b(p[aá]ginas?|pages?|documentos?|documents?|docs?|plantillas?|templates?|qu[eé] dice|what does .* say|escribimos|wrote|apuntes?|pdf)\b/i;

export function explicitStructured(message: string): boolean {
  return DATABASE_WORDS.test(message) && !DOCUMENT_WORDS.test(message);
}

/** Visible Surfaces keep their capability's tools at hand ("open the second email"). */
const SURFACE_GROUPS: Readonly<Record<string, string>> = {
  calendar: "calendar",
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
  weather: "weather",
  market: "markets",
  home: "home",
  music: "music",
  timer: "time",
  clock: "time",
  goal: "goals",
  goals_overview: "goals",
  vision: "goals",
  team_messages: "teamMessaging",
  team_thread: "teamMessaging",
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
    /** The user's ELISE list names: naming one brings the Lists tools ("agregalos a Compras"). */
    listNames?: readonly string[];
  },
): ToolSelection {
  const groups = new Set(CORE_GROUPS);
  for (const [g, re] of SIGNALS) if (re.test(signals.message)) groups.add(g);
  if (signals.listNames?.length && namesAList(signals.message, signals.listNames))
    groups.add("lists");
  for (const s of signals.surfaceTypes ?? []) if (SURFACE_GROUPS[s]) groups.add(SURFACE_GROUPS[s]);
  for (const n of signals.recentTools ?? []) groups.add(n.split(".")[0] ?? n);
  if (signals.contextKind) {
    groups.add("contexts");
    if (signals.contextKind === "subject") groups.add("study");
    else groups.add("email");
  }
  // An explicit database request goes to the database (ADR-048): structured tools in, document
  // search out of the first pass — it can be loaded on purpose, never cascaded into by default.
  const structured = explicitStructured(signals.message);
  if (structured) groups.add("structured");
  const held = (t: AnyToolDefinition) => structured && t.name === "knowledge.search";
  // Core groups first, in registry order, then the rest in registry order: the stable part of
  // the list stays a stable prefix for prompt caching.
  const core = all.filter((t) => CORE_GROUPS.has(groupOf(t)) && !held(t));
  const extra = all.filter((t) => !CORE_GROUPS.has(groupOf(t)) && groups.has(groupOf(t)));
  const rest = all.filter((t) => !groups.has(groupOf(t)) || held(t));
  return { tools: [...core, ...extra], rest, groups: [...groups] };
}

/** Tool names a turn's notes mention ("email.search ✓ 3 messages" → "email.search"). */
export function toolsInNotes(notes: readonly string[]): string[] {
  return notes
    .map((n) => n.split(" ")[0] ?? "")
    .filter((n) => /^[a-z][A-Za-z]*\.[A-Za-z]+$/.test(n));
}
