import OpenAI from 'openai';
import { logger } from '../lib/logger';

/**
 * Service for OpenAI operations including embeddings and completions
 */
export class OpenAIService {
  private client?: OpenAI;

  /**
   * Get the OpenAI client, initializing it if necessary
   */
  async getClient(): Promise<OpenAI> {
    if (!this.client) {
      const apiKey = process.env.OPENAI_SECRET;
      if (!apiKey) {
        throw new Error('OPENAI_SECRET environment variable is required');
      }

      this.client = new OpenAI({ apiKey });
    }
    return this.client;
  }

  /**
   * Generate embedding for text using OpenAI's text-embedding-3-small model
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const client = await this.getClient();
      const response = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });
      return response.data[0].embedding;
    } catch (error: any) {
      logger.error({ error }, "Failed to generate embedding");
      throw new Error(`OpenAI embedding generation failed: ${error.message}`);
    }
  }

  /**
   * Generate completion using OpenAI's chat completions API
   */
  async generateCompletion(context: string, query: string): Promise<string> {
    try {
      const client = await this.getClient();
      const response = await client.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Use the provided context to answer the user's question. If the context doesn't contain relevant information, say so."
          },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${query}`
          }
        ],
        max_tokens: 500,
        temperature: 0.7
      });

      return response.choices[0].message.content || '';
    } catch (error: any) {
      logger.error({ error }, "Failed to generate completion");
      throw new Error(`OpenAI completion generation failed: ${error.message}`);
    }
  }
}

// Export a singleton instance
export const openaiService = new OpenAIService();
