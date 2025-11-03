"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaService = void 0;
exports.createPrismaService = createPrismaService;
const client_1 = require("@prisma/client");
const sql_queries_1 = require("./sql.queries");
/**
 * Service for managing Prisma database operations
 */
class PrismaService {
    constructor(credentialProvider, sqlQueries) {
        this.credentialProvider = credentialProvider;
        this.sqlQueries = sqlQueries || new sql_queries_1.SqlQueries();
    }
    /**
     * Get the Prisma client, initializing it if necessary
     */
    async getClient() {
        if (!this.client) {
            const credentials = await this.credentialProvider.getCredentials();
            // Construct DATABASE_URL from environment variables
            const host = process.env.DB_HOST || 'localhost';
            const port = process.env.DB_PORT || '5432';
            const database = process.env.DB_NAME || 'embeddings';
            // SSL mode: require for production (AWS RDS), disable for local development
            const sslMode = process.env.DB_SSLMODE || 'require';
            const databaseUrl = `postgresql://${credentials.username}:${credentials.password}@${host}:${port}/${database}?sslmode=${sslMode}`;
            this.client = new client_1.PrismaClient({
                datasources: {
                    db: {
                        url: databaseUrl,
                    },
                },
                log: ['error', 'warn'],
            });
        }
        return this.client;
    }
    /**
     * Test database connectivity
     */
    async testConnection() {
        try {
            const client = await this.getClient();
            await this.sqlQueries.executeHealthCheck(client);
            return {
                success: true,
                message: 'Prisma database connection successful',
            };
        }
        catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Prisma database connection failed',
            };
        }
    }
    /**
     * Validate embedding data structure
     */
    validateEmbedding(embedding) {
        if (!embedding.id || typeof embedding.id !== 'string') {
            return { isValid: false, error: "Each embedding must have a valid id (string)" };
        }
        if (typeof embedding.chunkIndex !== 'number') {
            return { isValid: false, error: "Each embedding must have a valid chunkIndex (number)" };
        }
        if (!embedding.content || typeof embedding.content !== 'string') {
            return { isValid: false, error: "Each embedding must have valid content (string)" };
        }
        if (!Array.isArray(embedding.embedding) || embedding.embedding.length === 0) {
            return { isValid: false, error: "Each embedding must have a valid embedding array" };
        }
        return { isValid: true };
    }
    /**
     * Validate embeddings data
     */
    validateEmbeddings(embeddings) {
        if (!Array.isArray(embeddings) || embeddings.length === 0) {
            return { isValid: false, error: "embeddings array is required and must not be empty" };
        }
        for (const embedding of embeddings) {
            const validation = this.validateEmbedding(embedding);
            if (!validation.isValid) {
                return validation;
            }
        }
        return { isValid: true };
    }
    /**
     * Find similar embeddings using vector similarity search with pgvector
     */
    async findSimilarEmbeddings(queryEmbedding, limit = 5, threshold = 0.7) {
        try {
            const client = await this.getClient();
            const embeddingString = this.formatEmbeddingForSql(queryEmbedding);
            const cosineThreshold = this.convertThresholdToCosineDistance(threshold);
            const embeddings = await this.sqlQueries.findSimilarEmbeddings(client, embeddingString, cosineThreshold, limit);
            return this.createSearchSuccessResponse(embeddings);
        }
        catch (error) {
            return this.createSearchErrorResponse(error);
        }
    }
    /**
     * Get chunks by batchId with status information
     */
    async getChunksByBatchId(batchId) {
        try {
            const client = await this.getClient();
            const chunks = await this.sqlQueries.getChunksByBatchId(client, batchId);
            return this.createChunksSuccessResponse(chunks);
        }
        catch (error) {
            return this.createChunksErrorResponse(error);
        }
    }
    /**
     * Get batch status summary
     */
    async getBatchStatus(batchId) {
        try {
            const client = await this.getClient();
            const result = await this.sqlQueries.getBatchStatus(client, batchId);
            return this.createBatchStatusSuccessResponse(batchId, result);
        }
        catch (error) {
            return this.createBatchStatusErrorResponse(batchId, error);
        }
    }
    /**
     * Store idempotency key mapping
     */
    async storeIdempotencyKey(idempotencyKey, batchId) {
        try {
            const client = await this.getClient();
            await this.sqlQueries.storeIdempotencyKey(client, idempotencyKey, batchId);
            return { success: true };
        }
        catch (error) {
            return this.createStoreIdempotencyErrorResponse(error);
        }
    }
    /**
     * Get batch ID by idempotency key
     */
    async getBatchByKey(idempotencyKey) {
        try {
            const client = await this.getClient();
            const result = await this.sqlQueries.getBatchByKey(client, idempotencyKey);
            return this.createGetBatchByKeyResponse(result);
        }
        catch (error) {
            return this.createGetBatchByKeyErrorResponse(error);
        }
    }
    /**
     * Close the Prisma client connection
     */
    async close() {
        if (this.client) {
            await this.client.$disconnect();
            this.client = undefined;
        }
    }
    // ============= Private Helper Methods =============
    /**
     * Format embedding array for SQL vector query
     */
    formatEmbeddingForSql(queryEmbedding) {
        return `[${queryEmbedding.join(',')}]`;
    }
    /**
     * Convert similarity threshold to cosine distance
     * Cosine distance ranges from 0 (identical) to 2 (opposite)
     * Similarity = 1 - (distance/2)
     */
    convertThresholdToCosineDistance(threshold) {
        return 2 - (threshold * 2);
    }
    /**
     * Create success response for search results
     */
    createSearchSuccessResponse(embeddings) {
        return {
            success: true,
            embeddings,
            count: embeddings.length
        };
    }
    /**
     * Create error response for search failures
     */
    createSearchErrorResponse(error) {
        return {
            success: false,
            embeddings: [],
            count: 0,
            error: error instanceof Error ? error.message : "Failed to perform similarity search"
        };
    }
    /**
     * Create success response for chunks query
     */
    createChunksSuccessResponse(chunks) {
        return {
            success: true,
            chunks,
            count: chunks.length
        };
    }
    /**
     * Create error response for chunks query failures
     */
    createChunksErrorResponse(error) {
        return {
            success: false,
            chunks: [],
            count: 0,
            error: error instanceof Error ? error.message : "Failed to retrieve batch chunks"
        };
    }
    /**
     * Create success response for batch status query
     */
    createBatchStatusSuccessResponse(batchId, result) {
        const stats = result[0];
        return {
            success: true,
            batchId,
            totalChunks: parseInt(stats.total_chunks),
            enqueuedChunks: parseInt(stats.enqueued_chunks),
            ingestedChunks: parseInt(stats.ingested_chunks),
            failedChunks: parseInt(stats.failed_chunks),
            createdAt: stats.created_at ? stats.created_at.toISOString() : undefined,
            completedAt: stats.completed_at ? stats.completed_at.toISOString() : undefined
        };
    }
    /**
     * Create error response for batch status query failures
     */
    createBatchStatusErrorResponse(batchId, error) {
        return {
            success: false,
            batchId,
            totalChunks: 0,
            enqueuedChunks: 0,
            ingestedChunks: 0,
            failedChunks: 0,
            error: error instanceof Error ? error.message : "Failed to retrieve batch status"
        };
    }
    /**
     * Create error response for storing idempotency key failures
     */
    createStoreIdempotencyErrorResponse(error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to store idempotency key"
        };
    }
    /**
     * Create response for get batch by key query
     */
    createGetBatchByKeyResponse(result) {
        if (result.length === 0) {
            return { success: true };
        }
        return {
            success: true,
            batchId: result[0].batchId
        };
    }
    /**
     * Create error response for get batch by key failures
     */
    createGetBatchByKeyErrorResponse(error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Failed to get batch by idempotency key"
        };
    }
}
exports.PrismaService = PrismaService;
/**
 * Factory function to create PrismaService with injected dependencies
 */
function createPrismaService(credentialProvider, sqlQueries) {
    return new PrismaService(credentialProvider, sqlQueries);
}
//# sourceMappingURL=prisma.service.js.map