import { Router, Request, Response } from "express";
import { prismaService } from "../services/prisma.service";
import { openaiService } from "../services/openai.service";
import { QueryRequest, QueryResponse, ContextChunk } from "../types/query.types";
import { createValidationMiddleware } from "../middleware/validation";
import { QueryValidators } from "../middleware/queryValidation";
import { logger } from "../lib/logger";

const router = Router();

/**
 * POST /v1/query
 * Query the RAG pipeline with a natural language question
 */
router.post("/v1/query", createValidationMiddleware(QueryValidators.validateQueryRequest), async (req: Request, res: Response) => {
  try {
    const { query, limit = 5, threshold = 0.7 } = req.body as QueryRequest;
    logger.info({ query, limit, threshold }, "Processing query request");

    // 1. Generate embedding for the query
    logger.info("Generating embedding for query");
    const queryEmbedding = await openaiService.generateEmbedding(query);

    // 2. Find similar embeddings using vector search
    logger.info("Searching for similar embeddings");
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
    logger.info("Generating completion");
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
    logger.error({
      error: error.message ?? String(error)
    }, "Query processing failed");
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to process query"
    });
  }
});

export default router;
