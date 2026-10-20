import { addDays, toLocalDateTime, zonedDateTimeToUtc } from "../time";

/**
 * Alarms (ADR-100): a fixed local time — once, or on chosen weekdays — in the user's IANA
 * timezone. Pure and deterministic: the server decides when an alarm is due and every device
 * only rings what the server says is ringing. The model never computes a time.
 *
 * Different from a timer (a duration, ADR-045) and from a Schedule (an AI run, ADR-006): an
 * alarm's firing is a cheap state change plus a sound on the devices the user chose.
 */

export const ALARM_STATES = ["scheduled", "ringing", "snoozed", "done", "off"] as const;
export type AlarmState = (typeof ALARM_STATES)[number];

export const OCCURRENCE_STATUSES = [
  "ringing",
  "snoozed",
  "dismissed",
  "missed",
  "expired",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** Where an alarm rings: a registered browser, or an ELISE Desktop installation. */
export const DESTINATION_KINDS = ["browser", "desktop"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];
export interface AlarmDestination {
  kind: DestinationKind;
  /** The browser endpoint's id, or the Desktop installation id. */
  id: string;
}

export interface Alarm {
  id: string;
  label: string | null;
  /** Local wall-clock "HH:mm". */
  time: string;
  /** A one-off alarm's local date (YYYY-MM-DD); null when it repeats. */
  date: string | null;
  /** Repeating alarm: weekdays 0 (Sunday) … 6 (Saturday); empty when it's a one-off. */
  weekdays: number[];
  timezone: string;
  enabled: boolean;
  /** A bundled sound key or "upload:<id>"; null = the user's default. */
  sound: string | null;
  snoozeMinutes: number;
  destinations: AlarmDestination[];
  state: AlarmState;
  nextFireAt: string | null;
  snoozedUntil: string | null;
  version: number;
}

export const ALARM_LIMITS = {
  maxAlarms: 50,
  maxDestinations: 10,
  minSnooze: 1,
  maxSnooze: 60,
  defaultSnooze: 9,
  /** A ringing alarm stops by itself after this, on every device (failsafe). */
  ringMs: 10 * 60_000,
  /** Found due this late (a missed run, a sleeping server): it still rings. Older: missed. */
  lateGraceMs: 15 * 60_000,
} as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (s: string) => HHMM.test(s);

/**
 * The instant of a local date + time in a timezone. A time the clock skips (spring forward)
 * rings at the first moment that exists after it; a repeated hour (fall back) rings once, the
 * first time.
 */
export function localInstant(date: string, time: string, timezone: string): Date {
  const at = zonedDateTimeToUtc(`${date}T${time}`, timezone);
  const back = toLocalDateTime(at, timezone);
  if (back === `${date}T${time}`) {
    // Fall back: the same wall time exists twice; prefer the earlier instant.
    const hourEarlier = new Date(at.getTime() - 3_600_000);
    return toLocalDateTime(hourEarlier, timezone) === back ? hourEarlier : at;
  }
  // Spring forward: the wall time doesn't exist; the next minute that does.
  for (let m = 1; m <= 120; m++) {
    const probe = new Date(at.getTime() - 3_600_000 + m * 60_000);
    if (toLocalDateTime(probe, timezone) > `${date}T${time}`) return probe;
  }
  return at;
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The next time an alarm fires strictly after `after`, or null (a past one-off, an empty repeat). */
export function nextFire(
  a: Pick<Alarm, "time" | "date" | "weekdays" | "timezone">,
  after: Date,
): Date | null {
  if (a.date) {
    const at = localInstant(a.date, a.time, a.timezone);
    return at > after ? at : null;
  }
  if (!a.weekdays.length) return null;
  const today = toLocalDateTime(after, a.timezone).slice(0, 10);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    if (!a.weekdays.includes(weekdayOf(day))) continue;
    const at = localInstant(day, a.time, a.timezone);
    if (at > after) return at;
  }
  return null;
}

/** What to do with an alarm whose `nextFireAt` has come, found at `now`. */
export function dueDecision(nextFireAt: Date, now: Date): "early" | "ring" | "missed" {
  const late = now.getTime() - nextFireAt.getTime();
  if (late < 0) return "early";
  return late <= ALARM_LIMITS.lateGraceMs ? "ring" : "missed";
}

/** Whether an occurrence that started ringing at `since` should still sound at `now`. */
export const stillRinging = (since: Date, now: Date) =>
  now.getTime() - since.getTime() < ALARM_LIMITS.ringMs;

// ── Destinations ─────────────────────────────────────────────────────────────

/** A destination's live status: presence is a hint, never a promise that sound will play. */
export interface DestinationStatus {
  kind: DestinationKind;
  id: string;
  name: string;
  /** Seen recently (open browser tab / running Desktop). */
  online: boolean;
  lastSeenAt: string | null;
}

/** Seen within this long: online. Desktop beats every 10 s, an open browser every minute. */
export const ONLINE_MS = 3 * 60_000;

export const isOnline = (lastSeenAt: string | null, now: Date) =>
  lastSeenAt !== null && now.getTime() - Date.parse(lastSeenAt) <= ONLINE_MS;

/**
 * What an alarm can honestly promise: which chosen destinations exist and are online now, and
 * which are registered but not. Never a destination the user didn't choose.
 */
export function deliveryCheck(
  chosen: readonly AlarmDestination[],
  known: readonly DestinationStatus[],
): { ready: DestinationStatus[]; offline: DestinationStatus[]; unknown: AlarmDestination[] } {
  const ready: DestinationStatus[] = [];
  const offline: DestinationStatus[] = [];
  const unknown: AlarmDestination[] = [];
  for (const d of chosen) {
    const k = known.find((x) => x.kind === d.kind && x.id === d.id);
    if (!k) unknown.push(d);
    else (k.online ? ready : offline).push(k);
  }
  return { ready, offline, unknown };
}

// ── Sounds ───────────────────────────────────────────────────────────────────

/**
 * ELISE's own alarm sounds: synthesized on the device from these notes (no file, nothing to
 * license — they are original). Each repeats until the alarm is stopped or snoozed.
 */
export const ALARM_SOUNDS = {
  elise: { name: "ELISE", notes: [659.25, 880, 1318.5], step: 0.16, wave: "sine", every: 1.6 },
  brisa: {
    name: "Brisa",
    notes: [523.25, 659.25, 783.99, 659.25],
    step: 0.22,
    wave: "sine",
    every: 2.2,
  },
  amanecer: {
    name: "Amanecer",
    notes: [392, 493.88, 587.33, 783.99],
    step: 0.3,
    wave: "triangle",
    every: 2.6,
  },
  campana: { name: "Campana", notes: [880, 1108.73], step: 0.5, wave: "sine", every: 2 },
  pulso: { name: "Pulso", notes: [988, 988, 988], step: 0.14, wave: "square", every: 1.2 },
} as const;
export type BundledSound = keyof typeof ALARM_SOUNDS;
export const BUNDLED_SOUNDS = Object.keys(ALARM_SOUNDS) as BundledSound[];
export const DEFAULT_ALARM_SOUND: BundledSound = "brisa";

export const isBundledSound = (s: string): s is BundledSound =>
  (BUNDLED_SOUNDS as string[]).includes(s);
export const uploadSoundId = (s: string | null) =>
  s?.startsWith("upload:") ? s.slice("upload:".length) : null;

/** The sound an alarm plays: its own, else the user's default, else ELISE's default. */
export const soundOf = (alarm: Pick<Alarm, "sound">, userDefault: string | null) =>
  alarm.sound ?? userDefault ?? DEFAULT_ALARM_SOUND;

// ── Uploaded sounds ──────────────────────────────────────────────────────────

export const UPLOAD_LIMITS = { maxBytes: 2 * 1024 * 1024, maxSounds: 10 } as const;

/** The audio types ELISE accepts, recognized by their first bytes (never by name or header). */
export function sniffAudio(
  bytes: Uint8Array,
): "audio/mpeg" | "audio/ogg" | "audio/wav" | "audio/mp4" | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  if (bytes.length < 12) return null;
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
    return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  return null;
}

// ── The store the tools and pages use (implemented in application) ──────────

export interface NewAlarm {
  label: string | null;
  time: string;
  date: string | null;
  weekdays: number[];
  timezone: string;
  sound: string | null;
  snoozeMinutes: number;
  destinations: AlarmDestination[];
  provenance?: { conversationId?: string | null; sessionId?: string | null };
}

export type AlarmPatch = Partial<
  Pick<
    Alarm,
    "label" | "time" | "date" | "weekdays" | "enabled" | "sound" | "snoozeMinutes" | "destinations"
  >
>;

export interface AlarmOccurrence {
  id: string;
  alarmId: string;
  fireAt: string;
  status: OccurrenceStatus;
  ringingSince: string | null;
  snoozedUntil: string | null;
  label: string | null;
  sound: string | null;
  destinations: AlarmDestination[];
}

export interface SoundOption {
  key: string;
  name: string;
  kind: "bundled" | "upload";
}

export interface AlarmStore {
  listAlarms(): Promise<Alarm[]>;
  createAlarm(n: NewAlarm): Promise<Alarm>;
  changeAlarm(a: Alarm, patch: AlarmPatch): Promise<Alarm>;
  deleteAlarm(a: Alarm): Promise<void>;
  /** Ringing or snoozed right now (the failsafe already applied). */
  liveOccurrences(): Promise<AlarmOccurrence[]>;
  occurrenceAction(id: string, action: "snooze" | "dismiss"): Promise<AlarmOccurrence>;
  destinations(): Promise<DestinationStatus[]>;
  sounds(): Promise<SoundOption[]>;
  setDefaultSound(key: string): Promise<void>;
  setDefaultDestinations(d: AlarmDestination[]): Promise<void>;
}

/** The alarm's next state after a change: re-armed from now, or off. */
export function armed(
  a: Pick<Alarm, "time" | "date" | "weekdays" | "timezone" | "enabled">,
  now: Date,
): { state: AlarmState; nextFireAt: string | null } {
  if (!a.enabled) return { state: "off", nextFireAt: null };
  const next = nextFire(a, now);
  return next
    ? { state: "scheduled", nextFireAt: next.toISOString() }
    : { state: "done", nextFireAt: null };
}
