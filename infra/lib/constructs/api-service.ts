import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Duration } from 'aws-cdk-lib';

export interface ApiServiceProps {
  readonly cluster: ecs.Cluster;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly image: ecs.ContainerImage;
  readonly helloServiceUrl?: string;
  readonly ingestQueueUrl?: string;
  readonly databaseUrlSecret: secretsmanager.ISecret;
}

export class ApiService extends Construct {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);

    const { cluster, vpc, securityGroup, image, helloServiceUrl, ingestQueueUrl, databaseUrlSecret } = props;

    // Create API service with ALB
    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      listenerPort: 80,
      taskSubnets: { subnetGroupName: 'public' },
      assignPublicIp: true, // IMPORTANT (no NAT/endpoints yet)
      securityGroups: [securityGroup],
      taskImageOptions: {
        image,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api' }),
        environment: {
          PORT: '3000',
          HELLO_URL: helloServiceUrl || 'http://hello.local:3001',
          SERVICE_DIR: 'services/api',
          ...(ingestQueueUrl && { INGEST_QUEUE_URL: ingestQueueUrl }),
        },
      },
    });

    // Inject DATABASE_URL secret into all containers in the task
    this.addSecretToAllContainers('DATABASE_URL', ecs.Secret.fromSecretsManager(databaseUrlSecret, 'DATABASE_URL'));

    // Configure health check
    this.configureHealthCheck();
  }

  /** Configure health check for the API service */
  private configureHealthCheck(): void {
    this.service.targetGroup.configureHealthCheck({
      path: '/healthz',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });
  }

  /** Add environment variables to all containers in the service */
  public addEnvironmentVariables(envVars: Record<string, string>): void {
    this.getAllContainers().forEach(container => {
      Object.entries(envVars).forEach(([k, v]) => container.addEnvironment(k, v));
    });
  }

  /** (new) Add a secret to all containers */
  private addSecretToAllContainers(name: string, secret: ecs.Secret): void {
    this.getAllContainers().forEach(container => {
      container.addSecret(name, secret);
    });
  }

  /** Gather all containers in the task definition */
  private getAllContainers(): ecs.ContainerDefinition[] {
    const containers: ecs.ContainerDefinition[] = [];
    const def = this.service.taskDefinition;

    if (def.defaultContainer) containers.push(def.defaultContainer);
    for (const child of def.node.children) {
      if (child instanceof ecs.ContainerDefinition && !containers.includes(child)) {
        containers.push(child);
      }
    }
    return containers;
  }

  /** Get the load balancer DNS name */
  public getLoadBalancerDnsName(): string {
    return this.service.loadBalancer.loadBalancerDnsName;
  }
}