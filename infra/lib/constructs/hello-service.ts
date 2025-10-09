import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';

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

    // Add container to task definition
    this.taskDefinition.addContainer('HelloContainer', {
      image,
      portMappings: [{ containerPort: 3001 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'hello' }),
      environment: {
        PORT: '3001',
        SERVICE_DIR: 'services/hello',
      },
    });

    // Create Fargate service
    this.service = new ecs.FargateService(this, 'HelloService', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      securityGroups: [securityGroup],
      assignPublicIp: true, // IMPORTANT (no NAT/endpoints yet)
      vpcSubnets: { subnetGroupName: 'public' }, // place ENIs in public subnets
      cloudMapOptions,
    });
  }

}
