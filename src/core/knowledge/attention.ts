/**
 * Why something in Knowledge needs attention, in the user's terms (ADR-037), and what can help.
 * Items store the error code and ELISE's own English message (status_detail); both are mapped
 * here, so a raw provider code is never what the user reads first.
 */
export type AttentionReason =
  | "reconnect"
  | "access_lost"
  | "no_text"
  | "scanned_no_ocr"
  | "ocr_failed"
  | "too_large"
  | "unsupported"
  | "mismatch"
  | "corrupt"
  | "stalled"
  | "timeout"
  | "unreachable"
  | "unknown";

export type AttentionAction = "retry" | "reconnect" | "open";

const BY_MESSAGE: [RegExp, AttentionReason][] = [
  [/text recognition \(OCR\) isn't set up/i, "scanned_no_ocr"],
  [/even with text recognition/i, "ocr_failed"],
  [/too large to read/i, "too_large"],
  [/no readable text/i, "no_text"],
  [/can't read this file type/i, "unsupported"],
  [/doesn't match its type/i, "mismatch"],
  [/damaged or protected/i, "corrupt"],
  [/no longer shared with ELISE/i, "access_lost"],
];

export function attentionReason(code: string | null, detail: string | null): AttentionReason {
  if (code === "AUTH_EXPIRED" || code === "AUTH_ERROR") return "reconnect";
  if (code === "PERMISSION_DENIED" || code === "NOT_FOUND") return "access_lost";
  if (
    code === "BACKGROUND_STALLED" ||
    code === "CAPABILITY_UNAVAILABLE" ||
    code === "SERVER_NOT_CONFIGURED"
  )
    return "stalled";
  if (code === "TIMEOUT") return "timeout";
  if (code === "PROVIDER_UNAVAILABLE" || code === "RATE_LIMITED") return "unreachable";
  for (const [pattern, reason] of BY_MESSAGE) if (detail && pattern.test(detail)) return reason;
  return "unknown";
}

/** Only actions that can help: retrying a file that has no text changes nothing. */
export function attentionActions(reason: AttentionReason): AttentionAction[] {
  switch (reason) {
    case "reconnect":
      return ["reconnect"];
    case "access_lost":
      return ["reconnect", "retry"];
    case "stalled":
    case "timeout":
    case "unreachable":
    case "unknown":
      return ["retry"];
    case "no_text":
    case "ocr_failed":
    case "scanned_no_ocr":
      return ["open", "retry"];
    case "too_large":
    case "unsupported":
    case "mismatch":
    case "corrupt":
      return ["open"];
  }
}
