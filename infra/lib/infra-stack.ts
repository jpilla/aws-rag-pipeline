import * as path from 'path';
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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
      directory: path.join(__dirname, "../../services/api"), // points to the service folder
      file: "Dockerfile",
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

    // ---------- Hello Service (internal-only via Cloud Map) ----------
    const helloService = new HelloService(this, 'HelloService', {
      cluster: ecsCluster.cluster,
      vpc: networking.vpc,
      securityGroup: securityGroups.helloSg,
      image: helloImage,
      cloudMapOptions: ecsCluster.getServiceDiscoveryConfig('hello'),
    });

    // ---------- API Service (public ALB) ----------
    const apiService = new ApiService(this, 'ApiService', {
      cluster: ecsCluster.cluster,
      vpc: networking.vpc,
      securityGroup: securityGroups.apiSg,
      image: apiImage,
      helloServiceUrl: 'http://hello.local:3001',
      databaseUrlSecret: database.databaseUrlSecret,
    });

    // ---------- SQS Queues ----------
    const sqsQueues = new SqsQueues(this, 'SqsQueues');

    // ---------- Ingest Lambda ----------
    const ingestLambda = new IngestLambda(this, 'IngestLambda', {
      lambdaCodePath: path.join(__dirname, '../../lambdas/ingest-queue-reader'),
      ingestQueue: sqsQueues.ingestQueue,
    });

    // ---------- Permissions and Environment Variables ----------

    // SQS permissions and environment variables
    sqsQueues.ingestQueue.grantSendMessages(apiService.service.taskDefinition.taskRole);
  
    // Database permissions and environment variables
    database.grantSecretRead(apiService.service.taskDefinition.taskRole);
    // allow the task to read the DATABASE_URL secret
    database.databaseUrlSecret.grantRead(apiService.service.taskDefinition.taskRole); 
    const dbConfig = database.getConnectionConfig();
  
    apiService.addEnvironmentVariables({
      INGEST_QUEUE_URL: sqsQueues.getQueueUrl(),
      DB_HOST: dbConfig.host,
      DB_PORT: dbConfig.port,
      DB_NAME: dbConfig.database,
      DB_SECRET_ARN: dbConfig.secretArn,
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'VpcId', { value: networking.vpc.vpcId });
    new CfnOutput(this, 'PublicSubnets', { value: networking.getPublicSubnetIds() });
    new CfnOutput(this, 'IsolatedSubnets', { value: networking.getIsolatedSubnetIds() });
    new CfnOutput(this, 'AlbDnsName', { value: apiService.getLoadBalancerDnsName() });
    new CfnOutput(this, 'IngestQueueUrl', { value: sqsQueues.getQueueUrl() });
  }
}