/**
 * What ELISE says while she works (ADR-028): one semantic lifecycle shared by Voice and Canvas.
 *
 *   USER_TURN → ACTIVITY_STARTED (tool started) → RESULT_AVAILABLE (tools finished, Surfaces
 *   shown) → FINAL (the verified answer)
 *
 * Speech is categorised, not one FIFO: a progress line ("Lo busco.") is ephemeral and is only
 * said while the work it announces is still running and no result is being said — so "I'll
 * look for it" can never follow results already on screen. Factual results, approvals and
 * errors are never dropped. The acknowledgement is deterministic and localised: no model call.
 * Transport-independent: the legacy pipeline uses it directly; GPT-Live gets the same states
 * as silent progress (core/voice/live.ts).
 */

export type SpeechCategory = "progress" | "result" | "approval" | "error" | "conversational";

export interface SpeechState {
  /** Tools of this turn still running. */
  running: number;
  /** At least one tool started this turn. */
  started: boolean;
  /** A factual sentence (after the work) was queued: progress is over. */
  resultQueued: boolean;
}

/** A progress line older than this is never said: the moment has passed. */
export const PROGRESS_TTL_MS = 6_000;

/**
 * Whether a queued line may still start playing. Checked when its turn in the queue comes and
 * again when its audio arrives — playback never starts on a stale announcement.
 */
export function stillSayable(
  line: { category: SpeechCategory; createdAt: number },
  state: SpeechState,
  now: number,
): boolean {
  if (line.category !== "progress") return true;
  return (
    !state.resultQueued &&
    (state.running > 0 || !state.started) &&
    now - line.createdAt <= PROGRESS_TTL_MS
  );
}

/**
 * What kind of work just started (ADR-034): read from the tool, never from a second model call.
 * Mutations and risky actions have their own wording — before success ELISE says she's doing it
 * ("Lo hago."), never that it's done; a risky action (send, delete, pay) only "prepares" it.
 */
export type AckIntent =
  | "search_web"
  | "search_knowledge"
  | "search_recall"
  | "check_calendar"
  | "check_email"
  | "check_tasks"
  | "map_route"
  | "find_places"
  | "analyze_data"
  | "prepare_meeting"
  | "plan"
  | "create"
  | "update"
  | "risky"
  | "general";

/** Instant work (the screen, settings, contexts): its answer is the acknowledgement. */
const INSTANT = new Set(["ui", "workspace", "settings", "appearance", "contexts", "shortcuts"]);
const CREATE = /\.(create|add|new|log|checkIn|append|save|capture|record|import)/i;
const UPDATE =
  /\.(update|edit|move|rename|complete|reopen|set|mark|toggle|reschedule|link|tag|assign)/i;
const RISKY =
  /\.(delete|remove|archive|trash|send|reply|forward|pay|cancel|decline|accept|invite)/i;

const READS: Record<string, AckIntent> = {
  web: "search_web",
  knowledge: "search_knowledge",
  history: "search_recall",
  calendar: "check_calendar",
  email: "check_email",
  tasks: "check_tasks",
  location: "map_route",
  "location.searchPlaces": "find_places",
  "location.getPlace": "find_places",
  finance: "analyze_data",
  structured: "analyze_data",
  meeting: "prepare_meeting",
  work: "prepare_meeting",
  planning: "plan",
  briefs: "plan",
};

export function ackIntent(toolName: string): AckIntent | null {
  const capability = toolName.split(".")[0] ?? "";
  if (INSTANT.has(capability)) return null;
  if (RISKY.test(toolName)) return "risky";
  if (CREATE.test(toolName)) return "create";
  if (UPDATE.test(toolName)) return "update";
  return READS[toolName] ?? READS[capability] ?? (capability ? "general" : null);
}

type Bank = Record<AckIntent, { es: string[]; en: string[] }>;

/**
 * Short (2–6 words), calm, semantically grounded. The first line of each is the classic one;
 * "un segundo" appears once, on purpose (it promises a timing).
 */
const ACKS: Bank = {
  search_web: {
    es: ["Lo busco.", "Ya lo busco.", "Voy a buscarlo.", "Déjame buscarlo."],
    en: ["Let me look it up.", "Looking it up.", "On it, searching.", "Let me check online."],
  },
  search_knowledge: {
    es: ["Reviso el material.", "Lo busco en tus fuentes.", "Déjame revisar tus apuntes."],
    en: ["Checking your material.", "Looking through your sources.", "Let me check your notes."],
  },
  search_recall: {
    es: ["Busco en nuestras conversaciones.", "Déjame recordar.", "Lo busco en lo que hablamos."],
    en: ["Searching our conversations.", "Let me recall that.", "Checking what we talked about."],
  },
  check_calendar: {
    es: ["Reviso tu agenda.", "Ya miro el calendario.", "Déjame ver qué tenés."],
    en: ["Checking your calendar.", "Let me look at your schedule.", "Looking at your week."],
  },
  check_email: {
    es: ["Reviso tus mails.", "Ya miro tu correo.", "Déjame revisar el correo."],
    en: ["Checking your email.", "Looking at your inbox.", "Let me check your mail."],
  },
  check_tasks: {
    es: ["Reviso tus tareas.", "Ya miro tus pendientes.", "Déjame ver tus tareas."],
    en: ["Checking your tasks.", "Looking at your to-dos.", "Let me see your tasks."],
  },
  map_route: {
    es: ["Calculo la ruta.", "Ya veo cómo llegar.", "Déjame ver el camino."],
    en: ["Working out the route.", "Checking how to get there.", "Let me map it."],
  },
  find_places: {
    es: ["Busco los lugares.", "Lo busco en el mapa.", "Ya miro qué hay cerca."],
    en: ["Looking for places.", "Checking the map.", "Let me see what's nearby."],
  },
  analyze_data: {
    es: ["Reviso tus números.", "Lo reviso.", "Ya lo calculo."],
    en: ["Checking your numbers.", "Checking.", "Let me work it out."],
  },
  prepare_meeting: {
    es: ["Preparo la reunión.", "Sí, te la preparo.", "Voy armando lo de la reunión."],
    en: ["Preparing the meeting.", "Getting it ready.", "Putting the meeting prep together."],
  },
  plan: {
    es: ["Armo el resumen.", "Voy con eso.", "Lo armo."],
    en: ["Putting it together.", "On it.", "Let me pull it together."],
  },
  create: {
    es: ["Lo hago.", "Claro, lo agrego.", "Sí, lo anoto."],
    en: ["On it.", "Sure, adding it.", "Got it, noting it down."],
  },
  update: {
    es: ["Lo cambio.", "Claro, lo actualizo.", "Sí, lo ajusto."],
    en: ["Changing it.", "Sure, updating it.", "Got it, adjusting it."],
  },
  risky: {
    es: ["Sí, lo preparo.", "Lo dejo listo para que confirmes.", "Preparo eso."],
    en: ["Sure, I'll prepare it.", "Getting it ready for you to confirm.", "Preparing that."],
  },
  general: {
    es: ["Voy con eso.", "Lo veo.", "Ya lo miro.", "Sí, dame un segundo."],
    en: ["On it.", "Let me see.", "Looking into it.", "One moment."],
  },
};

/**
 * The work a spoken request clearly asks for, read from its words the moment it's transcribed —
 * seconds before the model picks a tool (measured: 3–7 s). Deliberately conservative: only
 * plain lookups; anything that changes something (move, add, send…) waits for the real tool, so
 * an ambiguous "mové la reunión" gets a question, never a premature "lo busco".
 */
const ACTION_WORDS =
  /\b(mov[eé]|cambi[aá]|borr[aá]|elimin[aá]|cancel[aá]|agreg[aá]|a[ñn]ad[ií]|cre[aá]|agend[aá]|anot[aá]|mand[aá]|envi[aá]|respond[eé]|guard[aá]|archiv[aá]|marc[aá]|pon[eé]|move|change|delete|remove|cancel|add|create|schedule|send|reply|save|archive|mark|set)\b/i;
const LOOKUPS: [RegExp, AckIntent][] = [
  [/\b(noticias|news|investig[aá]|research|en (la )?web|online|internet)\b/i, "search_web"],
  [
    /\b(cu[aá]nto tardo|c[oó]mo llego|ruta|how long .*(get|drive)|directions|route)\b/i,
    "map_route",
  ],
  [
    /\b(apuntes|mis documentos|mi material|el material|mis notas de|cronograma de la materia|my notes|my documents)\b/i,
    "search_knowledge",
  ],
  [
    /\b(hablamos|charlamos|te (dije|cont[eé])|conversaci[oó]n anterior|we (talked|discussed)|did i tell you)\b/i,
    "search_recall",
  ],
  [
    /\b(mi calendario|mi agenda|qu[eé] tengo (hoy|ma[ñn]ana|el|esta|la)|mis reuniones|my calendar|my schedule|my meetings)\b/i,
    "check_calendar",
  ],
  [/\b(mis (mails|correos|emails)|mi (correo|bandeja)|my (email|inbox))\b/i, "check_email"],
  [/\b(mis tareas|mis pendientes|qu[eé] tareas|my tasks|my to-?dos)\b/i, "check_tasks"],
];

export function predictIntent(text: string): AckIntent | null {
  const t = text.trim();
  if (t.split(/\s+/).length < 3 || ACTION_WORDS.test(t)) return null;
  return LOOKUPS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** At most one progress line per turn, after a meaningful wait — not a talking spinner. */
export const PROGRESS_AFTER_MS = 3_500;

const PROGRESS: Partial<Bank> = {
  search_web: { es: ["Sigo buscando."], en: ["Still searching."] },
  search_knowledge: {
    es: ["Sigo revisando tus documentos."],
    en: ["Still going through your documents."],
  },
  search_recall: {
    es: ["Sigo buscando en lo que hablamos."],
    en: ["Still searching our conversations."],
  },
  check_calendar: { es: ["Sigo revisando tu agenda."], en: ["Still checking your calendar."] },
  check_email: { es: ["Sigo revisando tus mails."], en: ["Still going through your email."] },
  map_route: { es: ["Sigo con la ruta."], en: ["Still working out the route."] },
  find_places: { es: ["Sigo buscando lugares."], en: ["Still looking for places."] },
  prepare_meeting: {
    es: ["Estoy revisando los últimos correos y la reunión."],
    en: ["Going through the latest emails and the meeting."],
  },
  plan: { es: ["Lo estoy armando."], en: ["Still putting it together."] },
  analyze_data: { es: ["Lo estoy calculando."], en: ["Still working it out."] },
  general: { es: ["Sigo con eso."], en: ["Still on it."] },
};

/**
 * The acknowledgement for this intent, in this language: the first line not said recently
 * (else the least recently said). Deterministic — the same history gives the same line.
 */
export function pickAcknowledgement(
  intent: AckIntent,
  locale: "es" | "en",
  recent: readonly string[] = [],
): string {
  const bank = ACKS[intent][locale];
  const fresh = bank.find((l) => !recent.includes(l));
  if (fresh) return fresh;
  return [...bank].sort((a, b) => recent.lastIndexOf(a) - recent.lastIndexOf(b))[0]!;
}

/** The single progress line for long work of this kind (none for quick mutations). */
export function progressLine(intent: AckIntent, locale: "es" | "en"): string | null {
  return PROGRESS[intent]?.[locale][0] ?? null;
}

/**
 * The short, verified acknowledgement for the work that just started (never a result).
 * Instant tools (settings, the screen) get none: their answer is the acknowledgement.
 */
export function acknowledgement(
  toolName: string,
  locale: "es" | "en",
  recent: readonly string[] = [],
): string | null {
  const intent = ackIntent(toolName);
  return intent ? pickAcknowledgement(intent, locale, recent) : null;
}

/** Every acknowledgement and progress line in a language: fixed, so cached and warmed ahead. */
export function acknowledgements(locale: "es" | "en"): string[] {
  return [
    ...new Set([
      ...Object.values(ACKS).flatMap((b) => b[locale]),
      ...Object.values(PROGRESS).flatMap((b) => b?.[locale] ?? []),
    ]),
  ];
}
