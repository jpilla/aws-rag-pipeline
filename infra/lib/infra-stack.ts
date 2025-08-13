import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Construct } from 'constructs';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const imageTag = this.node.tryGetContext('imageTag');
    if (!imageTag) {
      throw new Error('Missing context variable: imageTag'); // requires makefile to be run
    }
    const repo = ecr.Repository.fromRepositoryName(this, 'AppRepo', 'express-api-docker');
    const containerImage = ecs.ContainerImage.fromEcrRepository(repo, `prod-${imageTag}`);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      isDefault: true,
    });

    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
    });

    const service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'FargateService', {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      listenerPort: 80,
      assignPublicIp: true,
      taskImageOptions: {
        image: containerImage,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'app' }),
        environment: {
          APPLICATION_PORT: '3000',
        },
      },
      publicLoadBalancer: true,
    });

    service.targetGroup.configureHealthCheck({
      path: '/health',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });

    repo.grantPull(service.taskDefinition.executionRole!);
  }
}