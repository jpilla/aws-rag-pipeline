import { Router, Request, Response } from "express";
import { prismaService } from "../services/prisma.service";
import { openaiService } from "../services/openai.service";
import { QueryRequest, QueryResponse, ContextChunk } from "../types/query.types";

const router = Router();

/**
 * POST /v1/query
 * Query the RAG pipeline with a natural language question
 */
router.post("/v1/query", async (req: Request, res: Response) => {
  try {
    const { query, limit = 5, threshold = 0.7 } = req.body as QueryRequest;

    // Validate request payload
    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        error: "query is required and must be a string"
      });
    }

    if (limit && (typeof limit !== 'number' || limit < 1 || limit > 20)) {
      return res.status(400).json({
        error: "limit must be a number between 1 and 20"
      });
    }

    if (threshold && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) {
      return res.status(400).json({
        error: "threshold must be a number between 0 and 1"
      });
    }

    // 1. Generate embedding for the query
    console.log("Generating embedding for query:", query);
    const queryEmbedding = await openaiService.generateEmbedding(query);

    // 2. Find similar embeddings using vector search
    console.log("Searching for similar embeddings...");
    const searchResult = await prismaService.findSimilarEmbeddings(
      queryEmbedding,
      limit,
      threshold
    );

    if (!searchResult.success) {
      return res.status(500).json({
        error: "Vector search failed",
        message: searchResult.error
      });
    }

    if (searchResult.count === 0) {
      return res.json({
        query,
        answer: "I couldn't find any relevant information to answer your question.",
        context: [],
        matches: 0
      } as QueryResponse);
    }

    // 3. Prepare context from retrieved documents
    const context = searchResult.embeddings
      .map(emb => emb.content)
      .join('\n\n');

    // 4. Generate completion using OpenAI
    console.log("Generating completion...");
    const answer = await openaiService.generateCompletion(context, query);

    // 5. Format response
    const response: QueryResponse = {
      query,
      answer,
      context: searchResult.embeddings.map(emb => ({
        id: emb.id,
        docId: emb.docId,
        chunkIndex: emb.chunkIndex,
        content: emb.content,
        distance: emb.distance
      } as ContextChunk)),
      matches: searchResult.count
    };

    res.json(response);

  } catch (error: any) {
    console.error("Query processing failed:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to process query"
    });
  }
});

export default router;
