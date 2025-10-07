import { Stack, StackProps, Duration, CfnOutput, Tags } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------- Inputs ----------
    const ecrRepo = this.node.tryGetContext('ecrRepo');
    const imageTag = this.node.tryGetContext('imageTag');
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', ecrRepo.split('/').pop()!);
    const image = ecs.ContainerImage.fromEcrRepository(repo!, imageTag);

    // ---------- VPC (yours) ----------
    // No NAT yet. Public subnets for ALB + tasks, isolated subnets for Aurora later.
    const vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'db-isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    Tags.of(vpc).add('App', 'express-embeddings');
    Tags.of(vpc).add('Env', 'prod');

    // ---------- ECS Cluster ----------
    const cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // Private DNS namespace for service discovery (hello.local)
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceNamespace', {
      name: 'local',
      vpc,
    });

    // ---------- Security Groups (keep simple while public IPs are on) ----------
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'API service SG',
      allowAllOutbound: true,
    });

    const helloSg = new ec2.SecurityGroup(this, 'HelloSg', {
      vpc,
      description: 'Hello service SG',
      allowAllOutbound: true,
    });

    // API -> Hello on 3001
    helloSg.addIngressRule(apiSg, ec2.Port.tcp(3001), 'API to Hello (3001)');

    // ---------- Hello service (internal-only via Cloud Map) ----------
    const helloTaskDef = new ecs.FargateTaskDefinition(this, 'HelloTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    helloTaskDef.addContainer('HelloContainer', {
      image: image,
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'hello' }),
      environment: {
        PORT: '3001',
        SERVICE_DIR: 'services/hello',
      },
    });

    const helloService = new ecs.FargateService(this, 'HelloService', {
      cluster,
      taskDefinition: helloTaskDef,
      desiredCount: 1,
      securityGroups: [helloSg],
      assignPublicIp: true,                         // IMPORTANT (no NAT/endpoints yet)
      vpcSubnets: { subnetGroupName: 'public' },   // place ENIs in public subnets
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'hello',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      },
    });

    // ---------- API service (public ALB) ----------
    const apiService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      desiredCount: 1,
      cpu: 256,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      listenerPort: 80,
      taskSubnets: { subnetGroupName: 'public' },
      assignPublicIp: true,                        // IMPORTANT (no NAT/endpoints yet)
      securityGroups: [apiSg],
      taskImageOptions: {
        image: image,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api' }),
        environment: {
          PORT: '3000',
          HELLO_URL: 'http://hello.local:3001',   // Service discovery
          SERVICE_DIR: 'services/api',
        },
      },
    });

    apiService.targetGroup.configureHealthCheck({
      path: '/healthz',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });

    // ECR pull permissions
    repo.grantPull(apiService.taskDefinition.executionRole!);
    repo.grantPull(helloService.taskDefinition.executionRole!);

    // SQS
    const dlq = new sqs.Queue(this, "IngestDlq", {
      queueName: "app-ingest-dlq",
      retentionPeriod: Duration.days(2),
      enforceSSL: true,
    });

    const ingestQueue = new sqs.Queue(this, "IngestQueue", {
      queueName: "app-ingest",
      visibilityTimeout: Duration.seconds(20),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      enforceSSL: true,
    });

    // Grant + inject env
    ingestQueue.grantSendMessages(apiService.taskDefinition.taskRole);

    // Gather containers safely (defaultContainer if set, else scan children)
    const containers: ecs.ContainerDefinition[] = [];
    if (apiService.taskDefinition.defaultContainer) {
      containers.push(apiService.taskDefinition.defaultContainer);
    }
    for (const child of apiService.taskDefinition.node.children) {
      if (child instanceof ecs.ContainerDefinition && !containers.includes(child)) {
        containers.push(child);
      }
    }

    // Inject env
    containers.forEach(c => c.addEnvironment("INGEST_QUEUE_URL", ingestQueue.queueUrl));

    // ---------- Outputs ----------
    new CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new CfnOutput(this, 'PublicSubnets', {
      value: vpc.selectSubnets({ subnetGroupName: 'public' }).subnetIds.join(','),
    });
    new CfnOutput(this, 'IsolatedSubnets', {
      value: vpc.selectSubnets({ subnetGroupName: 'db-isolated' }).subnetIds.join(','),
    });
    new CfnOutput(this, 'AlbDnsName', { value: apiService.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "IngestQueueUrl", { value: ingestQueue.queueUrl });

  }
}