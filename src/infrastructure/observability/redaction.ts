const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|refresh|session/i;
const SENSITIVE_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}\b/g, // Supabase keys
  /\btr_(dev|prod|stg)_[A-Za-z0-9]{8,}\b/g, // Trigger.dev keys
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, // JWTs
  /\bya29\.[A-Za-z0-9._-]{10,}/g, // Google access tokens
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh tokens
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google OAuth client secrets
  /\b(ntn|secret)_[A-Za-z0-9]{20,}\b/g, // Notion tokens and integration secrets
  /\btvly-[A-Za-z0-9_-]{10,}/g, // Tavily keys
];

const REDACTED = "[REDACTED]";

/** Removes secrets from anything headed to logs (docs/engineering/18 §79). */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") {
    return SENSITIVE_VALUE.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactSensitive(value.message, depth + 1) };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redactSensitive(v, depth + 1),
      ]),
    );
  }
  return value;
}
