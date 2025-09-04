import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
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

    // Create a private DNS namespace for service discovery
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceNamespace', {
      name: 'local',
      vpc,
    });

    // Create security groups
    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'Security group for API service',
      allowAllOutbound: false, // More restrictive - only allow specific outbound traffic
    });

    const helloSecurityGroup = new ec2.SecurityGroup(this, 'HelloSecurityGroup', {
      vpc,
      description: 'Security group for Hello service',
      allowAllOutbound: false, // More restrictive - only allow specific outbound traffic
    });

    // Allow API service to communicate with Hello service
    helloSecurityGroup.addIngressRule(
      apiSecurityGroup,
      ec2.Port.tcp(3001),
      'Allow API service to reach Hello service'
    );

    // Add specific outbound rules for API service
    // Allow HTTPS outbound for external API calls (if needed)
    apiSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound for external API calls'
    );

    // Allow HTTP outbound for external API calls (if needed)
    apiSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP outbound for external API calls'
    );

    // Allow API service to call Hello on 3001
    apiSecurityGroup.addEgressRule(
      helloSecurityGroup,
      ec2.Port.tcp(3001),
      'Allow API to call Hello on 3001'
    );

    // Add specific outbound rules for Hello service
    // Allow HTTPS outbound for any external dependencies
    helloSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound for external dependencies'
    );

    // Allow access to VPC endpoints for ECR
    helloSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow access to VPC endpoints for ECR'
    );

    // Create VPC endpoints for ECR to allow private communication
    const ecrApiEndpoint = new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
    });

    const ecrDockerEndpoint = new ec2.InterfaceVpcEndpoint(this, 'EcrDockerEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
    });

    const s3Endpoint = new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Add CloudWatch Logs VPC endpoint for private tasks
    const cloudWatchLogsEndpoint = new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
    });

    // Add CloudWatch VPC endpoint for metrics
    const cloudWatchEndpoint = new ec2.InterfaceVpcEndpoint(this, 'CloudWatchEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
      privateDnsEnabled: true,
    });

    // Deploy Hello service (internal only)
    const helloService = new ecs.FargateService(this, 'HelloService', {
      cluster,
      taskDefinition: new ecs.FargateTaskDefinition(this, 'HelloTaskDef', {
        cpu: 256,
        memoryLimitMiB: 512,
      }),
      desiredCount: 1,
      securityGroups: [helloSecurityGroup],
      assignPublicIp: false, // Keep internal
    });

    // Add Hello container to task definition
    const helloContainer = helloService.taskDefinition.addContainer('HelloContainer', {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'hello' }),
      environment: {
        PORT: '3001',
        SERVICE_DIR: 'services/hello', // This will be used by your Dockerfile
      },
    });

    helloContainer.addPortMappings({
      containerPort: 3001,
      protocol: ecs.Protocol.TCP,
    });

    // Register Hello service with service discovery
    const helloServiceDiscovery = helloService.associateCloudMapService({
      service: new servicediscovery.Service(this, 'HelloServiceDiscovery', {
        namespace,
        name: 'hello',
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
      }),
    });

    // Deploy API service (public-facing with ALB)
    const apiService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'ApiService', {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      listenerPort: 80,
      assignPublicIp: true,
      securityGroups: [apiSecurityGroup],
      taskImageOptions: {
        image: containerImage,
        containerPort: 3000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api' }),
        environment: {
          PORT: '3000',
          HELLO_URL: 'http://hello.local:3001', // Use service discovery
          SERVICE_DIR: 'services/api', // This will be used by your Dockerfile
        },
      },
      publicLoadBalancer: true,
    });

    // Configure health check for API service
    apiService.targetGroup.configureHealthCheck({
      path: '/healthz',
      port: '3000',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      unhealthyThresholdCount: 2,
      healthyThresholdCount: 2,
    });

    // Grant ECR pull permissions to both services
    repo.grantPull(apiService.taskDefinition.executionRole!);
    repo.grantPull(helloService.taskDefinition.executionRole!);
  }
}