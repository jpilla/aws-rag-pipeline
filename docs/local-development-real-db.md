# Local Development with Real Database (via Bastion Host)

This guide explains how to run your application locally while connecting to the real RDS database in AWS.

## Overview

Since the database is in a **private subnet** (no internet gateway), you need a bastion host to create a secure tunnel from your laptop to the RDS Proxy.

## Architecture

```
Your Laptop → SSM Tunnel → Bastion Host (Public Subnet) → RDS Proxy → RDS Instance (Private Subnet)
```

## Prerequisites

1. **AWS CLI configured** with appropriate credentials
2. **Session Manager Plugin** installed (for SSM tunnel):
   ```bash
   # macOS
   brew install --cask session-manager-plugin
   ```
3. **CDK stack deployed** with bastion host created
4. **Database credentials** in AWS Secrets Manager

## Quick Start (Automated)

The easiest way is to use the automated make target:

```bash
# Terminal 1: Start the tunnel (keep running)
./scripts/tunnel-db.sh

# Terminal 2: Run the app (automatically fetches credentials)
DB_HOST=host.docker.internal make run-local
```

The makefile will automatically:
- Detect you're using a real database (DB_HOST != "postgres")
- Fetch credentials from AWS Secrets Manager
- Skip starting local postgres
- Start services with proper configuration

## Manual Setup (Step by Step)

### Step 1: Start the Bastion Tunnel

In one terminal, start the port forwarding tunnel:

```bash
./scripts/tunnel-db.sh
```

**Keep this terminal open!** The tunnel must remain running while you use it.

The tunnel forwards `localhost:5432` on your laptop to the RDS Proxy.

### Step 2: Set Up Database Credentials

In another terminal, fetch credentials from AWS:

```bash
source scripts/connect-real-db.sh
```

This sets:
- `DB_USER` - Database username (from Secrets Manager)
- `DB_PASSWORD` - Database password (from Secrets Manager)
- `DB_NAME` - Database name (defaults to "embeddings")
- `DB_PORT` - Database port (defaults to 5432)
- `DB_SSLMODE` - SSL mode (defaults to "require" for AWS RDS)
- `DB_HOST` - RDS Proxy endpoint (we'll override this)

### Step 3: Override DB_HOST for Tunnel

Since we're using the tunnel, point to your host machine instead of the RDS Proxy:

```bash
export DB_HOST=host.docker.internal
```

**Note:**
- On macOS/Windows with Docker Desktop: use `host.docker.internal`
- On Linux: use your host machine's IP address or `host.docker.internal` if available

### Step 4: Run the Application

```bash
make run-local
```

Or if you prefer docker-compose directly:

```bash
docker-compose up api
```

## Environment Variables Reference

### Required for Real Database

| Variable | Source | Description |
|----------|--------|-------------|
| `DB_HOST` | Manual/Environment | Use `host.docker.internal` when using tunnel |
| `DB_USER` | AWS Secrets Manager | Database username |
| `DB_PASSWORD` | AWS Secrets Manager | Database password |
| `DB_NAME` | Default or Environment | Database name (default: "embeddings") |
| `DB_PORT` | Default or Environment | Database port (default: 5432) |
| `DB_SSLMODE` | Default or Environment | SSL mode (default: "require") |

### Optional AWS Variables

| Variable | Description |
|----------|-------------|
| `AWS_REGION` | AWS region (auto-detected from AWS CLI config) |
| `AWS_PROFILE` | AWS profile to use |
| `INGEST_QUEUE_URL` | SQS queue URL (if using ingest features) |

### For Local Development Only

When using local postgres (default), these are set automatically:
- `DB_HOST=postgres` (docker-compose service name)
- `DB_USER=postgres` (from docker-compose.yml)
- `DB_PASSWORD=postgres` (from docker-compose.yml)

## Troubleshooting

### "Can't reach database server at host.docker.internal:5432"

**Possible causes:**

1. **Tunnel not running** - Make sure `./scripts/tunnel-db.sh` is running in another terminal
2. **host.docker.internal not resolving** - On Linux, try using your host IP:
   ```bash
   # Get your host IP
   ip addr show docker0 | grep -oP 'inet \K[\d.]+'
   # Or use:
   hostname -I | awk '{print $1}'
   ```
3. **Wrong port** - Verify tunnel is forwarding to port 5432:
   ```bash
   lsof -i :5432
   ```

### "Missing required environment variables: DB_USER, DB_PASSWORD"

**Solution:** Run `source scripts/connect-real-db.sh` to fetch credentials from AWS Secrets Manager.

### "Secret 'embeddings-db-credentials' not found"

**Solution:** Your CDK stack needs to be deployed. Run:
```bash
cd infra && npx cdk deploy
```

### Connection timeout or connection refused

1. Check security group rules allow bastion → RDS Proxy
2. Verify bastion host is running:
   ```bash
   aws ec2 describe-instances --instance-ids i-xxxxx --query 'Instances[0].State.Name'
   ```
3. Check RDS Proxy is in a subnet accessible from the bastion (should be in `private-egress` subnet)

## Scripts Reference

### `scripts/tunnel-db.sh`
Creates SSM port forwarding tunnel from localhost to RDS Proxy via bastion host.

**Usage:**
```bash
./scripts/tunnel-db.sh [local-port] [remote-host] [remote-port]
```

**Defaults:**
- Local port: `5432`
- Remote host: Auto-detected from CDK stack outputs
- Remote port: `5432`

### `scripts/connect-real-db.sh`
Fetches database credentials from AWS Secrets Manager and sets environment variables.

**Usage:**
```bash
source scripts/connect-real-db.sh
```

**Note:** Must be sourced (not executed) to export variables to your shell.

### `scripts/run-with-real-db.sh`
Helper script that fetches credentials and runs make target.

**Usage:**
```bash
./scripts/run-with-real-db.sh [make-target]
```

**Default:** `run-local`

## Make Targets

### `make run-local`
Builds and runs the application.

- If `DB_HOST` is not set or equals `"postgres"`: uses local postgres container
- If `DB_HOST` is set to something else: uses external database and fetches credentials automatically

### `make run-debug`
Runs API in debug mode with local postgres.

## Security Notes

1. **Bastion Host Access**: The bastion host only allows SSH from your `DEV_IP` (set during CDK deploy)
2. **SSM Session Manager**: No SSH keys needed - uses IAM authentication
3. **Security Groups**: Bastion can only reach RDS Proxy, not the RDS instance directly
4. **Tunnel Encryption**: SSM tunnel is encrypted end-to-end
5. **Credentials**: Never commit database credentials - always fetch from Secrets Manager

## Cost Considerations

- **Bastion Host**: Small EC2 instance (t3.nano) - ~$3.50/month
- **RDS Proxy**: Free tier available, then ~$15-20/month
- **Data Transfer**: Minimal cost for tunnel traffic

To save costs, you can:
- Stop the bastion when not in use (terminates and recreate on next deploy)
- Use local postgres for most development
- Only use real DB when testing AWS-specific features
