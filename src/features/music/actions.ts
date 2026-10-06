"use server";

import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { runUserTool } from "@/application/elise";
import type { ToolDisplay } from "@/core/agents/tools";
import { toPublicError, type PublicError } from "@/core/errors";

/**
 * The Music Surface's and mini-player's buttons (ADR-042): the same canonical tools ELISE uses,
 * with origin user_ui (validation, provider resolution, policy, audit). Never a provider call.
 */

const OPS = [
  "pause",
  "resume",
  "next",
  "previous",
  "seek",
  "setVolume",
  "transfer",
  "listDevices",
  "play",
] as const;

export async function musicAction(
  op: (typeof OPS)[number],
  args: Record<string, unknown> = {},
): Promise<
  | { ok: true; display: Extract<ToolDisplay, { kind: "music" }> | null }
  | { ok: false; error: PublicError }
> {
  try {
    const outcome = await runUserTool(
      await requireAuthContext(),
      `music.${z.enum(OPS).parse(op)}`,
      z.record(z.string(), z.unknown()).parse(args),
    );
    const display = outcome.display?.kind === "music" ? outcome.display : null;
    return { ok: true, display };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
