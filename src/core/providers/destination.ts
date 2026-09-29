import { z } from "zod";

/**
 * Optional, model-facing account selector shared by every capability tool. The model names an
 * account in the user's words ("Firbot", "Google", "ELISE", an email); the resolver maps it to a
 * connection deterministically. It is never a credential or an internal id.
 */
export const destinationField = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .optional()
  .describe(
    'Only when the user names where this should happen (e.g. "Google", "ELISE", "Firbot"). Use the account names listed in your context. Omit to use the default.',
  );

export function readDestination(input: unknown): string | null {
  if (input && typeof input === "object" && "destination" in input) {
    const value = (input as { destination?: unknown }).destination;
    return typeof value === "string" && value.trim() ? value : null;
  }
  return null;
}
