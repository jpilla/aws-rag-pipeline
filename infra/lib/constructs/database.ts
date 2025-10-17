import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib';

interface DatabaseProps {
  readonly vpc: ec2.IVpc;
  readonly dbSecurityGroup: ec2.SecurityGroup;
}

export class Database extends Construct {
  public readonly instance: rds.DatabaseInstance;
  public readonly proxy: rds.DatabaseProxy;
  public readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    // 1️⃣ Create a Secrets Manager secret for Postgres creds
    this.secret = new secretsmanager.Secret(this, 'DbMasterSecret', {
      secretName: 'embeddings-db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // 2️⃣ Create the RDS instance (or Aurora, same idea)
    this.instance = new rds.DatabaseInstance(this, 'DbInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.secret),
      databaseName: 'embeddings',
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      publiclyAccessible: false,
      multiAz: false,
    });

    // 3️⃣ Add an RDS Proxy for connection pooling & rotation safety
    this.proxy = new rds.DatabaseProxy(this, 'DbProxy', {
      proxyTarget: rds.ProxyTarget.fromInstance(this.instance),
      secrets: [this.secret],
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: 'private-egress' },
      securityGroups: [props.dbSecurityGroup],
      requireTLS: true,
      debugLogging: false,
      iamAuth: false,
      maxConnectionsPercent: 100,
    });

    // 4️⃣ Optional: enable rotation on the secret (safe with proxy)
    new secretsmanager.SecretRotation(this, 'DbSecretRotation', {
      secret: this.secret,
      application: secretsmanager.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      target: this.instance,
      vpc: props.vpc,
      automaticallyAfter: cdk.Duration.days(30),
    });
  }

  // helper for consumers
  public get connectionInfo() {
    return {
      host: this.proxy.endpoint, // proxy endpoint
      dbName: 'embeddings',
      secret: this.secret,
    };
  }
}