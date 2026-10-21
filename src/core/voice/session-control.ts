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

export type SessionCommand = "stop" | "disable_wake" | "show" | "volume_up" | "volume_down";

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
];

const DISABLE = [
  /^(?:desactiva|desactive|apaga|apague|deshabilita|deshabilite) (?:la |el )?(?:activacion por voz|palabra de activacion|escucha(?: de| de elise| en segundo plano)?|modo escucha|wake word)$/,
  /^no (?:me )?(?:escuches|vuelvas a escuchar)(?: mas)? hasta que (?:te )?(?:lo )?(?:active|activo|diga|digo|llame|vuelva a activar)$/,
  /^(?:deja|para) de escuchar hasta que (?:te )?(?:lo )?(?:active|activo|diga|digo|vuelva a activar)$/,
  /^(?:turn off|disable) (?:the )?(?:wake word|voice activation)$/,
];

/** Bring the app to the front: about ELISE herself, never "mostrame mis tareas". */
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
  if (STOP.some((r) => r.test(s))) return "stop";
  if (SHOW.some((r) => r.test(s))) return "show";
  if (VOLUME_UP.some((r) => r.test(s))) return "volume_up";
  if (VOLUME_DOWN.some((r) => r.test(s))) return "volume_down";
  return null;
}
