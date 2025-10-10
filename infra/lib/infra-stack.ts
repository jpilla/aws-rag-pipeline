import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

// Import our modular constructs
import { Networking } from './constructs/networking';
import { EcsCluster } from './constructs/ecs-cluster';
import { SecurityGroups } from './constructs/security-groups';
import { HelloService } from './constructs/hello-service';
import { ApiService } from './constructs/api-service';
import { SqsQueues } from './constructs/sqs-queues';
import { IngestLambda } from './constructs/ingest-lambda';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- ECR Repository ----------
    const ecrRepo = new ecr.Repository(this, 'EcrRepo', {
      repositoryName: 'express-api-docker',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Allow deletion when stack is destroyed
      autoDeleteImages: true, // Automatically delete images when repository is deleted
      lifecycleRules: [{
        maxImageCount: 10, // Keep only 10 most recent images
        rulePriority: 1,
        description: 'Delete old images to save costs',
      }],
    });

    // ---------- Container Image ----------
    // CDK will automatically build and push the Docker image from the Dockerfile
    const image = ecs.ContainerImage.fromDockerImageAsset(
      new DockerImageAsset(this, 'ApiImage', {
        directory: path.join(__dirname, '../..'), // Project root
        file: 'Dockerfile',
        buildArgs: {
          SERVICE_DIR: 'services/api',
        },
        exclude: [
          'infra/cdk.out/**',
          'infra/node_modules/**',
          'node_modules/**',
          '.git/**',
        ],
      })
    );

    // ---------- Networking ----------
    const networking = new Networking(this, 'Networking');

    // ---------- ECS Cluster and Service Discovery ----------
    const ecsCluster = new EcsCluster(this, 'EcsCluster', {
      vpc: networking.vpc,
    });

    // ---------- Security Groups ----------
    const securityGroups = new SecurityGroups(this, 'SecurityGroups', {
      vpc: networking.vpc,
    });

    // ---------- Hello Service (internal-only via Cloud Map) ----------
    const helloService = new HelloService(this, 'HelloService', {
      cluster: ecsCluster.cluster,
      vpc: networking.vpc,
      securityGroup: securityGroups.helloSg,
      image,
      cloudMapOptions: ecsCluster.getServiceDiscoveryConfig('hello'),
    });

    // ---------- API Service (public ALB) ----------
    const apiService = new ApiService(this, 'ApiService', {
      cluster: ecsCluster.cluster,
      vpc: networking.vpc,
      securityGroup: securityGroups.apiSg,
      image,
      helloServiceUrl: 'http://hello.local:3001',
    });

    // ---------- SQS Queues ----------
    const sqsQueues = new SqsQueues(this, 'SqsQueues');

    // ---------- Ingest Lambda ----------
    const ingestLambda = new IngestLambda(this, 'IngestLambda', {
      lambdaCodePath: path.join(__dirname, '../../lambdas/ingest-queue-reader'),
      ingestQueue: sqsQueues.ingestQueue,
    });

    // ---------- Permissions and Environment Variables ----------
    // ECR pull permissions
    ecrRepo.grantPull(apiService.service.taskDefinition.executionRole!);
    ecrRepo.grantPull(helloService.taskDefinition.executionRole!);

    // SQS permissions and environment variables
    sqsQueues.ingestQueue.grantSendMessages(apiService.service.taskDefinition.taskRole);
    apiService.addEnvironmentVariables({
      INGEST_QUEUE_URL: sqsQueues.getQueueUrl(),
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'VpcId', { value: networking.vpc.vpcId });
    new CfnOutput(this, 'PublicSubnets', { value: networking.getPublicSubnetIds() });
    new CfnOutput(this, 'IsolatedSubnets', { value: networking.getIsolatedSubnetIds() });
    new CfnOutput(this, 'AlbDnsName', { value: apiService.getLoadBalancerDnsName() });
    new CfnOutput(this, 'IngestQueueUrl', { value: sqsQueues.getQueueUrl() });
    new CfnOutput(this, 'EcrRepositoryUri', { value: ecrRepo.repositoryUri });
  }
}