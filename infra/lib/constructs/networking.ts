import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Tags } from 'aws-cdk-lib';

export interface NetworkingProps {
  readonly maxAzs?: number;
  readonly natGateways?: number;
}

export class Networking extends Construct {
  public readonly vpc: ec2.Vpc;
  private readonly publicSubnets: ec2.ISubnet[];
  private readonly isolatedSubnets: ec2.ISubnet[];

  constructor(scope: Construct, id: string, props: NetworkingProps = {}) {
    super(scope, id);

    const { maxAzs = 2, natGateways = 0 } = props;

    // Create VPC with public and isolated subnets
    this.vpc = new ec2.Vpc(this, 'AppVpc', {
      maxAzs,
      natGateways,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24
        },
        {
          name: 'db-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24
        },
      ],
    });

    // Add tags to VPC
    Tags.of(this.vpc).add('App', 'express-embeddings');
    Tags.of(this.vpc).add('Env', 'prod');

    // Store subnet references for easy access
    this.publicSubnets = this.vpc.selectSubnets({ subnetGroupName: 'public' }).subnets;
    this.isolatedSubnets = this.vpc.selectSubnets({ subnetGroupName: 'db-isolated' }).subnets;
  }

  /**
   * Get public subnet IDs as comma-separated string
   */
  public getPublicSubnetIds(): string {
    return this.vpc.selectSubnets({ subnetGroupName: 'public' }).subnetIds.join(',');
  }

  /**
   * Get isolated subnet IDs as comma-separated string
   */
  public getIsolatedSubnetIds(): string {
    return this.vpc.selectSubnets({ subnetGroupName: 'db-isolated' }).subnetIds.join(',');
  }
}
