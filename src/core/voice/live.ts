/**
 * GPT-Live voice frontend (ADR-026). GPT-Live owns the conversation — listening, turn-taking,
 * interruptions, short acknowledgements, speech — and delegates everything that needs the
 * user's world or an action to ELISE's turn engine (client delegation). This module holds the
 * transport-free parts: the voice prompt, the transcript timeline (Live sends deltas with
 * times but no turn boundaries), what a delegation asks for, and the compact result GPT-Live
 * speaks from. No browser or server dependencies.
 */

export const LIVE_MODEL = "gpt-live-1";
/** Max tokens per append (≈4 chars/token): results stay well inside it. */
export const LIVE_APPEND_CHARS = 1600;

export interface LivePromptInput {
  locale: "es" | "en";
  displayName: string | null;
}

/**
 * The voice prompt: identity, speaking style, interruptions, backchannels and when to
 * delegate. Business rules, tools and sources stay in the backend prompt — never copied here.
 */
export function liveInstructions(input: LivePromptInput): string {
  const name = input.displayName ? input.displayName.split(" ")[0] : null;
  if (input.locale === "es")
    return `Sos Elise, la asistente personal de ${name ?? "la persona usuaria"}: una sola inteligencia que la ayuda con su día. Hablás en español rioplatense, con "vos", cálida, tranquila y breve. Sos la misma Elise del chat: la voz es solo otra forma de hablarle.

Estilo de voz:
- Frases cortas y naturales, como una persona. Nunca leas listas, links, ids ni markdown: el detalle aparece en la pantalla de ELISE (el Canvas) y vos decís la síntesis ("te lo dejé en pantalla").
- Una o dos oraciones por turno, salvo que te pidan más.

Interrupciones: si te interrumpen, parás y escuchás. Si corrigen ("no, el lunes"), seguís con la corrección.

Backchannels: con moderación ("Sí.", "Dale.", "Ya lo miro."). Nunca repetitivos y nunca como si algo ya estuviera hecho.

Política de delegación:
Herramientas del backend: ELISE (el backend) ve y hace todo lo del mundo de la persona: calendario, mails, tareas, documentos y secciones de Conocimiento, conversaciones anteriores, mapas y tiempos de viaje, búsqueda e investigación web, notas, listas, hábitos, metas, finanzas, reuniones, configuración (colores, tema, voz), lo que se muestra en pantalla (abrir, enfocar, comparar, volver) y las aprobaciones de acciones pendientes.
Delegá al backend cuando: el pedido necesita datos de la persona, hechos actuales, una acción, un cambio en pantalla o en la configuración ("cambiá tu color a verde"); cuando responde "sí"/"no"/"mandalo" a algo que ELISE preguntó; cuando corrige, agrega o cancela algo que ya delegaste ("no, el lunes", "solo los de hoy", "dejalo").
No delegues cuando: es un saludo o charla ("hola, ¿cómo estás?"), te piden repetir, hablar más lento o más corto, o necesitás que aclaren algo que no entendiste.

Mientras el backend trabaja:
- Apenas delegás algo que lleva tiempo (buscar, revisar, calcular una ruta, preparar), decí enseguida UNA frase muy corta acorde a lo que es ("Reviso tu agenda.", "Lo busco.", "Reviso el material.", "Calculo la ruta."), variándola entre turnos. Para una acción: "Lo hago." o "Sí, lo preparo." — nunca "listo" ni que algo se hizo hasta que ELISE lo confirme. Si es instantáneo (algo en pantalla, un ajuste) o necesitás aclarar algo, no la digas. Nunca inventes resultados, horarios, nombres, cantidades ni contenido de mails.
- Si la persona sigue hablando, escuchala; lo nuevo también se delega si cambia el pedido.
- Cuando llegue el resultado del backend, decilo con naturalidad y en pocas palabras, sin agregar datos que no estén en él. Si dice que el detalle está en pantalla, no lo leas.
- Si el backend pide confirmación para una acción (enviar, borrar, invitar), preguntala tal cual y esperá: solo el backend decide si quedó aprobada.`;
  return `You are Elise, ${name ? `${name}'s` : "the user's"} personal assistant: one intelligence that helps with their day. Speak warmly, calmly and briefly. You are the same Elise as in the chat; voice is just another way to talk.

Voice style:
- Short, natural sentences. Never read lists, links, ids or markdown: details appear on ELISE's screen (the Canvas) and you say the gist ("it's on screen").
- One or two sentences per turn unless asked for more.

Interruptions: when interrupted, stop and listen. Follow corrections ("no, Monday").

Backchannels: sparingly ("Sure.", "One sec.", "Checking."). Never repetitive, never as if something were already done.

Delegation policy:
Backend tools: ELISE (the backend) sees and does everything in the user's world: calendar, email, tasks, Knowledge documents and Sections, past conversations, maps and travel times, web search and research, notes, lists, habits, goals, finance, meetings, settings (colors, theme, voice), what's on screen (open, focus, compare, go back) and approvals of pending actions.
Delegate to the backend when: the request needs the user's data, current facts, an action, a screen or settings change ("change your color to green"); when the user answers "yes"/"no"/"send it" to something ELISE asked; when they correct, add to or cancel something you delegated ("no, Monday", "only today's", "never mind").
Do not delegate to the backend when: it's a greeting or small talk, they ask you to repeat, slow down or be shorter, or you need them to clarify something you didn't catch.

While the backend works:
- As soon as you delegate something that takes time (searching, checking, routing, preparing), say ONE very short line that fits it ("Checking your calendar.", "Let me look it up.", "Working out the route."), varied across turns. For an action: "On it." or "Sure, I'll prepare it." — never "done" or that something happened until ELISE confirms it. If it's instant (something on screen, a setting) or you need to clarify, don't say it. Never invent results, times, names, numbers or email content.
- If the user keeps talking, listen; delegate again if the request changes.
- When the backend result arrives, say it naturally and briefly, adding nothing that isn't in it. If it says details are on screen, don't read them.
- If the backend asks for confirmation of an action (send, delete, invite), ask exactly that and wait: only the backend decides whether it's approved.`;
}

// ── Transcript timeline ───────────────────────────────────────────────────────

export type LiveRole = "user" | "assistant";

export interface LiveTurn {
  role: LiveRole;
  text: string;
}

interface TimelineTurn extends LiveTurn {
  /** Arrival time of its last fragment (client clock, ms). */
  lastAt: number;
  /** Handed to ELISE (the request) or said about a delegation (ack, result): the engine keeps it. */
  delegated: boolean;
  /** Already part of a delegation request. */
  consumed: boolean;
  persisted: boolean;
}

/** A pause this long within one side's speech starts a new turn. */
export const TURN_GAP_MS = 900;
/** A user fragment this soon after their previous turn continues it (ELISE started talking early). */
const CONTINUE_MS = 1_500;

/**
 * The conversation as GPT-Live transcribes it. Live sends text deltas without turn boundaries,
 * and its session clock isn't the browser's, so turns are kept in arrival order: a change of
 * speaker or a pause starts a turn. Delegated exchanges are persisted by ELISE's engine; only
 * conversation-only turns are persisted from here, and only once settled — never partials.
 */
export class TranscriptTimeline {
  private readonly list: TimelineTurn[] = [];
  private delegating = false;

  add(role: LiveRole, delta: string, now: number) {
    if (!delta) return;
    const last = this.list.at(-1);
    if (last && last.role === role && now - last.lastAt < TURN_GAP_MS * 3) {
      last.text += delta;
      last.lastAt = now;
      return;
    }
    // The user's sentence still arriving while ELISE already started answering.
    const prevUser = role === "user" ? this.list.findLast((t) => t.role === "user") : undefined;
    if (prevUser && !prevUser.consumed && now - prevUser.lastAt < CONTINUE_MS) {
      prevUser.text += delta;
      prevUser.lastAt = now;
      return;
    }
    if (role === "user") this.delegating = false;
    this.list.push({
      role,
      text: delta,
      lastAt: now,
      delegated: role === "assistant" && this.delegating,
      consumed: false,
      persisted: false,
    });
  }

  /**
   * The request a delegation carries: what the user said since ELISE last spoke (corrections
   * included), not yet sent. Marks it delegated; ELISE's next words belong to the delegation.
   */
  takeRequest(): string {
    const lastAssistant = this.list.findLastIndex((t) => t.role === "assistant" && !t.delegated);
    const turns = this.list.filter((t, i) => t.role === "user" && !t.consumed && i > lastAssistant);
    const pick = turns.length
      ? turns
      : this.list.filter((t) => t.role === "user" && !t.consumed).slice(-1);
    for (const t of pick) {
      t.consumed = true;
      t.delegated = true;
    }
    this.delegating = true;
    return clean(pick.map((t) => t.text).join(" "));
  }

  /** What the user is saying right now (for the caption). */
  partial(): string {
    const last = this.list.at(-1);
    return last?.role === "user" ? clean(last.text) : "";
  }

  /** Latest arrival time of any fragment. */
  lastAt(): number {
    return this.list.at(-1)?.lastAt ?? 0;
  }

  /** Conversation-only turns that are over and not yet persisted. Marks them persisted. */
  settled(now: number): LiveTurn[] {
    const out: LiveTurn[] = [];
    this.list.forEach((t, i) => {
      if (t.persisted || t.delegated) return;
      if (i === this.list.length - 1 && now - t.lastAt < TURN_GAP_MS * 2) return;
      // A user turn that may still be delegated waits until ELISE answers it.
      if (t.role === "user" && i === this.list.length - 1) return;
      t.persisted = true;
      const text = clean(t.text);
      if (text) out.push({ role: t.role, text });
    });
    return out;
  }
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

// ── Delegations ───────────────────────────────────────────────────────────────

const CANCEL =
  /^\s*(no,?\s*)?(dej[aá]lo|dej[aá]\s+(eso|nom[aá]s)|olvidalo|olvid[aá]te|cancel[aá](lo)?|no importa|par[aá]|basta|never ?mind|cancel( that| it)?|forget it|stop)[\s.!]*$/i;

/** "Dejalo", "never mind": a request to stop the work in progress, nothing else. */
export function isCancellation(text: string): boolean {
  return CANCEL.test(text.trim());
}

/** What ELISE verified, for GPT-Live to say. Large detail stays on the Canvas. */
export interface DelegationResult {
  status: "completed" | "needs_approval" | "failed" | "cancelled";
  /** The answer as it should be said (ELISE's spoken part). */
  spoken: string;
  /** Key facts on screen (short), so follow-ups can be answered without guessing. */
  facts: string[];
  approval?: { summary: string } | null;
}

const clipChars = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The text appended to the Live session for a finished delegation (≤ one append). */
export function resultContent(r: DelegationResult, locale: "es" | "en"): string {
  const es = locale === "es";
  const head =
    r.status === "completed"
      ? es
        ? "Resultado verificado por ELISE"
        : "Result verified by ELISE"
      : r.status === "needs_approval"
        ? es
          ? "ELISE preparó la acción y necesita confirmación"
          : "ELISE prepared the action and needs confirmation"
        : r.status === "cancelled"
          ? es
            ? "Se canceló el trabajo en curso"
            : "The work in progress was cancelled"
          : es
            ? "ELISE no pudo completarlo"
            : "ELISE couldn't complete it";
  const parts = [
    `${head}. ${es ? "Decí esto con naturalidad" : "Say this naturally"}: ${r.spoken}`,
    r.facts.length ? `${es ? "En pantalla" : "On screen"}: ${r.facts.join("; ")}` : "",
    r.approval
      ? es
        ? `Pendiente de aprobación: ${r.approval.summary}. Preguntá si lo confirma; no está hecho.`
        : `Waiting for approval: ${r.approval.summary}. Ask whether to go ahead; it isn't done.`
      : "",
  ].filter(Boolean);
  return clipChars(parts.join("\n"), LIVE_APPEND_CHARS);
}

/** Verified progress a long delegation may mention ("checking the calendar"), never results. */
export function progressContent(toolName: string, locale: "es" | "en"): string | null {
  const group = toolName.split(".")[0] ?? "";
  const es: Record<string, string> = {
    calendar: "revisando el calendario",
    email: "revisando los mails",
    tasks: "revisando las tareas",
    knowledge: "buscando en sus documentos",
    history: "buscando en conversaciones anteriores",
    web: "buscando en la web",
    meeting: "preparando la reunión",
    location: "calculando la ruta",
    weather: "revisando el pronóstico",
    work: "armando el resumen",
    planning: "armando el día",
    briefs: "armando el resumen del día",
  };
  const en: Record<string, string> = {
    calendar: "checking the calendar",
    email: "checking email",
    tasks: "checking tasks",
    knowledge: "searching their documents",
    history: "searching past conversations",
    web: "searching the web",
    meeting: "preparing the meeting",
    location: "calculating the route",
    weather: "checking the forecast",
    work: "building the brief",
    planning: "planning the day",
    briefs: "building the daily brief",
  };
  const doing = (locale === "es" ? es : en)[group];
  if (!doing) return null;
  return locale === "es"
    ? `Progreso real del backend: está ${doing}. Todavía no hay resultado; no lo anticipes.`
    : `Real backend progress: it is ${doing}. No result yet; don't anticipate it.`;
}
