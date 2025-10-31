import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';

export interface BastionHostProps {
  readonly vpc: ec2.IVpc;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly devIp?: string;
}

export class BastionHost extends Construct {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BastionHostProps) {
    super(scope, id);

    const { vpc, dbSecurityGroup, devIp } = props;

    // Security group for the bastion host
    this.securityGroup = new ec2.SecurityGroup(this, 'BastionSg', {
      vpc,
      description: 'Bastion host security group for database access',
      allowAllOutbound: true,
    });

    // Allow SSH access from dev IP if provided
    if (devIp) {
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(`${devIp}/32`),
        ec2.Port.tcp(22),
        'Allow SSH from dev IP'
      );
    }

    // Allow bastion to connect to database (via RDS Proxy)
    dbSecurityGroup.addIngressRule(
      this.securityGroup,
      ec2.Port.tcp(5432),
      'Allow bastion to database via proxy'
    );

    // Create the bastion host EC2 instance
    this.instance = new ec2.Instance(this, 'BastionInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: this.securityGroup,
      keyName: undefined, // Use SSM Session Manager instead of SSH keys
      ssmSessionPermissions: true, // Enable SSM Session Manager
      userData: ec2.UserData.forLinux(),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            deleteOnTermination: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // Add tags
    cdk.Tags.of(this.instance).add('Name', 'Database-Bastion');
    cdk.Tags.of(this.instance).add('Purpose', 'Development-Database-Access');
  }

  /**
   * Get the public IP address of the bastion host
   */
  public getPublicIp(): string {
    return this.instance.instancePublicIp;
  }
}
