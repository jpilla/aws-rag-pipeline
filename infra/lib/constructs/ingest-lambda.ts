import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Duration } from 'aws-cdk-lib';

export interface IngestLambdaProps {
  readonly lambdaCodePath: string;
  readonly ingestQueue: sqs.Queue;
}

export class IngestLambda extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: IngestLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, ingestQueue } = props;

    // Create Lambda function
    this.function = new lambda.DockerImageFunction(this, 'IngestConsumerFn', {
      code: lambda.DockerImageCode.fromImageAsset(lambdaCodePath),
      memorySize: 512,
      timeout: Duration.seconds(20),
      architecture: lambda.Architecture.X86_64,
      environment: {
        LOG_LEVEL: 'info',
        CONCURRENCY: '10',
      },
    });

    // Configure SQS event source
    this.function.addEventSource(
      new lambdaEventSources.SqsEventSource(ingestQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        reportBatchItemFailures: true, // only retry failed records
      })
    );
  }
}
