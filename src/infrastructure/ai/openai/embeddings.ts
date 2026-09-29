import "server-only";

import OpenAI from "openai";

import { AppError } from "@/core/errors";
import type { EmbeddingProvider } from "@/core/knowledge/model";

/** The index stores 1536-dimensional vectors (knowledge_chunks.embedding). */
export const EMBEDDING_DIMENSIONS = 1536;
const BATCH = 96;

/**
 * OpenAI embeddings behind ELISE's EmbeddingProvider port. text-embedding-3 models accept a
 * `dimensions` parameter, so the model can change without changing the column size.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 24_000) || " ");
      try {
        const res = await this.client.embeddings.create({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        });
        out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
      } catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 429) {
          throw new AppError("RATE_LIMITED", "The AI provider is busy. Try again shortly.");
        }
        if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) {
          throw new AppError("AI_NOT_CONFIGURED", "The AI provider rejected the credentials", {
            recovery: "configure",
          });
        }
        throw new AppError("AI_PROVIDER_ERROR", "Could not index this content right now", {
          cause: error,
        });
      }
    }
    return out;
  }
}
