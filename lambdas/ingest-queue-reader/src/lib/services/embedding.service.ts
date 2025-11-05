import OpenAI from "openai";
import { logger } from "../logger.js";

export interface EmbeddingService {
  generateEmbeddingsBatch(contents: string[]): Promise<number[][]>;
  validateEmbeddingsBatch(
    embeddings: number[][],
    expectedCount: number
  ): void;
}

export class OpenAIEmbeddingService implements EmbeddingService {
  constructor(private openai: OpenAI) {}

  async generateEmbeddingsBatch(contents: string[]): Promise<number[][]> {
    const response = await this.openai.embeddings.create({
      model: "text-embedding-3-small",
      input: contents,
    });

    return response.data.map((item) => item.embedding);
  }

  validateEmbeddingsBatch(
    embeddings: number[][],
    expectedCount: number
  ): void {
    if (!embeddings || embeddings.length !== expectedCount) {
      throw new Error(
        `Embedding batch size mismatch: expected ${expectedCount}, got ${embeddings?.length || 0}`
      );
    }

    for (let i = 0; i < embeddings.length; i++) {
      const embedding = embeddings[i];
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(
          `Invalid embedding data at index ${i}: ${JSON.stringify(embedding)}`
        );
      }

      const hasInvalidValues = embedding.some((val) => !Number.isFinite(val));
      if (hasInvalidValues) {
        throw new Error(
          `Embedding contains invalid values at index ${i}: ${embedding.slice(0, 10)}`
        );
      }
    }
  }
}

export function createEmbeddingService(
  openai: OpenAI
): EmbeddingService {
  return new OpenAIEmbeddingService(openai);
}
