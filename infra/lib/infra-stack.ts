import * as path from 'path';
import { Stack, StackProps, CfnOutput, SecretValue, RemovalPolicy } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

import { Networking } from './constructs/networking';
import { EcsCluster } from './constructs/ecs-cluster';
import { SecurityGroups } from './constructs/security-groups';
import { HelloService } from './constructs/hello-service';
import { ApiService } from './constructs/api-service';
import { SqsQueues } from './constructs/sqs-queues';
import { IngestLambda } from './constructs/ingest-lambda';
import { Database } from './constructs/database';
import { BastionHost } from './constructs/bastion-host';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Container Images ----------
    const apiImageAsset = new DockerImageAsset(this, "ApiImage", {
      directory: path.join(__dirname, "../.."),
      file: "services/api/Dockerfile",
    });

    const helloImageAsset = new DockerImageAsset(this, "HelloImage", {
      directory: path.join(__dirname, "../../services/hello"),
      file: "Dockerfile",
    });

    // Configure ECR repositories for cleanup
    // DockerImageAsset creates repositories in the bootstrap stack, but we can configure lifecycle policies
    const configureEcrCleanup = (repo: ecr.IRepository, assetName: string) => {
      // Access the repository's node tree to find the CfnRepository
      const repoConstruct = repo as unknown as Construct;
      const cfnRepo = repoConstruct.node.defaultChild;

      if (cfnRepo instanceof ecr.CfnRepository) {
        // Set lifecycle policy to delete old images
        // Note: Removal policy can't be set on bootstrap stack repositories
        cfnRepo.addPropertyOverride('LifecyclePolicy', {
          rules: [{
            rulePriority: 1,
            description: 'Delete all images when repository is deleted',
            selection: {
              tagStatus: 'any',
            },
            action: {
              type: 'expire',
            },
          }],
        });
      }
    };

    configureEcrCleanup(apiImageAsset.repository, 'api');
    configureEcrCleanup(helloImageAsset.repository, 'hello');

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

    // ---------- Bastion Host (for local dev database access) ----------
    const bastion = new BastionHost(this, 'BastionHost', {
      vpc: networking.vpc,
      dbSecurityGroup: securityGroups.dbSg,
      devIp: process.env.DEV_IP,
    });

    // ---------- SQS Queues ----------
    const sqsQueues = new SqsQueues(this, 'SqsQueues');

    // ---------- OpenAI Secret ----------
    let openaiSecret: secretsmanager.ISecret | undefined;
    if (process.env.OPENAI_SECRET) {
      openaiSecret = new secretsmanager.Secret(this, 'OpenAISecret', {
        description: 'OpenAI API Key for embedding generation',
        secretStringValue: SecretValue.unsafePlainText(process.env.OPENAI_SECRET),
      });
    }

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
      openaiSecret: openaiSecret,
    });

    // Configure ECR cleanup for Lambda image
    configureEcrCleanup(ingestLambda.imageAsset.repository, 'lambda-ingest');

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
      openaiSecret: openaiSecret,
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
    new CfnOutput(this, 'RdsProxyEndpoint', { value: database.proxy.endpoint });
    new CfnOutput(this, 'DatabaseSecretArn', { value: database.secret.secretArn });
    new CfnOutput(this, 'BastionInstanceId', { value: bastion.instance.instanceId });
    new CfnOutput(this, 'BastionPublicIp', { value: bastion.instance.instancePublicIp });
  }
}
