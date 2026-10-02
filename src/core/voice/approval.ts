/**
 * Spoken approvals (ADR-017 §16). A "sí" approves only when it can mean exactly one thing:
 * one pending approval, requested by this interaction's previous reply, minutes ago, for this
 * user. Everything else falls back to conversation — security over convenience.
 */

export type ApprovalIntent = "approve" | "reject";

const APPROVE = new Set(
  (
    "si sí dale ok okay confirmo confirmalo confirmado aprobalo apruebo aprobado aprobar " +
    "envialo enviala mandalo mandala hacelo hazlo adelante listo yes yeah yep approve approved " +
    "confirm go ahead send it do it please por favor claro " +
    // Saying the action itself confirms it ("sí, borrala"); the binding still needs exactly one
    // pending approval of this interaction.
    "borralo borrala borralos eliminalo eliminala agendalo agendala crealo creala guardalo " +
    "guardala invitalo invitala publicalo delete remove"
  ).split(" "),
);
const REJECT = new Set(
  (
    "no nop cancelalo cancelala cancela cancelar dejalo dejala deja olvidalo mejor no gracias " +
    "rechazalo rechazar cancel reject stop dont don't nope never mind nevermind"
  ).split(" "),
);
/** Filler that may accompany either ("sí, por favor", "no, dejalo"). */
const FILLER = new Set(["por", "favor", "please", "gracias", "it", "lo", "eso", "the", "email"]);

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/'/g, "")
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);

/**
 * The whole utterance is an approval or a rejection — nothing else in it. "Sí, pero cambiá el
 * asunto" is a new instruction, not an approval.
 */
export function approvalIntent(text: string): ApprovalIntent | null {
  const t = tokens(text);
  if (!t.length || t.length > 5) return null;
  const meaningful = t.filter((w) => !FILLER.has(w));
  if (!meaningful.length) return null;
  if (meaningful.every((w) => APPROVE.has(w))) return "approve";
  if (meaningful.every((w) => REJECT.has(w) || w === "no")) return "reject";
  return null;
}

export interface PendingForVoice {
  id: string;
  summary: string;
  createdAt: string;
  /** Requested by a run of this same interaction (conversation or voice session). */
  sameInteraction: boolean;
  /** Requested by the interaction's most recent reply ("expected response context"). */
  fromLastReply: boolean;
}

export const VOICE_APPROVAL_WINDOW_MS = 5 * 60_000;

export type VoiceApprovalBinding =
  | { kind: "resolve"; approvalId: string; summary: string; decision: "approved" | "rejected" }
  | { kind: "ask"; count: number }
  | { kind: "none" };

export function bindVoiceApproval(input: {
  text: string;
  modality: "text" | "voice";
  pending: PendingForVoice[];
  now: Date;
}): VoiceApprovalBinding {
  if (input.modality !== "voice") return { kind: "none" };
  const intent = approvalIntent(input.text);
  if (!intent) return { kind: "none" };
  const relevant = input.pending.filter(
    (p) =>
      p.sameInteraction &&
      input.now.getTime() - Date.parse(p.createdAt) <= VOICE_APPROVAL_WINDOW_MS,
  );
  if (relevant.length > 1) return { kind: "ask", count: relevant.length };
  const only = relevant[0];
  if (!only || !only.fromLastReply) return { kind: "none" };
  return {
    kind: "resolve",
    approvalId: only.id,
    summary: only.summary,
    decision: intent === "approve" ? "approved" : "rejected",
  };
}
