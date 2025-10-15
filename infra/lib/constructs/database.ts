import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface DatabaseProps {
  readonly vpc: ec2.Vpc;
  readonly dbSecurityGroup: ec2.SecurityGroup;
}

export class Database extends Construct {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly proxy: rds.DatabaseProxy;
  public readonly secret: secretsmanager.Secret;
  public readonly proxyEndpoint: string;
  public readonly databaseUrlSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const { vpc, dbSecurityGroup } = props;

    // Create database credentials in Secrets Manager
    this.secret = new secretsmanager.Secret(this, 'DBSecret', {
      secretName: 'embeddings-db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 32,
      },
    });

    const dbName = this.getConnectionConfig().database;
    // This secret stores a runtime-resolved DATABASE_URL that always uses the
    // CURRENT username/password from your master secret and the proxy endpoint.
    this.databaseUrlSecret = new secretsmanager.Secret(this, 'DatabaseUrlSecret', {
      secretName: 'embeddings-database-url',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        'postgresql://' +
        `{{resolve:secretsmanager:${this.secret.secretArn}:SecretString:username}}:` +
        `{{resolve:secretsmanager:${this.secret.secretArn}:SecretString:password}}` +
        `@${this.proxyEndpoint}:5432/${dbName}?sslmode=require`
      ),
    });

    // Select isolated subnets for database
    const dbSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    // Create RDS subnet group
    const subnetGroup = new rds.SubnetGroup(this, 'DBSubnetGroup', {
      description: 'Subnet group for embeddings database',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create PostgreSQL RDS instance
    this.dbInstance = new rds.DatabaseInstance(this, 'PostgresDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_9,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      credentials: rds.Credentials.fromSecret(this.secret),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      databaseName: 'embeddings',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      deletionProtection: false, // For POC, enable in production
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For POC, use SNAPSHOT in production
      publiclyAccessible: false,
      subnetGroup,
      backupRetention: cdk.Duration.days(7),
      cloudwatchLogsExports: ['postgresql'], // Enable CloudWatch logs
      enablePerformanceInsights: false, // Disable for cost savings in POC
    });

    // Create RDS Proxy
    this.proxy = new rds.DatabaseProxy(this, 'DBProxy', {
      proxyTarget: rds.ProxyTarget.fromInstance(this.dbInstance),
      secrets: [this.secret],
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      dbProxyName: 'embeddings-db-proxy',
      requireTLS: false, // Set to true for production
      maxConnectionsPercent: 100,
      maxIdleConnectionsPercent: 50,
      // Initialize connection pool
      initQuery: 'SELECT 1',
    });

    // Store proxy endpoint for use in applications
    this.proxyEndpoint = this.proxy.endpoint;

    // Output the proxy endpoint
    new cdk.CfnOutput(this, 'DBProxyEndpoint', {
      value: this.proxyEndpoint,
      description: 'RDS Proxy endpoint for database connections',
    });

    new cdk.CfnOutput(this, 'DBSecretArn', {
      value: this.secret.secretArn,
      description: 'ARN of the database credentials secret',
    });
  }

  /**
   * Grant read access to the database secret
   */
  public grantSecretRead(grantee: cdk.aws_iam.IGrantable): void {
    this.secret.grantRead(grantee);
  }

  /**
   * Get connection string for applications
   */
  public getConnectionConfig() {
    return {
      host: this.proxyEndpoint,
      port: '5432',
      database: 'embeddings',
      secretArn: this.secret.secretArn,
    };
  }
}

