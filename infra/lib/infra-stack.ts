import * as path from 'path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
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

    // ---------- Inputs ----------
    const ecrRepo = this.node.tryGetContext('ecrRepo');
    const imageTag = this.node.tryGetContext('imageTag');
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', ecrRepo.split('/').pop()!);
    const image = ecs.ContainerImage.fromEcrRepository(repo!, imageTag);

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
    repo.grantPull(apiService.service.taskDefinition.executionRole!);
    repo.grantPull(helloService.taskDefinition.executionRole!);

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
  }
}