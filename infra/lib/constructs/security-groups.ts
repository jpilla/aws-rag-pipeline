import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface SecurityGroupsProps {
  readonly vpc: ec2.IVpc;
}

export interface SecurityGroupRefs {
  readonly apiSg: ec2.SecurityGroup;
  readonly helloSg: ec2.SecurityGroup;
}

export class SecurityGroups extends Construct {
  public readonly apiSg: ec2.SecurityGroup;
  public readonly helloSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);

    const { vpc } = props;

    // API Security Group
    this.apiSg = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc,
      description: 'API service SG',
      allowAllOutbound: true,
    });

    // Hello Security Group
    this.helloSg = new ec2.SecurityGroup(this, 'HelloSg', {
      vpc,
      description: 'Hello service SG',
      allowAllOutbound: true,
    });

    // Configure API -> Hello communication
    this.configureApiToHelloAccess();
  }

  /**
   * Configure security group rules for API to Hello service communication
   */
  private configureApiToHelloAccess(): void {
    // API -> Hello on port 3001
    this.helloSg.addIngressRule(
      this.apiSg,
      ec2.Port.tcp(3001),
      'API to Hello (3001)'
    );
  }

  /**
   * Get all security groups as an array
   */
  public getAllSecurityGroups(): ec2.SecurityGroup[] {
    return [this.apiSg, this.helloSg];
  }

  /**
   * Get security group references for easy access
   */
  public getSecurityGroupRefs(): SecurityGroupRefs {
    return {
      apiSg: this.apiSg,
      helloSg: this.helloSg,
    };
  }
}
