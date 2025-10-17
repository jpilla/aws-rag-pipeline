import { Router, Request, Response } from "express";
import { prismaService } from "../services/prisma.service";

const router = Router();

/**
 * POST /v1/embeddings
 * Creates multiple embedding records in a single transaction
 */
router.post("/v1/embeddings", async (req: Request, res: Response) => {
  try {
    const { embeddings } = req.body;

    // Validate request payload using service
    const validation = prismaService.validateEmbeddings(embeddings);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    // Create embeddings using service
    const result = await prismaService.createEmbeddings(embeddings);

    if (!result.success) {
      return res.status(500).json({
        error: "Internal server error",
        message: result.error || "Failed to create embeddings"
      });
    }

    res.status(201).json({
      success: true,
      message: `Successfully created/updated ${result.count} embeddings`,
      count: result.count,
      ids: result.ids
    });

  } catch (error: any) {
    console.error("Batch embeddings creation failed:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to create embeddings"
    });
  }
});

/**
 * GET /v1/embeddings
 * Retrieves multiple embedding records by their IDs
 */
router.get("/v1/embeddings", async (req: Request, res: Response) => {
  try {
    const { ids } = req.query;

    // Validate request parameters
    if (!ids) {
      return res.status(400).json({
        error: "ids query parameter is required"
      });
    }

    let idArray: string[];
    if (typeof ids === 'string') {
      // Handle comma-separated string
      idArray = ids.split(',').map(id => id.trim()).filter(id => id.length > 0);
    } else if (Array.isArray(ids)) {
      // Handle array of strings
      idArray = ids.map(id => String(id).trim()).filter(id => id.length > 0);
    } else {
      return res.status(400).json({
        error: "ids must be a comma-separated string or array of strings"
      });
    }

    if (idArray.length === 0) {
      return res.status(400).json({
        error: "At least one valid id must be provided"
      });
    }

    // Retrieve embeddings using service
    const result = await prismaService.getEmbeddings(idArray);

    if (!result.success) {
      return res.status(500).json({
        error: "Internal server error",
        message: result.error || "Failed to retrieve embeddings"
      });
    }

    res.json({
      success: true,
      count: result.count,
      embeddings: result.embeddings
    });

  } catch (error: any) {
    console.error("Batch embeddings retrieval failed:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to retrieve embeddings"
    });
  }
});

export default router;
