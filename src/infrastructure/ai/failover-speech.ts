import "server-only";

import type { SpeechOutputProvider, SynthesisRequest } from "@/core/voice/providers";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Speech failover (ADR-030): the preferred provider speaks; if it fails before any audio
 * (timeout, rate limit, outage), this segment is synthesized by the fallback instead — so
 * Voice Mode never breaks and nothing is said twice. After a failure the preferred provider
 * rests for a while (a circuit breaker) rather than costing every sentence a failed attempt.
 * A failure mid-segment is not retried: that segment ends there, the next one goes elsewhere.
 */
export class FailoverSpeechOutput implements SpeechOutputProvider {
  private openUntil = 0;

  constructor(
    private readonly primary: SpeechOutputProvider,
    private readonly fallback: SpeechOutputProvider,
    /** The fallback's voice when the stored one belongs to the primary. */
    private readonly fallbackVoice: (request: SynthesisRequest) => string,
    private readonly restMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get id() {
    return this.healthy ? this.primary.id : this.fallback.id;
  }
  get model() {
    return this.healthy ? this.primary.model : this.fallback.model;
  }
  get format() {
    return this.primary.format;
  }
  get voices() {
    return this.primary.voices;
  }
  private get healthy() {
    return this.now() >= this.openUntil;
  }

  async synthesize(
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.healthy) {
      try {
        return await this.primary.synthesize(request, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.openUntil = this.now() + this.restMs;
        logger.warn("speech.failover", {
          from: this.primary.id,
          to: this.fallback.id,
          code: (error as { code?: string }).code ?? "unknown",
        });
      }
    }
    return this.fallback.synthesize({ ...request, voice: this.fallbackVoice(request) }, signal);
  }
}
