/**
 * Interface for providing database credentials
 */
export interface DatabaseCredentials {
  username: string;
  password: string;
}

export interface CredentialProvider {
  getCredentials(): Promise<DatabaseCredentials>;
}

/**
 * Credential provider that reads from environment variables
 * Used by API service (local development and ECS)
 */
export class EnvVarCredentialProvider implements CredentialProvider {
  async getCredentials(): Promise<DatabaseCredentials> {
    const username = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;

    if (!username || !password) {
      throw new Error('DB_USER and DB_PASSWORD environment variables are required');
    }

    return { username, password };
  }
}

/**
 * Interface for Secrets Manager client (to avoid direct AWS SDK dependency)
 * Accepts any command-like object that can be sent and returns a response with SecretString
 */
export interface SecretsManagerClientLike {
  send(command: unknown, options?: unknown): Promise<{ SecretString?: string }>;
}

/**
 * Credential provider that fetches from AWS Secrets Manager
 * Used by Lambda functions
 *
 * Accepts a SecretsManagerClient-like object to avoid direct AWS SDK dependency
 */
export class SecretsManagerCredentialProvider implements CredentialProvider {
  private secretsClient: SecretsManagerClientLike;
  private secretArn: string;

  constructor(secretsClient: SecretsManagerClientLike, secretArn: string) {
    this.secretsClient = secretsClient;
    this.secretArn = secretArn;
  }

  async getCredentials(): Promise<DatabaseCredentials> {
    // Dynamically import GetSecretValueCommand to avoid direct dependency
    const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const command = new GetSecretValueCommand({ SecretId: this.secretArn });
    const secretValue = await this.secretsClient.send(command);

    if (!secretValue.SecretString) {
      throw new Error('Failed to retrieve database credentials from Secrets Manager');
    }

    const credentials = JSON.parse(secretValue.SecretString);

    if (!credentials.username || !credentials.password) {
      throw new Error('Invalid credentials format in Secrets Manager');
    }

    return {
      username: credentials.username,
      password: credentials.password,
    };
  }
}
