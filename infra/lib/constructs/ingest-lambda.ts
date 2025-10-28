import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SecretValue } from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';

export interface IngestLambdaProps {
  readonly lambdaCodePath: string;
  readonly ingestQueue: sqs.Queue;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly dbHost: string;
  readonly dbName: string;
  readonly openaiSecret?: secretsmanager.ISecret;
}

export class IngestLambda extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: IngestLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, ingestQueue, vpc, securityGroup, databaseSecret, dbHost, dbName, openaiSecret } = props;

    this.function = new lambda.DockerImageFunction(this, 'IngestConsumerFn', {
      code: lambda.DockerImageCode.fromImageAsset(lambdaCodePath, {
        // Build context is project root, Dockerfile is in lambdas/ingest-queue-reader/
        file: 'lambdas/ingest-queue-reader/Dockerfile',
      }),
      memorySize: 2048,
      timeout: Duration.seconds(15),
      architecture: lambda.Architecture.X86_64,
      vpc,
      vpcSubnets: { subnetGroupName: 'private-egress' },
      securityGroups: [securityGroup],
      environment: {
        LOG_LEVEL: 'info',
        DB_HOST: dbHost,
        DB_NAME: dbName,
        DB_PORT: '5432',
        DB_SECRET_ARN: databaseSecret.secretArn,
        OPENAI_SECRET_ARN: openaiSecret?.secretArn || '',
      },
    });

    // Configure SQS event source
    this.function.addEventSource(
      new lambdaEventSources.SqsEventSource(ingestQueue, {
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(3),
        reportBatchItemFailures: true,
      })
    );

    // Grant lambda function access to database secret
    databaseSecret.grantRead(this.function);

    // Grant lambda function access to OpenAI secret if created
    if (openaiSecret) {
      openaiSecret.grantRead(this.function);
    }
  }
}
