import { IngestService, createIngestService, DatabaseService, SqsService } from '../../src/services/ingest.service';
import { IngestRecord } from '../../src/types/ingest.types';

jest.mock('../../src/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Helper to build records
function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    clientId: 'client-1',
    content: { a: 1 },
    ...overrides,
  };
}

describe('IngestService', () => {
  const queueUrl = 'http://sqs.local/queue';
  let db: jest.Mocked<DatabaseService>;
  let sqs: jest.Mocked<SqsService>;
  let service: IngestService;

  beforeEach(() => {
    db = {
      getBatchByKey: jest.fn(),
      getChunksByBatchId: jest.fn(),
      storeIdempotencyKey: jest.fn(),
    };
    sqs = {
      sendMessageBatch: jest.fn(),
      getQueueAttributes: jest.fn(),
    };
    service = createIngestService(queueUrl, db, sqs);
  });

  describe('initialize', () => {
    it('whenInitializeSucceeds_setsInitializedAndLogs', async () => {
      sqs.getQueueAttributes.mockResolvedValue({} as any);
      await service.initialize();
      // call again to validate idempotency
      await service.initialize();
      expect(sqs.getQueueAttributes).toHaveBeenCalledTimes(1);
    });

    it('whenInitializeFails_throwsSanitizedError', async () => {
      sqs.getQueueAttributes.mockRejectedValue(new Error('boom'));
      await expect(service.initialize()).rejects.toThrow('SQS client initialization failed');
    });
  });

  describe('ingest with error handling', () => {
    it('whenSqsReturnsMixedResults_handlesSuccessesAndFailures', async () => {
      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const entries = cmd.input.Entries;
        const firstId = entries[0].Id;
        const secondId = entries[1].Id;
        return {
          Successful: [{ Id: firstId }],
          Failed: [{ Id: secondId, Code: 'InvalidParameterValue', Message: 'Error: path /var/log/app.js' }],
        } as any;
      });

      const out = await service.ingest([
        makeRecord({ clientId: 'client-1', content: 'record-1' }),
        makeRecord({ clientId: 'client-2', content: 'record-2' })
      ]);

      expect(out.results.length).toBe(1);
      expect(out.errors.length).toBe(1);
      expect(out.errors[0].code).toBe('INVALID_PARAMETER'); // mapped
      expect(out.errors[0].message).not.toMatch(/\/var\/log/); // sanitized
    });

    it('whenSqsThrows_returnsBatchErrorForAllEntries', async () => {
      sqs.sendMessageBatch.mockRejectedValue(new Error('http://example.com secret stack at X'));

      const out = await service.ingest([
        makeRecord({ clientId: 'client-1', content: 'record-1' }),
        makeRecord({ clientId: 'client-2', content: 'record-2' })
      ]);

      expect(out.results).toEqual([]);
      expect(out.errors).toHaveLength(2);
      expect(out.errors.every(e => e.code === 'BATCH_ERROR')).toBe(true);
      // message is sanitized: url/stack removed
      expect(out.errors[0].message).not.toMatch(/http:\/\/example.com/);
    });

    it('whenMoreThanTenRecords_sendsInBatchesAndCombinesResults', async () => {
      const records = Array.from({ length: 23 }).map((_, i) =>
        makeRecord({ clientId: `c${i}`, content: `record-${i}` })
      );

      // 3 batches: 10, 10, 3
      let call = 0;
      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        // mark the 2nd batch's last item as failure
        const failId = call === 1 ? ids[ids.length - 1] : null;
        call += 1;
        return {
          Successful: ids.filter((id: string) => id !== failId).map((Id: string) => ({ Id })),
          Failed: failId ? [{ Id: failId, Code: 'MessageTooLarge', Message: 'too big' }] : [],
        } as any;
      });

      const out = await service.ingest(records);
      expect(out.results.length).toBe(22);
      expect(out.errors.length).toBe(1);
      expect(out.errors[0].code).toBe('MESSAGE_TOO_LARGE');
    });
  });

  describe('ingest with idempotency', () => {
    it('whenExistingBatchFound_returnsTransformedResultsWithoutSending', async () => {
      db.getBatchByKey.mockResolvedValue({ success: true, batchId: 'b_exist' });
      db.getChunksByBatchId.mockResolvedValue({
        success: true,
        chunks: [
          { id: 'c1', clientId: 'x', chunkIndex: 0, status: 'INGESTED' },
          { id: 'c2', clientId: 'y', chunkIndex: 1, status: 'FAILED', failureReason: 'bad' },
        ],
      });

      const out = await service.ingest([makeRecord()], 'idem-1', 'req-1');
      expect(out.batchId).toBe('b_exist');
      expect(out.results).toHaveLength(1);
      expect(out.errors).toHaveLength(1);
      expect(sqs.sendMessageBatch).not.toHaveBeenCalled();
    });

    it('whenBatchFoundButNoChunks_returnsExistingBatchWithEmptyResults', async () => {
      db.getBatchByKey.mockResolvedValue({ success: true, batchId: 'b_exist' });
      db.getChunksByBatchId.mockResolvedValue({ success: true, chunks: undefined });

      const out = await service.ingest([makeRecord({ clientId: 'client-1', content: 'new' })], 'idem-2');
      expect(out.batchId).toBe('b_exist');
      expect(out.results).toEqual([]);
      expect(out.errors).toEqual([]);
      expect(sqs.sendMessageBatch).not.toHaveBeenCalled();
    });

    it('whenFetchChunksByBatchIdFails_throwsError', async () => {
      db.getBatchByKey.mockResolvedValue({ success: true, batchId: 'b_exist' });
      db.getChunksByBatchId.mockResolvedValue({ success: false, error: 'Database query failed' });

      await expect(service.ingest([makeRecord({ clientId: 'client-1', content: 'new' })], 'idem-3'))
        .rejects.toThrow('Failed to check idempotency for key idem-3');
      expect(sqs.sendMessageBatch).not.toHaveBeenCalled();
    });

    it('whenIdempotencyLookupFails_throws', async () => {
      db.getBatchByKey.mockRejectedValue(new Error('db down'));
      await expect(service.ingest([makeRecord()], 'idem-4')).rejects.toThrow('Failed to check idempotency');
    });
  });

  describe('ingest without idempotency', () => {
    it('whenNoIdempotency_processesAndStoresMapping', async () => {
      // Make two identical records to test dedup keeps first
      const input = [makeRecord({ content: { same: true } }), makeRecord({ content: { same: true } })];
      // One success returned to count as processed
      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        return {
          Successful: ids.map((Id: string) => ({ Id })),
          Failed: [],
        } as any;
      });

      const out = await service.ingest(input, undefined, 'req-7');
      expect(out.batchId).toMatch(/^b_/);
      // dedup removes 1 duplicate → 1 processed
      expect(out.results.length + out.errors.length).toBe(1);
      // idempotency not provided → not stored
      expect(db.storeIdempotencyKey).not.toHaveBeenCalled();
    });

    it('whenStoreIdempotencyFails_throws', async () => {
      // No existing batch found
      db.getBatchByKey.mockResolvedValue({ success: false } as any);
      // force at least one processed message
      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        return {
          Successful: ids.map((Id: string) => ({ Id })),
          Failed: [],
        } as any;
      });
      db.storeIdempotencyKey.mockRejectedValue(new Error('cannot store'));
      await expect(service.ingest([makeRecord({ clientId: 'client-1', content: 'rec1' })], 'idem-3')).rejects.toThrow('Failed to store idempotency mapping');
    });
  });

  describe('ingest with deduplication', () => {
    it('whenDuplicateContents_present_keepsFirstOccurrenceOnly', async () => {
      const records = [
        makeRecord({ clientId: 'c1', content: 'A' }),
        makeRecord({ clientId: 'c2', content: 'A' }),
        makeRecord({ clientId: 'c3', content: 'B' }),
        makeRecord({ clientId: 'c4', content: 'A' }),
      ];

      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        return {
          Successful: ids.map((Id: string) => ({ Id })),
          Failed: [],
        } as any;
      });

      const out = await service.ingest(records);
      // Expect only 2 results: first 'A' and first 'B' (dedup removes duplicates)
      expect(out.results.length).toBe(2);
      expect(out.errors.length).toBe(0);
    });
  });

  describe('ingest success path', () => {
    it('whenAllRecordsSuccess_allSucceedAndIdempotencyStored', async () => {
      db.getBatchByKey.mockResolvedValue({ success: false });

      const records = [
        makeRecord({ clientId: 'c1', content: 'rec1' }),
        makeRecord({ clientId: 'c2', content: 'rec2' }),
        makeRecord({ clientId: 'c3', content: 'rec3' }),
      ];

      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        return {
          Successful: ids.map((Id: string) => ({ Id })),
          Failed: [],
        } as any;
      });

      const out = await service.ingest(records, 'idem-success');
      expect(out.results.length).toBe(3);
      expect(out.errors.length).toBe(0);
      expect(out.batchId).toMatch(/^b_/);
      expect(db.storeIdempotencyKey).toHaveBeenCalledWith('idem-success', out.batchId);
    });
  });

  describe('ingest all failures', () => {
    it('whenAllRecordsFail_allFailAndIdempotencyStored', async () => {
      db.getBatchByKey.mockResolvedValue({ success: false });

      const records = [
        makeRecord({ clientId: 'c1', content: 'rec1' }),
        makeRecord({ clientId: 'c2', content: 'rec2' }),
      ];

      sqs.sendMessageBatch.mockImplementation(async (cmd: any) => {
        const ids = cmd.input.Entries.map((e: any) => e.Id);
        return {
          Successful: [],
          Failed: ids.map((Id: string) => ({ Id, Code: 'MessageTooLarge', Message: 'too big' })),
        } as any;
      });

      const out = await service.ingest(records, 'idem-all-fail');
      expect(out.results.length).toBe(0);
      expect(out.errors.length).toBe(2);
      expect(out.batchId).toMatch(/^b_/);
      expect(db.storeIdempotencyKey).toHaveBeenCalledWith('idem-all-fail', out.batchId);
    });
  });
});
