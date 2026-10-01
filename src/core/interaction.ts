/**
 * Where an interaction's turns live (ADR-012/014). A typed conversation is a History thread;
 * a voice session is an interaction session without one. Both run the same ELISE and have
 * their own Live Workspace. Shared by server and browser.
 */
export type ThreadRef = { kind: "conversation"; id: string } | { kind: "session"; id: string };

export type TurnModality = "text" | "voice";

/** Facts about a spoken turn — never the audio itself. */
export interface VoiceTurnMeta {
  durationMs: number;
  language: "es" | "en" | null;
  /** What this browser can do for the wake phrase (so ELISE never claims it works). */
  wake?: "off" | "unsupported" | "downloadable" | "installing" | "ready" | "listening" | "failed";
}

export const threadUrl = (t: ThreadRef) =>
  t.kind === "conversation" ? `/chat/${t.id}` : `/?session=${t.id}`;

export const sameThread = (a: ThreadRef | null, b: ThreadRef | null) =>
  Boolean(a && b && a.kind === b.kind && a.id === b.id);
