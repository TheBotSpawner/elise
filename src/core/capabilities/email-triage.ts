import { noiseSignals, type EmailMessage, type FollowUp } from "./email";
import type { ProviderKey } from "../providers/types";

/**
 * Email triage (ADR-067): which emails of one account deserve the user's attention, and in what
 * order. Deterministic: explainable signals from metadata (subject, snippet, sender, headers,
 * thread direction) become a score, a level and reason codes. Filtering, dedupe, order and caps
 * are decided here, never by a model. Provider-independent: Gmail and Outlook map into
 * EmailMessage first.
 */

export type EmailPriorityLevel = "high" | "medium" | "normal";
/** One status shown on a row: the most useful thing to know about it. */
export type EmailTriageStatus = "needs_reply" | "urgent" | "payment" | "waiting";

export interface EmailPriority {
  /** Internal only: never shown to the user. */
  score: number;
  level: EmailPriorityLevel;
  needsReply: boolean;
  waiting: boolean;
  paymentRelated: boolean;
  urgent: boolean;
  deadlineRelated: boolean;
  securityRelated: boolean;
  importantSender: boolean;
  noise: boolean;
  reasonCodes: string[];
}

/** One email (or thread) that may deserve attention, with what the thread direction says. */
export interface TriageCandidate {
  /** The latest relevant message of the thread (metadata, no body). */
  message: EmailMessage;
  followUp?: { kind: "needs_reply" | "waiting_on_others"; item: FollowUp } | null;
  /** The user wrote in this thread before (a known correspondent). */
  knownContact?: boolean;
}

export interface TriagedEmail {
  message: EmailMessage;
  priority: EmailPriority;
  status: EmailTriageStatus | null;
  followUp: "needs_reply" | "waiting_on_others" | null;
}

/** The account a group of emails belongs to: the same identity Connections shows. */
export interface MailboxIdentity {
  connectionId: string;
  providerKey: ProviderKey;
  /** The name the user gave the account in ELISE ("Empresa", "Personal"). */
  label: string;
  /** The account's address, secondary metadata. */
  address: string | null;
}

/** How a triaged email travels in a result: by message id, with what the triage decided. */
export interface EmailTriageItem {
  messageId: string;
  level: EmailPriorityLevel;
  status: EmailTriageStatus | null;
  reasons: string[];
}

/** One account's triage, as a result carries it. */
export interface EmailTriageGroup {
  account: MailboxIdentity;
  items: EmailTriageItem[];
}

/** At most this many per account; usually 3–5. */
export const TRIAGE_MAX = 10;
/** Below this many, "normal" emails may fill in; above it, only high and medium. */
export const TRIAGE_SOFT = 5;
/** Below this score an email isn't worth the brief. */
export const TRIAGE_MIN_SCORE = 20;

const PAYMENT =
  /\b(factura|facturas|invoice|pago|pagos|payment|cobro|cargo|charge|billing|facturaci[oó]n|recibo|receipt|vencimiento|vence|due|overdue|renovaci[oó]n|renewal|suscripci[oó]n|subscription|transferencia|deuda|saldo)\b/i;
/** A payment that already happened: still worth a line, not a priority. */
const SETTLED =
  /\b(se ha pagado|ha sido pagad[oa]|se ha cobrado|pagad[oa]|paid|payment received|pago recibido|gracias por tu (pago|compra)|thank you for your (payment|purchase|order)|receipt for)\b/i;
const SECURITY =
  /\b(seguridad|security|contraseña|password|verificaci[oó]n|verification|c[oó]digo de acceso|2fa|two-factor|inicio de sesi[oó]n|sign-?in|log-?in attempt|suspicious|sospechos[oa]|unauthori[sz]ed|breach|dominio|domain expir\w*)\b/i;
const URGENT =
  /\b(urgente|urgent|asap|cuanto antes|inmediat\w*|immediately|cr[ií]tic[oa]|critical|action required|acci[oó]n requerida|requiere acci[oó]n|ca[ií]d[oa]|down|outage|error|errores|fall[oó]|failed|failure|issue|issues|problema|problem|incidente|incident|alerta|alert)\b/i;
const DEADLINE =
  /\b(deadline|plazo|fecha l[ií]mite|hoy|today|mañana|tomorrow|vence|vencimiento|expira|expires?|expiring|antes del|by (monday|tuesday|wednesday|thursday|friday|eod|end of day))\b/i;
const CHANGE =
  /\b(cambio|cambios|cancelad[oa]|cancelaci[oó]n|cancel+ed|cancel+ation|reprogramad[oa]|reschedul\w*|postpon\w*|suspendid[oa]|suspended)\b/i;
const MEETING = /\b(reuni[oó]n|meeting|clase|call|llamada|invitaci[oó]n|invitation|entrevista)\b/i;
/** Marketing, digests and notices: noise unless something operational says otherwise. */
const PROMO =
  /(\d{1,2}\s?%\s?(off|dto|de descuento)|\bdescuentos?\b|\bdiscount\b|\bofertas?\b|\boffer\b|\bsale\b|\bpromo(ci[oó]n)?\b|\bnewsletter\b|\bwebinar\b|black friday|cyber ?monday|\bcup[oó]n\b|\bcoupon\b|\bgratis\b|free trial|\bnovedades\b|resumen (semanal|mensual)|weekly (digest|summary|recap|report)|monthly (digest|summary|recap)|\bdigest\b|sub-?processors|privacy policy|pol[ií]tica de privacidad|terms of (service|use)|t[ée]rminos y condiciones|we('ve| have) updated|hemos actualizado)/i;
const MARKETING_SENDER =
  /^(hello|hi|hola|news|newsletter|marketing|info|team|updates?|promo(tions)?|offers?|deals|community|digest|contact)@/i;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*((re|fw|fwd|rv|aw|tr)\s*:\s*)+/i, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();

/** The score and the reasons behind it. Same email in, same priority out. */
export function scoreEmail(c: TriageCandidate, now: Date): EmailPriority {
  const m = c.message;
  const text = `${m.subject} ${m.snippet}`;
  const reasons: string[] = [];
  let score = 0;
  const add = (code: string, points: number) => {
    reasons.push(code);
    score += points;
  };

  const securityRelated = SECURITY.test(text);
  const paymentRelated = PAYMENT.test(text);
  const settled = paymentRelated && SETTLED.test(text);
  const urgent = URGENT.test(text);
  const deadlineRelated = DEADLINE.test(text);
  const change = CHANGE.test(text);
  const operational =
    securityRelated || (paymentRelated && !settled) || urgent || deadlineRelated || change;

  // Noise: promotions and social never; automated or list mail only when nothing operational
  // is in it (an invoice, a security alert, a failed service still count).
  const signals = noiseSignals(m);
  const promoTab = m.category === "promotions" || m.category === "social";
  const automated =
    signals.length > 0 ||
    Boolean(m.from && MARKETING_SENDER.test(m.from.email)) ||
    PROMO.test(text);
  const noise =
    (promoTab && !securityRelated) ||
    (PROMO.test(text) && !securityRelated) ||
    (automated && !operational);

  const needsReply = c.followUp?.kind === "needs_reply";
  const waiting = c.followUp?.kind === "waiting_on_others";
  if (needsReply) {
    add("needs_reply", 40);
    const conf = c.followUp!.item.confidence;
    if (conf !== "low") add(`reply_${conf}`, conf === "high" ? 10 : 5);
    const hours = (now.getTime() - Date.parse(c.followUp!.item.lastMessageAt)) / 3_600_000;
    if (hours >= 48) add("aging", 5);
  }
  if (waiting) add("waiting", 15);
  if (securityRelated) add("security", 25);
  if (paymentRelated) add(settled ? "payment_settled" : "payment", settled ? 5 : 20);
  if (urgent) add("urgent", 20);
  if (deadlineRelated) add("deadline", 15);
  if (change) add("change", 15);
  if (MEETING.test(text)) add("meeting", 8);
  if (m.important) add("important_sender", 10);
  if (c.knownContact && !waiting) add("known_contact", 10);
  if (!m.fromMe && !m.bulk && m.to.length + m.cc.length <= 3 && !automated) add("direct", 10);
  if (m.unread) add("unread", 5);
  const age = (now.getTime() - Date.parse(m.date)) / 3_600_000;
  if (age <= 24) add("recent", 8);
  else if (age <= 72) add("recent", 4);

  const level: EmailPriorityLevel = score >= 60 ? "high" : score >= 35 ? "medium" : "normal";
  return {
    score,
    level,
    needsReply,
    waiting,
    paymentRelated,
    urgent,
    deadlineRelated,
    securityRelated,
    importantSender: m.important || Boolean(c.knownContact),
    noise,
    reasonCodes: noise ? ["noise", ...reasons] : reasons,
  };
}

function statusOf(p: EmailPriority): EmailTriageStatus | null {
  if (p.needsReply) return "needs_reply";
  if (p.urgent || p.securityRelated) return "urgent";
  if (p.paymentRelated && p.reasonCodes.includes("payment")) return "payment";
  if (p.waiting) return "waiting";
  return null;
}

/**
 * One account's emails worth the user's attention, most important first: noise out, one row per
 * thread and per repeated notice, 3–5 usually, never more than `max`, and never padded — two
 * relevant emails stay two.
 */
export function triageAccount(
  candidates: readonly TriageCandidate[],
  now: Date,
  max = TRIAGE_MAX,
): TriagedEmail[] {
  // One candidate per thread: the follow-up (thread direction) wins, the latest message second.
  const byThread = new Map<string, TriageCandidate>();
  for (const c of candidates) {
    if (c.message.fromMe && c.followUp?.kind !== "waiting_on_others") continue;
    const seen = byThread.get(c.message.threadId);
    const better =
      !seen ||
      (c.followUp && !seen.followUp) ||
      (!seen.followUp && !c.followUp && c.message.date > seen.message.date);
    if (better)
      byThread.set(c.message.threadId, {
        ...c,
        knownContact: c.knownContact || seen?.knownContact,
      });
  }
  const scored = [...byThread.values()]
    .map((c) => ({ c, p: scoreEmail(c, now) }))
    .filter(({ p }) => !p.noise && p.score >= TRIAGE_MIN_SCORE)
    .sort(
      (a, b) =>
        b.p.score - a.p.score ||
        b.c.message.date.localeCompare(a.c.message.date) ||
        a.c.message.id.localeCompare(b.c.message.id),
    );
  // Repeated notices ("Error on LL", twice) are one row: the best-ranked one.
  const subjects = new Set<string>();
  const out: TriagedEmail[] = [];
  for (const { c, p } of scored) {
    const key = `${(c.message.from?.email ?? "").toLowerCase()}|${norm(c.message.subject)}`;
    if (subjects.has(key)) continue;
    if (out.length >= max) break;
    if (p.level === "normal" && out.length >= TRIAGE_SOFT) break;
    subjects.add(key);
    out.push({
      message: c.message,
      priority: p,
      status: statusOf(p),
      followUp: c.followUp?.kind ?? null,
    });
  }
  return out;
}
