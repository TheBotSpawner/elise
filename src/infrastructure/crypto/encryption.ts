import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { AppError } from "@/core/errors";

/**
 * Application-level encryption for secrets at rest (OAuth tokens, PKCE verifiers).
 * AES-256-GCM with a random 96-bit IV per value. `context` is bound as additional
 * authenticated data, so a ciphertext copied to another row/connection fails to decrypt.
 *
 * Keys: ELISE_ENCRYPTION_KEY (current, 32 bytes base64) and optionally
 * ELISE_ENCRYPTION_KEY_PREVIOUS (still accepted for decryption during rotation).
 * Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url).
 */
interface Key {
  id: string;
  bytes: Buffer;
}

function parseKey(raw: string, name: string): Key {
  const bytes = Buffer.from(raw.trim(), "base64");
  if (bytes.length !== 32) {
    throw new AppError("INTERNAL_ERROR", `${name} must be 32 bytes encoded as base64`);
  }
  return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 8), bytes };
}

export interface Keyring {
  current: Key;
  all: Key[];
}

export function keyringFromEnv(env: Record<string, string | undefined> = process.env): Keyring {
  const current = env.ELISE_ENCRYPTION_KEY;
  if (!current) {
    throw new AppError("CAPABILITY_UNAVAILABLE", "ELISE_ENCRYPTION_KEY is not configured", {
      recovery: "configure",
    });
  }
  const key = parseKey(current, "ELISE_ENCRYPTION_KEY");
  const previous = env.ELISE_ENCRYPTION_KEY_PREVIOUS
    ? [parseKey(env.ELISE_ENCRYPTION_KEY_PREVIOUS, "ELISE_ENCRYPTION_KEY_PREVIOUS")]
    : [];
  return { current: key, all: [key, ...previous] };
}

export function encrypt(
  plaintext: string,
  context: string,
  keyring: Keyring = keyringFromEnv(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyring.current.bytes, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    keyring.current.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decrypt(
  payload: string,
  context: string,
  keyring: Keyring = keyringFromEnv(),
): string {
  const [version, keyId, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !keyId || !iv || !tag || ciphertext === undefined) {
    throw new AppError("INTERNAL_ERROR", "Unrecognized encrypted payload");
  }
  const key = keyring.all.find((k) => k.id === keyId);
  if (!key) throw new AppError("INTERNAL_ERROR", "Encrypted with an unknown key");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", "Encrypted payload failed authentication", { cause });
  }
}

/** True when the value was encrypted with an older key and should be re-encrypted. */
export function needsRotation(payload: string, keyring: Keyring = keyringFromEnv()): boolean {
  return payload.split(".")[1] !== keyring.current.id;
}
