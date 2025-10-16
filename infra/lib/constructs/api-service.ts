import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

export interface ApiServiceProps {
  readonly cluster: ecs.Cluster;
  readonly securityGroup: ec2.SecurityGroup;
  readonly image: ecs.ContainerImage;

  readonly helloServiceUrl?: string;
  readonly ingestQueueUrl?: string;

  readonly databaseSecret: secretsmanager.ISecret; // { username, password }
  readonly dbHost: string;                          // RDS Proxy endpoint
  readonly dbName: string;                          // e.g. "embeddings"
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
      dbHost,
      dbName,
    } = props;

    // Build envs clearly (no “weird” spread)
    const env: Record<string, string> = {
      PORT: '3000',
      HELLO_URL: helloServiceUrl ?? 'http://hello.local:3001',
      SERVICE_DIR: 'services/api',
      DB_HOST: dbHost,
      DB_NAME: dbName,
      ...(ingestQueueUrl && { INGEST_QUEUE_URL: ingestQueueUrl }),
    };

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      listenerPort: 80,
      taskSubnets: { subnetGroupName: 'public' },
      assignPublicIp: true, // fine for POC
      securityGroups: [securityGroup],
      taskImageOptions: {
        image,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api' }),
        environment: env,
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password'),
        },
      },
    });

    // Health check
    this.service.targetGroup.configureHealthCheck({
      path: '/healthz',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });

    // Give the ECS agent + task permission to read the DB secret
    databaseSecret.grantRead(this.service.taskDefinition.executionRole!);
    databaseSecret.grantRead(this.service.taskDefinition.taskRole);

    // // Optional startup grace (migrations)
    // this.service.service.healthCheckGracePeriod = Duration.seconds(60);
  }

  public getLoadBalancerDnsName(): string {
    return this.service.loadBalancer.loadBalancerDnsName;
  }
}