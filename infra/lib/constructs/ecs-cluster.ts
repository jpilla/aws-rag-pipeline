import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Duration } from 'aws-cdk-lib';

export interface EcsClusterProps {
  readonly vpc: ec2.IVpc;
  readonly namespaceName?: string;
}

export class EcsCluster extends Construct {
  public readonly cluster: ecs.Cluster;
  private readonly namespace: servicediscovery.PrivateDnsNamespace;

  constructor(scope: Construct, id: string, props: EcsClusterProps) {
    super(scope, id);

    const { vpc, namespaceName = 'local' } = props;

    // Create ECS Cluster
    this.cluster = new ecs.Cluster(this, 'EcsCluster', { vpc });

    // Create private DNS namespace for service discovery
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'ServiceNamespace', {
      name: namespaceName,
      vpc,
    });
  }

  /**
   * Get service discovery configuration for a service
   */
  public getServiceDiscoveryConfig(serviceName: string): ecs.CloudMapOptions {
    return {
      cloudMapNamespace: this.namespace,
      name: serviceName,
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: Duration.seconds(10),
    };
  }
}
