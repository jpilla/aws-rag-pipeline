"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretsManagerCredentialProvider = exports.EnvVarCredentialProvider = void 0;
/**
 * Credential provider that reads from environment variables
 * Used by API service (local development and ECS)
 */
class EnvVarCredentialProvider {
    async getCredentials() {
        const username = process.env.DB_USER;
        const password = process.env.DB_PASSWORD;
        if (!username || !password) {
            throw new Error('DB_USER and DB_PASSWORD environment variables are required');
        }
        return { username, password };
    }
}
exports.EnvVarCredentialProvider = EnvVarCredentialProvider;
/**
 * Credential provider that fetches from AWS Secrets Manager
 * Used by Lambda functions
 *
 * Accepts a SecretsManagerClient-like object to avoid direct AWS SDK dependency
 */
class SecretsManagerCredentialProvider {
    constructor(secretsClient, secretArn) {
        this.secretsClient = secretsClient;
        this.secretArn = secretArn;
    }
    async getCredentials() {
        // Dynamically import GetSecretValueCommand to avoid direct dependency
        const { GetSecretValueCommand } = await Promise.resolve().then(() => __importStar(require('@aws-sdk/client-secrets-manager')));
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
exports.SecretsManagerCredentialProvider = SecretsManagerCredentialProvider;
//# sourceMappingURL=credential-providers.js.map