/**
 * Chat attachments (ADR-031): files the user gives ONE message ("use this in this turn") —
 * never Knowledge sources unless the user later asks to save them. One configuration for the
 * browser (early, friendly checks) and the server (authoritative: real bytes, real size).
 */

export type AttachmentKind = "document" | "image";

/** Draft lifecycle in the composer; only READY attachments travel with a message. */
export type AttachmentStatus = "local" | "uploading" | "ready" | "failed" | "removed";

export const ATTACHMENT_TYPES: Record<string, { kind: AttachmentKind; ext: readonly string[] }> = {
  "application/pdf": { kind: "document", ext: ["pdf"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "document",
    ext: ["docx"],
  },
  "text/plain": { kind: "document", ext: ["txt"] },
  "text/markdown": { kind: "document", ext: ["md", "markdown"] },
  "text/csv": { kind: "document", ext: ["csv"] },
  "text/html": { kind: "document", ext: ["html", "htm"] },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "document",
    ext: ["xlsx"],
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    kind: "document",
    ext: ["pptx"],
  },
  "image/png": { kind: "image", ext: ["png"] },
  "image/jpeg": { kind: "image", ext: ["jpg", "jpeg"] },
  "image/webp": { kind: "image", ext: ["webp"] },
  "image/gif": { kind: "image", ext: ["gif"] },
};

export const ATTACHMENT_LIMITS = {
  /** Documents (the bucket enforces the same ceiling). */
  maxBytes: 20 * 1024 * 1024,
  /** Images go to the model inline: smaller. */
  maxImageBytes: 8 * 1024 * 1024,
  perMessage: 8,
  /** Text read from one document into the turn (the model gets passages, not books). */
  maxTextChars: 40_000,
  /** Staged but never sent: removed after this. */
  stagedTtlMs: 24 * 3_600_000,
} as const;

/** The type a file claims, by extension (browsers' MIME guesses vary; the server re-checks bytes). */
export function attachmentType(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return Object.entries(ATTACHMENT_TYPES).find(([, t]) => t.ext.includes(ext))?.[0] ?? null;
}

export type AttachmentProblem = "unsupported" | "too_large" | "empty";

/** Early check (browser) — the server repeats it against the stored bytes. */
export function checkAttachment(file: { name: string; size: number }): AttachmentProblem | null {
  const type = attachmentType(file.name);
  if (!type) return "unsupported";
  if (file.size === 0) return "empty";
  const max =
    ATTACHMENT_TYPES[type]!.kind === "image"
      ? ATTACHMENT_LIMITS.maxImageBytes
      : ATTACHMENT_LIMITS.maxBytes;
  return file.size > max ? "too_large" : null;
}

/** Does an image's content really match its type (magic bytes)? Never trust the name. */
export function imageMatchesType(mime: string, data: Uint8Array): boolean {
  const b = (i: number) => data[i];
  switch (mime) {
    case "image/png":
      return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
    case "image/jpeg":
      return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case "image/gif":
      return b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46;
    case "image/webp":
      return (
        String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
        String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
      );
    default:
      return false;
  }
}

/** What a sent message keeps of its attachments (transcript chips, provenance). */
export interface SentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
