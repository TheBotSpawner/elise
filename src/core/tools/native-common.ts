import type { ToolContext } from "../agents/tools";
import type { EntrySource } from "../capabilities/habits";
import { AppError } from "../errors";

/** Where a native record came from, for audit and debugging. */
export function sourceOf(ctx: ToolContext): EntrySource {
  return ctx.origin === "user_ui" ? "user_ui" : ctx.origin === "ai" ? "ai" : ctx.origin;
}

/**
 * Resolves a record the user named ("gym", "shopping"). Exactly one match proceeds; none or
 * several become a question for the user, never a guess.
 */
export function pickOne<T>(matches: T[], ref: string, label: string, name: (t: T) => string): T {
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    throw new AppError("NOT_FOUND", `No ${label} called "${ref}"`, { recovery: "review" });
  }
  throw new AppError(
    "VALIDATION_ERROR",
    `Several ${label}s match "${ref}": ${matches.map(name).slice(0, 8).join("; ")}. Ask which one.`,
    { recovery: "review" },
  );
}
