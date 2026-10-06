import "server-only";

import { resolveBindings } from "@/core/providers/resolver";
import { musicPayloadOf } from "@/core/tools/music";
import type { MusicPayload } from "@/core/workspace/music";
import { loadWorkspaceBindings } from "@/infrastructure/supabase/repositories/bindings";

import type { AuthContext } from "./auth-context";
import { createExecutorPorts } from "./elise";

/**
 * The page's canonical playback read (ADR-042): what the user's music provider is playing,
 * for the Music Surface and the mini-player to follow changes made elsewhere (the Spotify app,
 * another device). A direct read of the default music provider — polling never writes action
 * traces. Embedded providers (YouTube) live in the page, so there is nothing to read here.
 */
export async function currentMusic(
  auth: AuthContext,
): Promise<{ provider: string; payload: MusicPayload | null } | null> {
  const { bindings } = await loadWorkspaceBindings(auth.db, auth.workspaceId);
  const resolution = resolveBindings(bindings, {
    capability: "music",
    operationKind: "read",
    connectionId: null,
    providerKey: null,
    destination: null,
    strict: false,
  });
  if (resolution.kind !== "resolved") return null;
  const binding = resolution.bindings.find((b) => b.isDefault) ?? resolution.bindings[0]!;
  if (binding.providerKey === "youtube") return { provider: "youtube", payload: null };
  const provider = createExecutorPorts(auth).providers.get("music", binding);
  const playback = await provider.playback();
  return { provider: binding.providerKey, payload: musicPayloadOf(provider, playback) };
}
