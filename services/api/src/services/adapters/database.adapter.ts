import { DatabaseService, ChunkData } from '../ingest.service';
import { prismaService } from '../../lib/prisma-client';

export class PrismaDatabaseAdapter implements DatabaseService {
  async getBatchByKey(idempotencyKey: string): Promise<{ success: boolean; batchId?: string }> {
    return prismaService.getBatchByKey(idempotencyKey);
  }

  async getChunksByBatchId(batchId: string): Promise<{ success: boolean; chunks?: ChunkData[]; error?: string }> {
    const result = await prismaService.getChunksByBatchId(batchId);
    return {
      success: result.success,
      chunks: result.chunks as ChunkData[],
      error: result.error
    };
  }

  async storeIdempotencyKey(idempotencyKey: string, batchId: string): Promise<void> {
    await prismaService.storeIdempotencyKey(idempotencyKey, batchId);
  }
}
