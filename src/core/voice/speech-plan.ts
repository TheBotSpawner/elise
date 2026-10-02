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

const ACK: Record<string, { es: string; en: string }> = {
  web: { es: "Lo busco.", en: "Let me look it up." },
  location: { es: "Calculo la ruta.", en: "Working out the route." },
  "location.searchPlaces": { es: "Busco los lugares.", en: "Looking for places." },
  "location.getPlace": { es: "Lo busco en el mapa.", en: "Looking it up on the map." },
  knowledge: { es: "Reviso el material.", en: "Checking your material." },
  history: { es: "Busco en nuestras conversaciones.", en: "Searching our conversations." },
  calendar: { es: "Reviso tu agenda.", en: "Checking your calendar." },
  email: { es: "Reviso tus mails.", en: "Checking your email." },
  tasks: { es: "Reviso tus tareas.", en: "Checking your tasks." },
  meeting: { es: "Preparo la reunión.", en: "Preparing the meeting." },
  work: { es: "Armo el resumen.", en: "Putting the brief together." },
  finance: { es: "Reviso tus números.", en: "Checking your numbers." },
  structured: { es: "Lo reviso.", en: "Checking." },
  planning: { es: "Armo el día.", en: "Planning the day." },
  briefs: { es: "Armo el resumen del día.", en: "Building your daily brief." },
};

/**
 * The short, verified acknowledgement for the work that just started (never a result).
 * Instant tools (settings, the screen) get none: their answer is the acknowledgement.
 */
export function acknowledgement(toolName: string, locale: "es" | "en"): string | null {
  const line = ACK[toolName] ?? ACK[toolName.split(".")[0] ?? ""];
  return line ? line[locale] : null;
}

/** Every acknowledgement in a language: few and fixed, so they can be synthesized ahead. */
export function acknowledgements(locale: "es" | "en"): string[] {
  return [...new Set(Object.values(ACK).map((l) => l[locale]))];
}
