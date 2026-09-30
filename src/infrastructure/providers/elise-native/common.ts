import { AppError } from "@/core/errors";

export function check(error: { message: string; code?: string } | null, what: string) {
  if (!error) return;
  // Same-workspace guards and check constraints surface as validation errors the model can fix.
  if (error.code === "23514" || error.code === "P0001" || error.code === "23503") {
    throw new AppError("VALIDATION_ERROR", `Could not ${what}: invalid values`, {
      recovery: "review",
      cause: error,
    });
  }
  throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Deterministic lookup by id, exact name, then partial name ("gym" → "Gym 🏋️", "running" →
 * "Run"). Several matches are returned so the caller asks instead of guessing.
 */
export function byNameOrId<T extends { id: string }>(
  items: T[],
  ref: string,
  name: (t: T) => string,
): T[] {
  const byId = items.filter((i) => i.id === ref);
  if (byId.length) return byId;
  const wanted = norm(ref);
  const exact = items.filter((i) => norm(name(i)) === wanted);
  if (exact.length) return exact;
  const partial = items.filter((i) => {
    const n = norm(name(i));
    return n.includes(wanted) || (n.length >= 3 && wanted.includes(n));
  });
  return partial;
}

export function escapeLike(value: string) {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}
