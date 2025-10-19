import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

export interface IngestLambdaProps {
  readonly lambdaCodePath: string;
  readonly ingestQueue: sqs.Queue;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly dbHost: string;
  readonly dbName: string;
}

export class IngestLambda extends Construct {
  public readonly function: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: IngestLambdaProps) {
    super(scope, id);

    const { lambdaCodePath, ingestQueue, vpc, securityGroup, databaseSecret, dbHost, dbName } = props;

    // Create Lambda function
    this.function = new lambda.DockerImageFunction(this, 'IngestConsumerFn', {
      code: lambda.DockerImageCode.fromImageAsset(lambdaCodePath, {
        file: 'lambdas/ingest-queue-reader/Dockerfile',
      }),
      memorySize: 512,
      timeout: Duration.seconds(15),
      architecture: lambda.Architecture.X86_64,
      vpc: vpc,
      vpcSubnets: { subnetGroupName: 'private-egress' },
      securityGroups: [securityGroup],
      environment: {
        LOG_LEVEL: 'info',
        CONCURRENCY: '10',
        DB_HOST: dbHost,
        DB_NAME: dbName,
        DB_PORT: '5432',
        DB_SECRET_ARN: databaseSecret.secretArn,
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
  }
}
