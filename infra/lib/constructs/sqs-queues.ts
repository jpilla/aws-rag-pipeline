import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';

export class SqsQueues extends Construct {
  public readonly ingestQueue: sqs.Queue;
  private readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Create Dead Letter Queue
    this.dlq = new sqs.Queue(this, 'IngestDlq', {
      queueName: 'app-ingest-dlq',
      retentionPeriod: Duration.days(2),
      enforceSSL: true,
    });

    // Create main ingest queue
    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: 'app-ingest',
      visibilityTimeout: Duration.seconds(20),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 5
      },
      enforceSSL: true,
    });
  }

  /**
   * Get the queue URL
   */
  public getQueueUrl(): string {
    return this.ingestQueue.queueUrl;
  }
}
