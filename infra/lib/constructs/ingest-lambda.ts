import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';

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
  public readonly imageAsset: DockerImageAsset;

  constructor(scope: Construct, id: string, props: IngestLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, ingestQueue, vpc, securityGroup, databaseSecret, dbHost, dbName, openaiSecret } = props;

    // Create log group with removal policy for Lambda
    const logGroup = new logs.LogGroup(this, 'IngestLambdaLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Create Docker image asset so we can access the repository for cleanup
    // Note: fromImageAsset also creates a repository, but we create this one explicitly
    // so we can configure cleanup. They should use the same location/hash.
    this.imageAsset = new DockerImageAsset(this, 'LambdaImageAsset', {
      directory: lambdaCodePath,
      file: 'lambdas/ingest-queue-reader/Dockerfile',
    });

    this.function = new lambda.DockerImageFunction(this, 'IngestConsumerFn', {
      code: lambda.DockerImageCode.fromImageAsset(lambdaCodePath, {
        file: 'lambdas/ingest-queue-reader/Dockerfile',
      }),
      memorySize: 2048,
      timeout: Duration.seconds(15),
      architecture: lambda.Architecture.X86_64,
      vpc,
      vpcSubnets: { subnetGroupName: 'private-egress' },
      securityGroups: [securityGroup],
      logGroup,
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
