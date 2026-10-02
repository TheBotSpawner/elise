import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

/**
 * Acknowledgement audio (ADR-028): the fixed lines are synthesized once per instance and then
 * served from memory; anything else is always synthesized (never cached).
 */
const synthesize = vi.fn(
  async () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
        c.close();
      },
    }),
);
vi.mock("@/infrastructure/ai", () => ({
  getSpeechInputProvider: () => null,
  getSpeechOutputProvider: () => ({ synthesize, format: { sampleRate: 24000 } }),
}));

const { synthesizeSentence } = await import("@/application/voice-service");

const auth = {
  workspaceId: "w",
  userId: `u-${crypto.randomUUID()}`,
  profile: { locale: "es", voice: { enabled: true, speak: true, voice: "alloy" } },
} as unknown as AuthContext;

const bytes = async (s: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(s).arrayBuffer());

describe("acknowledgement audio", () => {
  it("is synthesized once, then served from memory", async () => {
    const first = await synthesizeSentence(auth, "Lo busco.", "es");
    expect(await bytes(first.stream)).toEqual(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 0));
    const again = await synthesizeSentence(auth, "Lo busco.", "es");
    expect(await bytes(again.stream)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("answers are never cached", async () => {
    synthesize.mockClear();
    await bytes((await synthesizeSentence(auth, "Encontré seis publicaciones.", "es")).stream);
    await bytes((await synthesizeSentence(auth, "Encontré seis publicaciones.", "es")).stream);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });
});
