import { SqsService } from '../ingest.service';
import { SQSClient, SendMessageBatchCommand, GetQueueAttributesCommand, SendMessageBatchCommandOutput, GetQueueAttributesCommandOutput } from '@aws-sdk/client-sqs';

export class AwsSqsAdapter implements SqsService {
  private sqsClient: SQSClient;

  constructor(region: string = 'us-east-1') {
    this.sqsClient = new SQSClient({
      region,
      maxAttempts: 3,
    });
  }

  async sendMessageBatch(command: SendMessageBatchCommand): Promise<SendMessageBatchCommandOutput> {
    return this.sqsClient.send(command);
  }

  async getQueueAttributes(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput> {
    return this.sqsClient.send(command);
  }
}
