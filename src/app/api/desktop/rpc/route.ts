import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { AppError } from "@/core/errors";
import * as approvals from "@/features/approvals/actions";
import * as attachments from "@/features/chat/attachment-actions";
import * as connections from "@/features/connections/actions";
import * as contexts from "@/features/contexts/actions";
import * as email from "@/features/email/actions";
import * as finance from "@/features/finance/actions";
import * as history from "@/features/history/actions";
import * as home from "@/features/home/actions";
import * as knowledge from "@/features/knowledge/actions";
import * as methods from "@/features/methods/actions";
import * as modules from "@/features/modules/actions";
import * as music from "@/features/music/actions";
import * as native from "@/features/native/actions";
import * as onboarding from "@/features/onboarding/actions";
import * as schedules from "@/features/schedules/actions";
import * as settings from "@/features/settings/actions";
import * as shortcuts from "@/features/shortcuts/actions";
import * as structured from "@/features/structured/actions";
import * as tasks from "@/features/tasks/actions";
import * as time from "@/features/time/actions";
import * as workspace from "@/features/workspace/actions";

import { desktopError, redirectTarget, requireDesktopClient } from "../respond";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * ELISE Desktop's local renderer calls the same Server Actions the web uses (ADR-081), by name.
 * Only exported functions of these "use server" modules — exactly what Next already exposes
 * as actions, with their own auth and validation — and only for a signed-in person. Sign-in
 * and Desktop approval are deliberately absent.
 */
const RPC_MODULES: Record<string, Record<string, unknown>> = {
  "features/approvals/actions": approvals,
  "features/chat/attachment-actions": attachments,
  "features/connections/actions": connections,
  "features/contexts/actions": contexts,
  "features/email/actions": email,
  "features/finance/actions": finance,
  "features/history/actions": history,
  "features/home/actions": home,
  "features/knowledge/actions": knowledge,
  "features/methods/actions": methods,
  "features/modules/actions": modules,
  "features/music/actions": music,
  "features/native/actions": native,
  "features/onboarding/actions": onboarding,
  "features/schedules/actions": schedules,
  "features/settings/actions": settings,
  "features/shortcuts/actions": shortcuts,
  "features/structured/actions": structured,
  "features/tasks/actions": tasks,
  "features/time/actions": time,
  "features/workspace/actions": workspace,
};

const callSchema = z.object({
  module: z.string().max(80),
  fn: z.string().regex(/^[A-Za-z_$][\w$]{0,79}$/),
  args: z.array(z.unknown()).max(8),
});

/** FormData travels as { __formData: [[name, value]] } (strings only: no files here). */
function decode(arg: unknown): unknown {
  if (arg && typeof arg === "object" && "__formData" in arg) {
    const form = new FormData();
    const entries = z.array(z.tuple([z.string(), z.string()])).parse(arg.__formData);
    for (const [k, v] of entries) form.append(k, v);
    return form;
  }
  return arg;
}

export async function POST(request: Request) {
  try {
    requireDesktopClient(request);
    await requireAuthContext();
    const call = callSchema.parse(await request.json().catch(() => null));
    const mod = Object.hasOwn(RPC_MODULES, call.module) ? RPC_MODULES[call.module] : undefined;
    const fn = mod && Object.hasOwn(mod, call.fn) ? mod[call.fn] : undefined;
    if (typeof fn !== "function") throw new AppError("NOT_FOUND", "Unknown action");
    try {
      const value = await (fn as (...a: unknown[]) => Promise<unknown>)(...call.args.map(decode));
      return NextResponse.json({ value: value ?? null });
    } catch (error) {
      // redirect() inside an action: the app navigates (or opens the browser for OAuth).
      const redirect = redirectTarget(error);
      if (redirect) return NextResponse.json({ redirect });
      throw error;
    }
  } catch (error) {
    return desktopError(error, "desktop_rpc_failed");
  }
}
