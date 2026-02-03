import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';

export interface HelloServiceProps {
  readonly cluster: ecs.Cluster;
  readonly vpc: ec2.IVpc;
  readonly securityGroup: ec2.SecurityGroup;
  readonly image: ecs.ContainerImage;
  readonly cloudMapOptions: ecs.CloudMapOptions;
}

export class HelloService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: HelloServiceProps) {
    super(scope, id);

    const { cluster, vpc, securityGroup, image, cloudMapOptions } = props;

    // Create task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'HelloTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // Create log group with removal policy
    const logGroup = new logs.LogGroup(this, 'HelloLogGroup', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // Add container to task definition
    this.taskDefinition.addContainer('HelloContainer', {
      image,
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hello',
        logGroup,
      }),
      environment: {
        PORT: '3001',
        SERVICE_DIR: 'services/hello',
      },
    });

    // Create Fargate service
    this.service = new ecs.FargateService(this, 'HelloService', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 2,
      securityGroups: [securityGroup],
      assignPublicIp: false,
      vpcSubnets: { subnetGroupName: 'private-egress' },
      cloudMapOptions,
      // Add health check grace period for consistency
      healthCheckGracePeriod: Duration.seconds(30),
      // Enable deployment circuit breaker for faster failure detection
      circuitBreaker: {
        enable: true,
        rollback: true
      },
    });
  }

}
