/**
 * Spoken session control (ADR-102): "dejá de escuchar", "basta de escuchar", "silencio" end the
 * current conversation; "desactivá la activación por voz" turns the wake word off. Decided
 * deterministically, before the agent, so a stop never waits on a model or a tool loop.
 *
 * The whole utterance must be the command (the wake word, "che", "por favor", "ya" aside):
 * "anotá la frase 'dejá de escuchar'" or "¿por qué dejás de escuchar?" are ordinary requests.
 * ADR-104: "ELISE, mostrate" / "abrite" brings ELISE Desktop's window to the front ("show").
 * ADR-106: "ELISE, subí / bajá el volumen" moves the computer's volume a few points (Desktop).
 */

export type SessionCommand =
  | "stop"
  | "disable_wake"
  | "enable_wake"
  /** "Decime mi resumen del día": open the latest one and play it. */
  | "daily_summary"
  | "show"
  | "volume_up"
  | "volume_down";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Words around a command that don't change it: the name, courtesy, fillers. */
const AROUND =
  /^(?:(?:ok|okay|ey|hey|oye|che|eh|bueno|dale|listo|elise|elis|elisse|elize|elice|ya|ahora|por favor|porfa|gracias|nomas|no mas|ahi)\s+)+|(?:\s+(?:ok|elise|elis|elisse|elize|elice|ya|ahora|por favor|porfa|gracias|nomas|no mas|un rato|por ahora|por hoy|che|eh))+$/g;

const STOP = [
  // dejá / pará / basta / terminá / cortá de escuchar(me)
  /^(?:deja|deje|dejas|para|pare|paras|basta|termina|termine|corta|stop|frena|frene) (?:de )?escuchar(?:me)?$/,
  /^no (?:me )?escuches (?:mas|nada mas)$/,
  /^(?:silencio|basta|stop|chito|shh+|callate|para|pare)$/,
  /^(?:corta|termina|cerra|finaliza|terminemos|cortemos|fin de) (?:la )?(?:conversacion|charla|sesion|escucha)$/,
  /^(?:stop|quit) listening$/,
  /^(?:be quiet|shut up|end (?:the )?conversation|that s all|thats all)$/,
  // "Callate", "no escuches", "apagate", "no molestes", "no me escuches más" and their kin: the
  // whole utterance asks her to stop listening (the wake word stays on).
  /^(?:callate|calla|callese|callate la boca|shhh*|silencio por favor|hace silencio|apagate|apagate ya|anda a dormir|dormite|a dormir|no molestes|no me molestes|deja de molestar|no escuches|no me escuches|no escuches mas|no me escuches mas|no me escuches nada mas|deja de escucharme|ya no me escuches|no me sigas escuchando|no sigas escuchando|cerra el microfono|apaga el microfono|corta el microfono|eso es todo|nada mas|nada mas por ahora|chau|chao|hasta luego|nos vemos)$/,
];

const DISABLE = [
  /^(?:desactiva|desactivas|desactive|desactivar|apaga|apague|deshabilita|deshabilite|saca|quita) (?:la |el )?(?:activacion por voz|palabra de activacion|escucha(?: de| de elise| en segundo plano| activa)?|modo (?:de )?escucha(?: activa)?|wake word)$/,
  /^(?:pasa|pasate|cambia|cambiate|ponete) (?:a|al|en) modo manual$/,
  /^no (?:me )?(?:escuches|vuelvas a escuchar)(?: mas)? hasta que (?:te )?(?:lo )?(?:active|activo|diga|digo|llame|vuelva a activar)$/,
  /^(?:deja|para) de escuchar hasta que (?:te )?(?:lo )?(?:active|activo|diga|digo|vuelva a activar)$/,
  /^(?:turn off|disable) (?:the )?(?:wake word|voice activation)$/,
];

/** Bring the app to the front: about ELISE herself, never "mostrame mis tareas". */
/** "ELISE, activá la escucha": the wake word on again (from a session the person opened). */
const ENABLE = [
  /^(?:activa|activas|active|activar|reactiva|prende|prenda|encende|enciende|habilita|habilite|volve a activar|volve a prender) (?:la |el )?(?:activacion por voz|palabra de activacion|escucha(?: activa)?|modo (?:de )?escucha(?: activa)?|wake word)$/,
  /^(?:volve a escucharme|escuchame de nuevo|segui escuchando|volve a escuchar)$/,
  /^(?:turn on|enable) (?:the )?(?:wake word|voice activation)$/,
];

/**
 * "ELISE, decime mi resumen del día", "traeme mi resumen del día", "resumen del día": the whole
 * utterance asks for today's summary (formerly "Morning Brief") to be opened and read.
 */
const DAILY_SUMMARY = [
  /^(?:(?:decime|decimelo|dame|traeme|trae|contame|leeme|lee|mostrame|abri|abrime|pasame|poneme|pone|reproduci|quiero|quiero escuchar|quiero ver|escuchar|podes decirme|me decis|me das|me traes|me lees) )?(?:el |mi |tu )?(?:resumen (?:del dia|de hoy|diario|de la ma(?:n|ñ)ana|del dia de hoy)|morning brief|brief de hoy)$/,
  /^(?:que dice|como viene) (?:el |mi )?resumen (?:del dia|de hoy)$/,
  /^(?:tell me|give me|read me|play|open|show me)? ?(?:my |the )?(?:daily summary|morning brief|summary of the day)$/,
];

const SHOW = [
  /^(?:mostrate|muestrate|abrite|aparece|aparecete|apareceme|veni|vente|veni para aca|traete)$/,
  /^(?:abri|abrime|mostrame|traeme|pone|pasame) (?:la |tu )?(?:app|aplicacion|ventana|pantalla)(?: de elise)?$/,
  // Said alone (after the name), these can only mean ELISE herself; a recognizer often hears
  // "mostrate" as "mostrame".
  /^(?:abri|abrir|mostrame|mostra|muestra|aparece|apareci)$/,
  /^(?:show yourself|show up|open up|come up|open the app|bring (?:yourself|the app) up)$/,
];

/**
 * The computer's volume, said alone: "subí el volumen", "bajale un poco el volumen", "más
 * volumen". A device or the music named ("subí el volumen de la tele", "bajá la música") is
 * not this: it goes to ELISE, which controls the home and the music.
 */
const VOLUME_UP = [
  /^(?:subi|subile|subime|sube|suba|subir|aumenta|aumentale|aumente|subi un poco|subile un poco) (?:un poco )?(?:el |la )?(?:volumen|sonido)(?: un poco| mas)?$/,
  /^(?:mas volumen|mas fuerte|volumen mas alto|mas alto)$/,
  /^(?:turn (?:the )?(?:volume|sound|it) up|volume up|louder)$/,
];
const VOLUME_DOWN = [
  /^(?:baja|bajale|bajame|baje|bajar|disminui|disminuye|disminuya|baja un poco|bajale un poco) (?:un poco )?(?:el |la )?(?:volumen|sonido)(?: un poco| mas)?$/,
  /^(?:menos volumen|mas bajo|volumen mas bajo|mas despacio)$/,
  /^(?:turn (?:the )?(?:volume|sound|it) down|volume down|quieter)$/,
];

/** Folding drops accents, so the patterns above only need their unaccented forms to match. */
export function sessionCommand(text: string): SessionCommand | null {
  let s = fold(text);
  if (!s || s.length > 80) return null;
  // Repeated: "por favor, ELISE, ..." peels in more than one pass.
  for (let i = 0; i < 3; i++) s = s.replace(AROUND, "").trim();
  if (DISABLE.some((r) => r.test(s))) return "disable_wake";
  if (ENABLE.some((r) => r.test(s))) return "enable_wake";
  if (DAILY_SUMMARY.some((r) => r.test(s))) return "daily_summary";
  if (STOP.some((r) => r.test(s))) return "stop";
  if (SHOW.some((r) => r.test(s))) return "show";
  if (VOLUME_UP.some((r) => r.test(s))) return "volume_up";
  if (VOLUME_DOWN.some((r) => r.test(s))) return "volume_down";
  return null;
}

/**
 * "ELISE, iniciá una nueva conversación", "empecemos de cero", "abrí un chat nuevo": the whole
 * message asks for a fresh conversation. Decided before the agent (typed or spoken), like the
 * commands above; "¿cómo inicio una nueva conversación?" is a question, not this.
 */
const NEW_CHAT = [
  /^(?:(?:quiero|queria|vamos a|podes|podrias|necesito|me gustaria|dale) )?(?:inicia|inicias|iniciemos|iniciar|empeza|empezas|empecemos|empezar|arranca|arrancas|arranquemos|arrancar|abri|abrime|abrir|crea|crear|comenza|comencemos|comenzar|nueva|otra|pasemos a|vamos con)? ?(?:una |un |otra |otro )?(?:nueva |nuevo )?(?:conversacion|charla|chat|sesion)(?: nueva| nuevo| desde cero| de cero| en limpio)?$/,
  /^(?:(?:podes|podrias|quiero) )?(?:reinicia|reiniciar|resetea|resetear) (?:la |el |esta |este )?(?:conversacion|charla|chat)$/,
  /^(?:empecemos|empeza|arranquemos|arranca|comencemos|empezamos) (?:de|desde) cero$/,
  /^(?:nueva conversacion|nuevo chat|chat nuevo|conversacion nueva)$/,
  /^(?:start|begin|open) (?:a )?(?:new|fresh) (?:conversation|chat)$/,
  /^(?:new (?:conversation|chat)|let s start over|start over)$/,
];

export function asksNewConversation(text: string): boolean {
  let s = fold(text);
  if (!s || s.length > 80) return false;
  for (let i = 0; i < 3; i++) s = s.replace(AROUND, "").trim();
  return NEW_CHAT.some((r) => r.test(s));
}
