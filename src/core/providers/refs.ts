/**
 * Canonical IDs for items that live in an external provider (a Google task, a calendar event).
 * The reference names the connection it belongs to, so follow-up writes ("complete that task")
 * are routed to the exact account that holds the item. The connection is still validated
 * against the workspace's bindings before any call — a reference grants nothing by itself.
 *
 * Format: x:{connectionId}:{part}:{part}… with URI-encoded parts.
 */
const PREFIX = "x";

export function makeExternalRef(connectionId: string, ...parts: string[]): string {
  return [PREFIX, connectionId, ...parts.map(encodeURIComponent)].join(":");
}

export function parseExternalRef(ref: string): { connectionId: string; parts: string[] } | null {
  const segments = ref.split(":");
  if (segments.length < 3 || segments[0] !== PREFIX) return null;
  const [, connectionId, ...parts] = segments;
  if (!connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  try {
    return { connectionId, parts: parts.map(decodeURIComponent) };
  } catch {
    return null;
  }
}
