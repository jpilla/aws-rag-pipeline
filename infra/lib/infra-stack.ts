import * as path from 'path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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
import { Database } from './constructs/database';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Container Images ----------
    const apiImageAsset = new DockerImageAsset(this, "ApiImage", {
      directory: path.join(__dirname, "../.."), // points to the project root
      file: "services/api/Dockerfile",
    });

    const helloImageAsset = new DockerImageAsset(this, "HelloImage", {
      directory: path.join(__dirname, "../../services/hello"),
      file: "Dockerfile",
    });

    // Convert to ECS images
    const apiImage = ecs.ContainerImage.fromDockerImageAsset(apiImageAsset);
    const helloImage = ecs.ContainerImage.fromDockerImageAsset(helloImageAsset);

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

    // ---------- Database (RDS with RDS Proxy) ----------
    const database = new Database(this, 'Database', {
      vpc: networking.vpc,
      dbSecurityGroup: securityGroups.dbSg,
    });

    // ---------- SQS Queues ----------
    const sqsQueues = new SqsQueues(this, 'SqsQueues');

    // ---------- Ingest Lambda ----------
    const ingestLambda = new IngestLambda(this, 'IngestLambda', {
      // ⛳️ Use project root so both lambda and prisma are accessible
      lambdaCodePath: path.join(__dirname, '../..'),
      ingestQueue: sqsQueues.ingestQueue,
      vpc: networking.vpc,
      securityGroup: securityGroups.apiSg,
      databaseSecret: database.secret,
      dbHost: database.proxy.endpoint,
      dbName: 'embeddings',
      openaiApiKey: process.env.OPENAI_SECRET,
    });

    // ---------- Hello Service (internal-only via Cloud Map) ----------
    const helloService = new HelloService(this, 'HelloService', {
      cluster: ecsCluster.cluster,
      vpc: networking.vpc,
      securityGroup: securityGroups.helloSg,
      image: helloImage,
      cloudMapOptions: ecsCluster.getServiceDiscoveryConfig('hello'),
    });

    const apiService = new ApiService(this, 'ApiService', {
      cluster: ecsCluster.cluster,
      securityGroup: securityGroups.apiSg,
      image: apiImage,
      helloServiceUrl: 'http://hello.local:3001',
      ingestQueueUrl: sqsQueues.ingestQueue.queueUrl,
      databaseSecret: database.secret,
      dbHost: database.proxy.endpoint,
      dbName: 'embeddings',
    });

    // Allow API tasks to reach the RDS Proxy on 5432
    database.proxy.connections.allowFrom(
      securityGroups.apiSg,
      ec2.Port.tcp(5432),
      'API to Proxy 5432'
    );

    // Allow the Proxy to reach the DB instance on 5432
    database.instance.connections.allowFrom(
      database.proxy,
      ec2.Port.tcp(5432),
      'Proxy to DB 5432'
    );

    database.secret.grantRead(apiService.service.taskDefinition.executionRole!);
    database.secret.grantRead(apiService.service.taskDefinition.taskRole!);

    // make sure ECS waits for DB resources
    apiService.node.addDependency(database);

    // ---------- Permissions and Environment Variables ----------

    // SQS permissions and environment variables
    sqsQueues.ingestQueue.grantSendMessages(apiService.service.taskDefinition.taskRole);

    // ---------- Outputs ----------
    new CfnOutput(this, 'VpcId', { value: networking.vpc.vpcId });
    new CfnOutput(this, 'PublicSubnets', { value: networking.getPublicSubnetIds() });
    new CfnOutput(this, 'IsolatedSubnets', { value: networking.getIsolatedSubnetIds() });
    new CfnOutput(this, 'AlbDnsName', { value: apiService.getLoadBalancerDnsName() });
    new CfnOutput(this, 'IngestQueueUrl', { value: sqsQueues.getQueueUrl() });
  }
}