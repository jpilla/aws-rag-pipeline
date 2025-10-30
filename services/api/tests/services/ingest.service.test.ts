import { IngestService, createIngestService, DatabaseService, SqsService } from '../../src/services/ingest.service';
import { IngestRecord, IngestRecordWithId, QueueEntry } from '../../src/types/ingest.types';

jest.mock('../../src/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Helpers to build records
function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    clientId: 'client-1',
    content: { a: 1 },
    ...overrides,
  };
}

function withId(r: IngestRecord, id: string): IngestRecordWithId {
  return { ...r, chunkId: id } as IngestRecordWithId;
}

function parseEntries(entries: QueueEntry[]) {
  return entries.map(e => ({ id: e.Id, meta: e._meta, body: JSON.parse(e.MessageBody) }));
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

  describe('validateRecords', () => {
    it('whenRecordsIsValidArray_returnsTrue', () => {
      expect(service.validateRecords([makeRecord()])).toBe(true);
    });
    it('whenRecordsIsEmptyArray_returnsFalse', () => {
      expect(service.validateRecords([])).toBe(false);
    });
    it('whenRecordsIsNotArray_returnsFalse', () => {
      expect(service.validateRecords(undefined as any)).toBe(false);
    });
  });

  describe('createBatchEntries', () => {
    it('whenCreatingEntries_buildsMessageWithMetadataAndHash', () => {
      const batchId = 'b_123';
      const r1 = withId(makeRecord({ metadata: { foo: 'bar' } }), 'c_1');
      const entries = service.createBatchEntries([r1], batchId, 0, 'req-1');
      const parsed = parseEntries(entries)[0];
      expect(parsed.id).toBe('c_1');
      expect(parsed.meta).toEqual({ chunkId: 'c_1', clientId: 'client-1', idx: 0 });
      expect(parsed.body.batchId).toBe(batchId);
      expect(parsed.body.metadata.foo).toBe('bar');
      expect(parsed.body.metadata.requestId).toBe('req-1');
      expect(typeof parsed.body.contentHash).toBe('string');
      expect(parsed.body.contentHash.length).toBeGreaterThan(0);
    });
  });

  describe('sendBatch', () => {
    it('whenSqsReturnsMixedResults_mapsSuccessesAndFailures', async () => {
      const entries = service.createBatchEntries(
        [withId(makeRecord(), 'c_1'), withId(makeRecord(), 'c_2')],
        'b_x',
        0
      );
      sqs.sendMessageBatch.mockResolvedValue({
        Successful: [{ Id: entries[0].Id }],
        Failed: [{ Id: entries[1].Id, Code: 'InvalidParameterValue', Message: 'Error: path /var/log/app.js' }],
      } as any);

      const { results, errors } = await service.sendBatch(entries);
      expect(results).toEqual([
        {
          clientId: entries[0]._meta.clientId,
          originalIndex: entries[0]._meta.idx,
          chunkId: entries[0]._meta.chunkId,
          status: 'ENQUEUED',
        },
      ]);
      expect(errors[0].status).toBe('REJECTED');
      expect(errors[0].code).toBe('INVALID_PARAMETER'); // mapped
      expect(errors[0].message).not.toMatch(/\/var\/log/); // sanitized
    });

    it('whenSqsThrows_returnsBatchErrorForAllEntries', async () => {
      const entries = service.createBatchEntries(
        [withId(makeRecord(), 'c_1'), withId(makeRecord(), 'c_2')],
        'b_x',
        0
      );
      sqs.sendMessageBatch.mockRejectedValue(new Error('http://example.com secret stack at X'));
      const { results, errors } = await service.sendBatch(entries);
      expect(results).toEqual([]);
      expect(errors).toHaveLength(2);
      expect(errors.every(e => e.code === 'BATCH_ERROR')).toBe(true);
      // message is sanitized: url/stack removed
      expect(errors[0].message).not.toMatch(/http:\/\/example.com/);
    });
  });

  describe('processRecords', () => {
    it('whenMoreThanTenRecords_sendsInBatchesAndCombinesResults', async () => {
      const records: IngestRecordWithId[] = Array.from({ length: 23 }).map((_, i) =>
        withId(makeRecord({ clientId: `c${i}` }), `c_${i}`)
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

      const { results, errors } = await service.processRecords(records, 'b_1', 'req-1');
      expect(results.length).toBe(22);
      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe('MESSAGE_TOO_LARGE');
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

    it('whenIdempotencyLookupFails_throws', async () => {
      db.getBatchByKey.mockRejectedValue(new Error('db down'));
      await expect(service.ingest([makeRecord()], 'idem-2')).rejects.toThrow('Failed to check idempotency');
    });
  });

  describe('ingest without idempotency', () => {
    it('whenNoIdempotency_processesAndStoresMapping', async () => {
      // Make two identical records to test dedup keeps first
      const input = [makeRecord({ content: { same: true } }), makeRecord({ content: { same: true } })];
      // One success returned to count as processed
      sqs.sendMessageBatch.mockResolvedValue({ Successful: [{}], Failed: [] } as any);

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
      sqs.sendMessageBatch.mockResolvedValue({ Successful: [{}], Failed: [] } as any);
      db.storeIdempotencyKey.mockRejectedValue(new Error('cannot store'));
      await expect(service.ingest([makeRecord()], 'idem-3')).rejects.toThrow('Failed to store idempotency mapping');
    });
  });

  describe('deduplicateRecords', () => {
    it('whenDuplicateContents_present_keepsFirstOccurrenceOnly', async () => {
      const pre = (service as any).preprocessRecords([
        makeRecord({ content: 'A' }),
        makeRecord({ content: 'A' }),
        makeRecord({ content: 'B' }),
        makeRecord({ content: 'A' }),
      ]) as IngestRecordWithId[];

      const out = (service as any).deduplicateRecords(pre) as IngestRecordWithId[];
      // Expect only 2: 'A' and 'B'
      expect(out).toHaveLength(2);
      const contents = out.map(r => r.content);
      expect(contents.sort()).toEqual(['A', 'B']);
    });
  });
});
