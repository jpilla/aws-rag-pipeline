import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Duration } from 'aws-cdk-lib';

export interface ApiServiceProps {
  readonly cluster: ecs.Cluster;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly image: ecs.ContainerImage;
  readonly helloServiceUrl?: string;
  readonly ingestQueueUrl?: string;
}

export class ApiService extends Construct {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: ApiServiceProps) {
    super(scope, id);

    const { cluster, vpc, securityGroup, image, helloServiceUrl, ingestQueueUrl } = props;

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
          HELLO_URL: helloServiceUrl || 'http://hello.local:3001', // Service discovery
          SERVICE_DIR: 'services/api',
          ...(ingestQueueUrl && { INGEST_QUEUE_URL: ingestQueueUrl }),
        },
      },
    });

    // Configure health check
    this.configureHealthCheck();
  }

  /**
   * Configure health check for the API service
   */
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


  /**
   * Add environment variables to all containers in the service
   */
  public addEnvironmentVariables(envVars: Record<string, string>): void {
    // Gather containers safely (defaultContainer if set, else scan children)
    const containers: ecs.ContainerDefinition[] = [];
    if (this.service.taskDefinition.defaultContainer) {
      containers.push(this.service.taskDefinition.defaultContainer);
    }
    for (const child of this.service.taskDefinition.node.children) {
      if (child instanceof ecs.ContainerDefinition && !containers.includes(child)) {
        containers.push(child);
      }
    }

    // Add environment variables to all containers
    containers.forEach(container => {
      Object.entries(envVars).forEach(([key, value]) => {
        container.addEnvironment(key, value);
      });
    });
  }

  /**
   * Get the load balancer DNS name
   */
  public getLoadBalancerDnsName(): string {
    return this.service.loadBalancer.loadBalancerDnsName;
  }
}
