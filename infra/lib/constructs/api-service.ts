import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';

export interface ApiServiceProps {
  readonly cluster: ecs.Cluster;
  readonly securityGroup: ec2.SecurityGroup;
  readonly image: ecs.ContainerImage;

  readonly helloServiceUrl?: string;
  readonly ingestQueueUrl?: string;

  readonly databaseSecret: secretsmanager.ISecret;
  readonly openaiSecret?: secretsmanager.ISecret;
  readonly dbHost: string;
  readonly dbName: string;
}

export class ApiService extends Construct {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);

    const {
      cluster,
      securityGroup,
      image,
      helloServiceUrl,
      ingestQueueUrl,
      databaseSecret,
      openaiSecret,
      dbHost,
      dbName,
    } = props;

    // Build envs clearly (no "weird" spread)
    const env: Record<string, string> = {
      PORT: '3000',
      HELLO_URL: helloServiceUrl ?? 'http://hello.local:3001',
      SERVICE_DIR: 'services/api',
      DB_HOST: dbHost,
      DB_NAME: dbName,
      DB_PORT: '5432',
      ...(ingestQueueUrl && { INGEST_QUEUE_URL: ingestQueueUrl }),
    };

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      desiredCount: 2,
      cpu: 256,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      listenerPort: 80,
      taskSubnets: { subnetGroupName: 'private-egress' },
      assignPublicIp: false,
      securityGroups: [securityGroup],
      healthCheckGracePeriod: Duration.seconds(10),
      circuitBreaker: {
        enable: true,
        rollback: true
      },
      taskImageOptions: {
        image,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'api',
          logGroup: new logs.LogGroup(this, 'ApiLogGroup', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_WEEK,
          }),
        }),
        environment: env,
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password'),
          ...(openaiSecret && { OPENAI_SECRET: ecs.Secret.fromSecretsManager(openaiSecret) }),
        },
      },
    });

    // Make health checks much more aggressive for faster failure detection
    this.service.targetGroup.configureHealthCheck({
      path: '/healthz',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(10),
      timeout: Duration.seconds(3),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });

    // Give the ECS agent + task permission to read the DB secret
    databaseSecret.grantRead(this.service.taskDefinition.executionRole!);
    databaseSecret.grantRead(this.service.taskDefinition.taskRole);

    // Give the ECS agent + task permission to read the OpenAI secret if provided
    if (openaiSecret) {
      openaiSecret.grantRead(this.service.taskDefinition.executionRole!);
      openaiSecret.grantRead(this.service.taskDefinition.taskRole);
    }
  }

  public getLoadBalancerDnsName(): string {
    return this.service.loadBalancer.loadBalancerDnsName;
  }
}
