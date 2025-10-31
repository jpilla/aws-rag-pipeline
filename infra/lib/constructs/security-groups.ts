import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface SecurityGroupsProps {
  readonly vpc: ec2.IVpc;
}

export interface SecurityGroupRefs {
  readonly apiSg: ec2.SecurityGroup;
  readonly helloSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
}

export class SecurityGroups extends Construct {
  public readonly apiSg: ec2.SecurityGroup;
  public readonly helloSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;

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

    // Database Security Group
    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Database and RDS Proxy SG',
      allowAllOutbound: false, // Database doesn't need outbound access
    });

    // Configure access rules
    this.configureApiToHelloAccess();
    this.configureApiToDatabaseAccess();
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
   * Configure security group rules for API to Database access
   */
  private configureApiToDatabaseAccess(): void {
    // API -> Database on PostgreSQL port 5432
    this.dbSg.addIngressRule(
      this.apiSg,
      ec2.Port.tcp(5432),
      'API to Database (5432)'
    );

    // Allow dev IP if provided for local development
    if (process.env.DEV_IP) {
      this.dbSg.addIngressRule(
        ec2.Peer.ipv4(`${process.env.DEV_IP}/32`),
        ec2.Port.tcp(5432),
        'Dev local access'
      );
    }
  }

  /**
   * Get all security groups as an array
   */
  public getAllSecurityGroups(): ec2.SecurityGroup[] {
    return [this.apiSg, this.helloSg, this.dbSg];
  }

  /**
   * Get security group references for easy access
   */
  public getSecurityGroupRefs(): SecurityGroupRefs {
    return {
      apiSg: this.apiSg,
      helloSg: this.helloSg,
      dbSg: this.dbSg,
    };
  }
}
