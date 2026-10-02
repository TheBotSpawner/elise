import "server-only";

import OpenAI from "openai";

import { AppError } from "@/core/errors";
import { LIVE_MODEL } from "@/core/voice/live";

/**
 * GPT-Live adapter (ADR-026), verified against the current API (2026-10): the browser's WebRTC
 * offer is exchanged server-side at POST /v1/live/sessions with the project key — the key never
 * reaches the browser. Client delegation: GPT-Live hands requests to ELISE, which returns
 * verified results as session appends. The data channel only accepts the events ELISE's client
 * needs (results, progress, mute, close).
 */

/** Client → GPT-Live events the browser may send on the data channel. */
export const LIVE_CLIENT_EVENTS = [
  "session.commentary.append",
  "session.thinking.append",
  "session.instructions.append",
  "session.input_audio.mute",
  "session.input_audio.unmute",
  "session.close",
];

export async function createLiveWebRtcSession(opts: {
  apiKey: string;
  sdp: string;
  instructions: string;
  voice: string;
  /** A stable, privacy-preserving id of the end user (hashed), for abuse detection. */
  safetyIdentifier: string;
}): Promise<{ sdp: string; id: string }> {
  const client = new OpenAI({ apiKey: opts.apiKey, maxRetries: 0, timeout: 15_000 });
  try {
    const result = await client.live.create(
      {
        session: {
          model: LIVE_MODEL,
          instructions: opts.instructions,
          audio: { output: { voice: opts.voice } },
          delegation: { type: "client" },
          client: {
            data_channel: {
              allowed_client_events: LIVE_CLIENT_EVENTS,
              allowed_server_events: "all",
            },
          },
        },
        transport: { type: "webrtc", sdp: opts.sdp },
      } as Parameters<typeof client.live.create>[0],
      { headers: { "OpenAI-Safety-Identifier": opts.safetyIdentifier } },
    );
    const answer = (result as { transport?: { sdp?: string } }).transport?.sdp;
    const id = (result as { session?: { id?: string } }).session?.id;
    if (!answer || !id) throw new AppError("AI_PROVIDER_ERROR", "GPT-Live returned no answer");
    return { sdp: answer, id };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403)
        throw new AppError("AI_NOT_CONFIGURED", "GPT-Live isn't available for this OpenAI key", {
          recovery: "configure",
        });
      if (error.status === 429)
        throw new AppError(
          "RATE_LIMITED",
          "Too many live voice sessions right now. Try again shortly.",
        );
      if (error.status === 400)
        throw new AppError("VALIDATION_ERROR", "The live voice connection couldn't be set up", {
          details: { providerStatus: 400 },
        });
    }
    throw new AppError("AI_PROVIDER_ERROR", "Live voice is not responding", { cause: error });
  }
}
