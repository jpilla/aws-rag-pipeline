import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

interface DatabaseCredentials {
  username: string;
  password: string;
}

/**
 * Service for managing PostgreSQL database connections via RDS Proxy
 */
export class DatabaseService {
  private pool?: Pool;
  private secretsClient: SecretsManagerClient;
  private host: string;
  private port: number;
  private database: string;
  private secretArn: string;
  private credentials?: DatabaseCredentials;

  constructor() {
    // Get database configuration from environment variables
    this.host = process.env.DB_HOST || "localhost";
    this.port = parseInt(process.env.DB_PORT || "5432", 10);
    this.database = process.env.DB_NAME || "embeddings";
    this.secretArn = process.env.DB_SECRET_ARN || "";

    // Initialize AWS Secrets Manager client
    this.secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }

  /**
   * Retrieve database credentials from AWS Secrets Manager
   */
  private async getCredentials(): Promise<DatabaseCredentials> {
    if (this.credentials) {
      return this.credentials;
    }

    if (!this.secretArn) {
      throw new Error("DB_SECRET_ARN environment variable is not set");
    }

    try {
      const response = await this.secretsClient.send(
        new GetSecretValueCommand({
          SecretId: this.secretArn,
        })
      );

      if (!response.SecretString) {
        throw new Error("Secret value is empty");
      }

      const secret = JSON.parse(response.SecretString);
      this.credentials = {
        username: secret.username,
        password: secret.password,
      };

      return this.credentials;
    } catch (error) {
      console.error("Failed to retrieve database credentials:", error);
      throw error;
    }
  }

  /**
   * Initialize the connection pool
   */
  private async initializePool(): Promise<Pool> {
    if (this.pool) {
      return this.pool;
    }

    const credentials = await this.getCredentials();

    this.pool = new Pool({
      host: this.host,
      port: this.port,
      database: this.database,
      user: credentials.username,
      password: credentials.password,
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
      ssl: {
        rejectUnauthorized: false, // Accept RDS certificates
      },
    });

    // Handle pool errors
    this.pool.on("error", (err) => {
      console.error("Unexpected error on idle client", err);
    });

    console.log(
      `Database pool initialized: ${this.host}:${this.port}/${this.database}`
    );

    return this.pool;
  }

  /**
   * Get the connection pool, initializing it if necessary
   */
  async getPool(): Promise<Pool> {
    return await this.initializePool();
  }

  /**
   * Execute a query directly
   */
  async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    const pool = await this.getPool();
    if (params) {
      return pool.query<T>(text, params);
    }
    return pool.query<T>(text);
  }

  /**
   * Get a client from the pool for transactions
   */
  async getClient(): Promise<PoolClient> {
    const pool = await this.getPool();
    return pool.connect();
  }

  /**
   * Test database connectivity
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const result = await this.query<{ result: number }>("SELECT 1 as result");
      if (result.rows[0]?.result === 1) {
        return {
          success: true,
          message: "Database connection successful",
        };
      }
      return {
        success: false,
        message: "Database returned unexpected result",
      };
    } catch (error: any) {
      console.error("Database connection test failed:", error);
      return {
        success: false,
        message: error.message || "Database connection failed",
      };
    }
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      console.log("Database pool closed");
    }
  }
}

// Export a singleton instance
export const databaseService = new DatabaseService();

