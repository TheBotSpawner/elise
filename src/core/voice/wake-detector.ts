import type { WakeDecision } from "./wake-arbiter";

/**
 * The local wake word detector (ADR-095): a contract any device can implement — ELISE Desktop
 * today, a Home Hub (Linux ARM) later — so the word, its model and the engine are data, not code
 * scattered through the app. Detection is on the device; nothing is sent before the word.
 */

/** A wake word as data: rebranding is a new entry here and a new model, nothing else. */
export interface WakeWordModel {
  /** What people say ("ELISE"). */
  word: string;
  /**
   * What the recognizer outputs for it (its vocabulary's spellings): "elise" said in Spanish,
   * "elis" said the English way. Measured (ADR-095): adding "elis" took detection to 36/36 and
   * 23/24 on "Elís" clips, with 0/84 false accepts.
   */
  tokens: readonly string[];
  language: "es" | "en";
  engine: "vosk";
  /** Where the device loads it from (inside the app, never the network). */
  file: string;
  license: string;
  /**
   * Words the recognizer may choose instead (frequent Spanish words and near-sounding names):
   * with only "the word or anything else", it would hear the word in almost any speech.
   * Measured on synthetic Rioplatense speech (ADR-095): 2 choices → 83 % false accepts;
   * this list → 0 % on that set, 94 % detection in quiet.
   */
  competitors: readonly string[];
}

// Kept out of the grammar on purpose: rare words ("lis", "lisa", "lise") that only stole the
// word itself from the recognizer. "Elisa", "Eli", "Elías" stay: real names, real confusions.
const ES_COMPETITORS = [
  "a",
  "agua",
  "ahora",
  "al",
  "algo",
  "algunas",
  "algunos",
  "amiga",
  "amigo",
  "ante",
  "antes",
  "archivo",
  "ayer",
  "año",
  "bastante",
  "bien",
  "bueno",
  "casa",
  "casi",
  "chau",
  "che",
  "chicos",
  "cine",
  "como",
  "con",
  "contra",
  "cosa",
  "cosas",
  "cual",
  "cuando",
  "dale",
  "de",
  "decir",
  "del",
  "desde",
  "después",
  "dice",
  "dije",
  "dijo",
  "domingo",
  "donde",
  "durante",
  "día",
  "días",
  "e",
  "el",
  "elegir",
  "elegí",
  "elena",
  "eli",
  "elige",
  "eliminar",
  "elisa",
  "elisabet",
  "eliseo",
  "ella",
  "ellas",
  "elle",
  "ellos",
  "elías",
  "en",
  "entonces",
  "entre",
  "era",
  "eran",
  "eras",
  "es",
  "esa",
  "ese",
  "eso",
  "esta",
  "estamos",
  "estar",
  "estas",
  "este",
  "esto",
  "estos",
  "estoy",
  "está",
  "están",
  "estás",
  "esté",
  "facturas",
  "favor",
  "felices",
  "feliz",
  "fiestas",
  "fue",
  "fueron",
  "fui",
  "fuimos",
  "gas",
  "gente",
  "gracias",
  "hace",
  "hacer",
  "hago",
  "hasta",
  "hay",
  "hija",
  "hijo",
  "hizo",
  "hola",
  "hombre",
  "hoy",
  "ir",
  "jueves",
  "la",
  "las",
  "le",
  "les",
  "lo",
  "los",
  "lugar",
  "lunes",
  "luz",
  "madre",
  "mal",
  "martes",
  "mañana",
  "me",
  "mes",
  "mi",
  "mis",
  "miércoles",
  "mucho",
  "muchos",
  "mujer",
  "mundo",
  "muy",
  "más",
  "mí",
  "mía",
  "mío",
  "nada",
  "ni",
  "no",
  "noche",
  "nos",
  "nosotras",
  "nosotros",
  "nuestro",
  "nunca",
  "o",
  "os",
  "otra",
  "otras",
  "otro",
  "otros",
  "padre",
  "para",
  "parte",
  "partido",
  "perdón",
  "pero",
  "persona",
  "poco",
  "por",
  "porque",
  "problema",
  "que",
  "quien",
  "quienes",
  "qué",
  "se",
  "sea",
  "semana",
  "ser",
  "si",
  "siempre",
  "sin",
  "sobre",
  "sola",
  "solo",
  "somos",
  "son",
  "sos",
  "soy",
  "su",
  "sus",
  "suyo",
  "sábado",
  "sé",
  "sí",
  "también",
  "tanto",
  "tarde",
  "te",
  "tema",
  "tenemos",
  "tengo",
  "tenés",
  "tenía",
  "ti",
  "tiempo",
  "tiene",
  "tienen",
  "todavía",
  "todo",
  "todos",
  "trabajo",
  "tu",
  "tus",
  "tuve",
  "tuya",
  "tuyo",
  "tú",
  "un",
  "una",
  "uno",
  "unos",
  "va",
  "vamos",
  "van",
  "vas",
  "veo",
  "ver",
  "vez",
  "vida",
  "viernes",
  "vio",
  "vos",
  "vosotros",
  "voy",
  "y",
  "ya",
  "yo",
  "él",
  "éramos",
] as const;

/** The grammar the recognizer decodes with: the word, its competitors, or anything else. */
export const wakeGrammar = (m: WakeWordModel) => [...m.tokens, ...m.competitors, "[unk]"];

export const WAKE_MODELS: readonly WakeWordModel[] = [
  {
    word: "ELISE",
    tokens: ["elise", "elis"],
    language: "es",
    engine: "vosk",
    file: "vosk-model-small-es-0.42.tar.gz",
    license: "Apache-2.0",
    competitors: ES_COMPETITORS,
  },
];

export type DetectorState =
  | "stopped"
  | "loading"
  | "listening"
  | "capturing"
  /** A conversation has the floor: the microphone stays open (no Bluetooth "call" switching), nothing is heard. */
  | "held"
  | "no_microphone"
  | "mic_denied"
  | "model_failed";

/** What a detection hands over: the words around it, in memory only (16 kHz mono). */
export interface WakeCapture {
  /** From a moment before the word to the end of what followed it. */
  audio: Float32Array;
  sampleRate: number;
  /** Whether anything was said after the word (else it was the word alone). */
  speechAfter: boolean;
}

export interface WakeDetector {
  readonly state: DetectorState;
  /** Opens the microphone and listens until stop(); fires once per detection. */
  start(opts: {
    model: WakeWordModel;
    /** A candidate the arbiter accepted (ADR-108): its source, confidence and whether guarded. */
    onDetected: (decision: Extract<WakeDecision, { accept: true }>) => void;
    onCaptured: (capture: WakeCapture) => void;
    onState: (state: DetectorState) => void;
    /**
     * ADR-104: ELISE's own music is playing — the room's loudness says nothing about whether
     * someone speaks, so the recognizer hears everything (no energy gate), and after the word
     * the room is measured as it will be with the music lowered.
     */
    listenThrough?: () => boolean;
    /**
     * ADR-109: ELISE is answering. What the recognizer took as "the utterance" started with her
     * own voice, so a word confirmed without a time is captured from just before it.
     */
    overReply?: () => boolean;
  }): Promise<void>;
  /** Releases the microphone at once (a pause, a lock, the setting off). */
  stop(): void;
  /**
   * A conversation takes over: stop listening but keep the microphone open, so a Bluetooth
   * headset doesn't switch in and out of "call" mode (and beep) around every conversation.
   */
  hold(): void;
}

/**
 * ADR-108: whether the recognizer should hear a frame — a quieter bar than "speech" (EndOfSpeech),
 * so a voice from across the room reaches it. Before: 3× the room and at least -38 dBFS, which a
 * normal voice at 3 m (and often at 1.5 m) didn't pass. Measured: tests/unit/voice/wake-eval.test.ts.
 */
export const WAKE_GATE = { ratio: 2, min: 0.0035 } as const;
export const wakeGate = (rms: number, floor: number) =>
  rms > Math.max(floor * WAKE_GATE.ratio, WAKE_GATE.min);

/**
 * The end of what someone says after the word, from frame energies (RMS, 0..1): speech is well
 * above the room's floor; the utterance ends after `quietFrames` quiet frames in a row, or when
 * it runs too long. Pure: the detector feeds it, tests drive it.
 */
export class EndOfSpeech {
  private floor = 0.004;
  private spoke = false;
  private quiet = 0;
  private frames = 0;
  constructor(private readonly opts = { quietFrames: 7, wordOnlyFrames: 11, maxFrames: 70 }) {}
  /** Before the word: learn the room. */
  learn(rms: number) {
    this.floor = this.floor * 0.95 + Math.min(rms, 0.05) * 0.05;
  }
  /** The room just got quieter by this factor (ELISE lowered her music): speech is relative. */
  scaleFloor(factor: number) {
    this.floor = Math.max(0.004, this.floor * factor);
  }
  /** The room's level as learned (diagnostics, the wake gate). */
  get roomFloor() {
    return this.floor;
  }
  /** Whether a frame sounds like speech in this room. */
  speech(rms: number) {
    return rms > Math.max(this.floor * 3, 0.012);
  }
  /** After the word: true when the utterance is over. */
  push(rms: number): boolean {
    this.frames++;
    const speech = this.speech(rms);
    if (speech) {
      this.spoke = true;
      this.quiet = 0;
    } else this.quiet++;
    if (this.frames >= this.opts.maxFrames) return true;
    return this.spoke
      ? this.quiet >= this.opts.quietFrames
      : this.quiet >= this.opts.wordOnlyFrames;
  }
  get speechAfter() {
    return this.spoke;
  }
  reset() {
    this.spoke = false;
    this.quiet = 0;
    this.frames = 0;
  }
}

/** "Abrí ELISE", "mostrame esto en pantalla": the only words that bring the window up. */
export function asksToShow(remainder: string): boolean {
  const t = remainder.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return (
    /\b(abri|abrime|abrir|mostra|mostrame|mostrar|traeme|trae)\b.*\b(ventana|pantalla|app|aplicacion|elise)\b/.test(
      t,
    ) || /^(abri|abrite|abrime)\b/.test(t)
  );
}
