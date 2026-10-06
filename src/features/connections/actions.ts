"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  safeReturnPath,
  disconnectConnection,
  renameConnection,
  setCapabilityEnabled,
  setDefaultConnection,
  startGoogleConnection,
  startNotionConnection,
  startSpotifyConnection,
  enableYouTubeMusic,
} from "@/application/connections-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type ConnectionActionResult = { ok: true } | { ok: false; error: PublicError };

const capability = z.enum(["tasks", "calendar", "email", "knowledge", "finance"]);

async function origin(): Promise<string> {
  const h = await headers();
  return h.get("origin") ?? `https://${h.get("host")}`;
}

async function run(fn: () => Promise<void>): Promise<ConnectionActionResult> {
  try {
    await fn();
    revalidatePath("/connections");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Starts Google consent for the chosen capabilities (or reconnects/extends one connection). */
export async function connectGoogle(form: FormData): Promise<void> {
  const auth = await requireAuthContext();
  const connectionId = z
    .uuid()
    .optional()
    .parse(form.get("connectionId") || undefined);
  const returnPath = safeReturnPath(form.get("returnTo"));
  let url: string;
  try {
    url = await startGoogleConnection(auth, {
      capabilities: form.getAll("capability").map(String),
      connectionId,
      origin: await origin(),
      returnPath,
    });
  } catch (error) {
    redirect(`${returnPath}?error=${toPublicError(error).code}`);
  }
  redirect(url);
}

/** Starts Notion's consent (the user picks the pages ELISE may read). */
export async function connectNotion(form?: FormData): Promise<void> {
  const auth = await requireAuthContext();
  const returnPath = safeReturnPath(form?.get("returnTo"));
  let url: string;
  try {
    url = await startNotionConnection(auth, await origin(), returnPath);
  } catch (error) {
    redirect(`${returnPath}?error=${toPublicError(error).code}`);
  }
  redirect(url);
}

export async function renameConnectionAction(
  id: string,
  displayName: string,
  contextLabel: string,
) {
  const values = z
    .object({
      id: z.uuid(),
      displayName: z.string().trim().min(1).max(120),
      contextLabel: z.string().trim().max(80),
    })
    .parse({ id, displayName, contextLabel });
  return run(async () =>
    renameConnection(await requireAuthContext(), values.id, {
      displayName: values.displayName,
      contextLabel: values.contextLabel || null,
    }),
  );
}

export async function toggleCapabilityAction(id: string, cap: string, enabled: boolean) {
  return run(async () =>
    setCapabilityEnabled(
      await requireAuthContext(),
      z.uuid().parse(id),
      capability.parse(cap),
      enabled,
    ),
  );
}

export async function setDefaultAction(id: string, cap: string) {
  return run(async () =>
    setDefaultConnection(await requireAuthContext(), z.uuid().parse(id), capability.parse(cap)),
  );
}

export async function disconnectAction(id: string) {
  return run(async () => disconnectConnection(await requireAuthContext(), z.uuid().parse(id)));
}

/** Starts Spotify's consent (ADR-042). */
export async function connectSpotify(form?: FormData): Promise<void> {
  const auth = await requireAuthContext();
  const returnPath = safeReturnPath(form?.get("returnTo"));
  let url: string;
  try {
    url = await startSpotifyConnection(auth, await origin(), returnPath);
  } catch (error) {
    redirect(`${returnPath}?error=${toPublicError(error).code}`);
  }
  redirect(url);
}

/** Turns on YouTube for Music (no account: server search + the official embedded player). */
export async function enableYouTubeAction(): Promise<void> {
  const auth = await requireAuthContext();
  try {
    await enableYouTubeMusic(auth);
  } catch (error) {
    redirect(`/connections?error=${toPublicError(error).code}`);
  }
  revalidatePath("/connections");
  redirect("/connections?provider=youtube");
}
