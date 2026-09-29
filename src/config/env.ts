/**
 * Reads are lazy (at call time), so the app builds without credentials.
 * Client code must pass `process.env.NEXT_PUBLIC_*` literally so Next.js can inline it.
 */
export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}. See .env.example.`);
  }
  return value;
}
