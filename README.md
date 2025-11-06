# RAG API with Express, ECS, and Postgres

> A Retrieval-Augmented Generation (RAG) API built with TypeScript, Express, AWS ECS/Fargate, PostgreSQL with pgvector, and OpenAI embeddings. Designed for scalable document ingestion and semantic search.

---

## 📋 Table of Contents

- [What This Is](#-what-this-is)
- [Why It Was Built](#-why-it-was-built)
- [Deployment](#-deployment)
- [API Examples](#-api-examples)
- [Architecture](#-architecture)
- [Key Design Decisions](#-key-design-decisions)
- [Amazon Reviews Data Pipeline](#-amazon-reviews-data-pipeline)
- [Development](#-development)
- [Citations](#-citations)

---

## 🎯 What This Is

This is a fully functional RAG (Retrieval-Augmented Generation) system that:

- **Ingests documents** via a REST API, processes them asynchronously through SQS queues
- **Generates embeddings** using OpenAI's text-embedding-3-small model (1536 dimensions)
- **Stores vectors** in PostgreSQL with pgvector extension for efficient similarity search
- **Queries content** semantically using vector similarity search and returns AI-generated answers with context

The system is designed to handle batch ingestion of documents (like Amazon product reviews), generate embeddings asynchronously, and provide fast semantic search capabilities. I used it to gain insights from Amazon Reviews data, exploring patterns in product reviews through semantic search and AI-generated summaries.

**Key Features:**
- ✅ Idempotent ingestion with request-level idempotency keys
- ✅ Content-level deduplication at the database level
- ✅ Async processing pipeline with SQS and Lambda
- ✅ Vector similarity search with configurable thresholds
- ✅ Batch status tracking and monitoring
- ✅ Production-like error handling and retries[¹](#footnote-1)

---

## 🎓 Why It Was Built

This project was built as a learning exercise to gain hands-on experience with:

- **TypeScript & Node.js** - Modern JavaScript development with type safety
- **Express.js** - Building RESTful APIs and middleware patterns
- **AWS ECS/Fargate[²](#footnote-2)** - Container orchestration and serverless compute
- **PostgreSQL & pgvector** - Vector databases and similarity search
- **OpenAI API** - Embedding generation and text completion
- **Prisma** - Database migrations and ORM with migration history tracking
- **Development Flow** - Setting up a productive local → AWS development workflow
- **Testing & Debugging** - Integration tests, debugging in containers, and observability
- **AI-Assisted Development** - When I started my time off from work to spend time with my children, AI coding tools (like Cursor, GitHub Copilot) were not yet ubiquitous. I wanted to see what "vibe coding" was all about, and I was totally blown away. Modern AI tools were extremely helpful in understanding how these technologies worked and how to effectively write the code, especially for rapidly learning new frameworks and patterns.

Before working on this, I had no experience with any of the above. I was quite comfortable with the "big company" AWS tech stack (Java, DynamoDb, SQS, etc.), but I wanted to branch out, especially with the RDBMS. The goal was to build something that could go to production without much tweaking[¹](#footnote-1) while learning the full stack, from API design to infrastructure deployment.

---

## 🚀 Deployment

### Prerequisites

Before deploying, ensure you have the following installed and configured:

- **Docker** - For container builds and local development (Docker daemon must be running)
- **AWS CLI** - Configured with appropriate credentials
- **AWS CDK** - `npm install -g aws-cdk` or `npx aws-cdk` (npx is recommended)
- **Node.js** - Version 18+ recommended
- **npm** - For installing dependencies

### Environment Variables

Set the following environment variables before deployment:

```bash
export AWS_REGION=us-east-1                    # Your target AWS region
export AWS_PROFILE=your-profile                 # OR use AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
export OPENAI_SECRET=sk-...                    # Your OpenAI API key
```

Optional (for direct SSH access to bastion host, not required for tunneling):
```bash
export DEV_IP=1.2.3.4/32                        # Your IP for SSH access to bastion
```

### One-Time Setup

**Bootstrap CDK Environment (First Time Only):**

Before your first deployment, you need to bootstrap your CDK environment:

```bash
make bootstrap-cloud-resources
```

This will:
1. Install CDK dependencies in the `infra/` directory (if needed)
2. Create the RDS service-linked role (required for RDS instances)
3. Bootstrap CDK in your AWS account (creates the CDK toolkit stack)

**Note:** Bootstrap only needs to be done once per AWS account/region. If you've already bootstrapped CDK in this account/region, you can skip this step.

**IAM Permissions:** The CDK deployment requires permissions to create:
- VPC, subnets, security groups
- ECS cluster, tasks, services, load balancers
- RDS PostgreSQL instance and RDS Proxy
- SQS queues
- Lambda functions
- Secrets Manager secrets
- ECR repositories
- EC2 instances (for bastion host)

### Deploy to AWS

Deploy everything with a single command:

```bash
make deploy-cloud-resources
```

This will:
1. Build Docker images for the API service and Lambda
2. Push images to ECR
3. Deploy all infrastructure via CDK (VPC, ECS, RDS, SQS, Lambda, etc.)
4. Run database migrations
5. Start the API service on Fargate

### Tear Down

```bash
make destroy-cloud-resources
```

This destroys the CDK stack (including RDS instance - **data will be lost**).

**Cost Note:** If you leave all infrastructure running idle (no traffic), you're looking at around **$50-60 per month**, dominated by the NAT Gateway costs. The RDS instance, ECS tasks, and other services contribute to the total, but the NAT Gateway is the main cost driver for idle infrastructure.

---

## 📡 API Examples

### Ingest Documents

**POST** `/v1/ingest`

Ingest documents for embedding generation. Supports idempotency keys for safe retries.

```bash
curl -v -X POST http://your-api-endpoint/v1/ingest \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-key-123" \
  -d '{
    "records": [
      { "clientId": "doc-1", "content": "The quick brown fox jumps over the lazy dog." },
      { "clientId": "doc-2", "content": "Machine learning is transforming industries." }
    ]
  }'
```

**Response Headers:**
```
HTTP/1.1 202 Accepted
Location: /v1/ingest/b_16ea69c6-06ab-44a3-9c74-e5ae35664510
Request-Id: req-a1b2c3d4-e5f6-7890-abcd-ef1234567890
Content-Type: application/json; charset=utf-8
```

**Response Body:**
```json
{
  "batchId": "b_16ea69c6-06ab-44a3-9c74-e5ae35664510",
  "summary": {
    "received": 2,
    "enqueued": 2,
    "rejected": 0
  },
  "errors": []
}
```

The `Location` header points to the batch status endpoint where you can check detailed chunk status. The `Request-Id` header can be used for tracing requests across services. Note that detailed `results` and `errors` arrays are not included in the POST response - check the GET endpoint for full details.

### Check Batch Status

**GET** `/v1/ingest/{batchId}`

Monitor the processing status of an ingestion batch.

```bash
curl -v http://your-api-endpoint/v1/ingest/b_16ea69c6-06ab-44a3-9c74-e5ae35664510
```

**Response Headers:**
```
HTTP/1.1 200 OK
Request-Id: req-a1b2c3d4-e5f6-7890-abcd-ef1234567890
Content-Type: application/json; charset=utf-8
ETag: W/"d40-D4WfG258q6dHqLEZLkVhzeDGXYQ"
```

**Response Body:**
```json
{
  "batchId": "b_16ea69c6-06ab-44a3-9c74-e5ae35664510",
  "status": "COMPLETED",
  "totalChunks": 2,
  "enqueuedChunks": 0,
  "ingestedChunks": 2,
  "failedChunks": 0,
  "createdAt": "2025-10-28T12:44:13.204Z",
  "completedAt": "2025-10-28T12:44:15.184Z",
  "chunks": [
    {
      "chunkId": "c_30a60bc3-e9e7-4685-bc4c-e6b3290590bb",
      "chunkIndex": 0,
      "clientId": "doc-1",
      "status": "INGESTED",
      "createdAt": "2025-10-28T12:44:13.204Z",
      "updatedAt": "2025-10-28T12:44:13.240Z"
    },
    {
      "chunkId": "c_41b71cd4-f0f8-5796-cd5d-f7c43a16a0cc",
      "chunkIndex": 1,
      "clientId": "doc-2",
      "status": "INGESTED",
      "createdAt": "2025-10-28T12:44:13.204Z",
      "updatedAt": "2025-10-28T12:44:14.180Z"
    }
  ]
}
```

### Query Content

**POST** `/v1/query`

Perform semantic search and get AI-generated answers with context.

```bash
curl -X POST http://your-api-endpoint/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "what toy cars are surprisingly dangerous?",
    "limit": 5,
    "threshold": 0.7
  }'
```

**Response:**
```json
{
  "query": "what toy cars are surprisingly dangerous?",
  "answer": "The Fisher Price Nesting Action Vehicles mentioned in one of the reviews are noted to have paint that comes off easily, which could be dangerous for babies who put objects in their mouths...",
  "context": [
    {
      "id": "c_7a3ed0a7-980b-4d01-89a7-03b3ff799916",
      "docId": "b_01ec27d2-3af8-4a3f-8446-3390b5d4a44b",
      "chunkIndex": 0,
      "content": "Product: Fisher Price Nesting Action Vehicles...",
      "distance": 0.5307765639753981
    }
  ],
  "matches": 5
}
```

---

## 🏗️ Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ HTTP
       ▼
┌─────────────────────────────────────────────────────────┐
│                    Application Load Balancer             │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              ECS Fargate - API Service                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Express.js API                                   │   │
│  │  - POST /v1/ingest  → Enqueue to SQS             │   │
│  │  - GET  /v1/ingest/{id} → Check batch status     │   │
│  │  - POST /v1/query   → Vector search + OpenAI      │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │
                        │ SQS Messages
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    SQS Queue                              │
│              (Ingest Queue)                               │
└───────────────────────┬─────────────────────────────────┘
                        │
                        │ Lambda Trigger
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Lambda Function (Docker)                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │  - Process SQS messages in batches               │   │
│  │  - Generate embeddings via OpenAI API            │   │
│  │  - Store in PostgreSQL with deduplication        │   │
│  └──────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────┘
                        │
                        │ RDS Proxy
                        ▼
┌─────────────────────────────────────────────────────────┐
│              RDS PostgreSQL (pgvector)                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │  - Embeddings table (vector(1536))                │   │
│  │  - Chunks table (content + metadata)              │   │
│  │  - Idempotency tracking                           │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘

                        ┌─────────────────┐
                        │   OpenAI API    │
                        │  (Embeddings)   │
                        └─────────────────┘
```

**Components:**
- **ALB** - Application Load Balancer for public API access
- **ECS Fargate** - Containerized API service (Express.js)
- **SQS** - Async message queue for ingestion pipeline
- **Lambda** - Event-driven embedding processor (containerized)
- **RDS PostgreSQL** - Vector database with pgvector extension
- **RDS Proxy** - Connection pooling and secret rotation
- **VPC** - Isolated networking with private subnets for DB

---

## 🔑 Key Design Decisions

### Idempotency Strategy

**Request-Level Idempotency:**
- Clients can provide an `Idempotency-Key` header when submitting batches
- If a batch with the same key already exists, the system returns the **same** `batchId` in the response
- Records are still enqueued (allows for retries), but the lambda consumer handles deduplication

**Content-Level Deduplication:**
- Each record's content is hashed (SHA-256) to create a `contentHash`
- The lambda consumer checks for existing embeddings by `contentHash` before generating new ones
- This prevents duplicate embeddings even if the same content appears in different batches
- New batches that reference existing content reuse the existing embedding

**Why This Design?**
- **Request-level idempotency** protects against network retries and client errors
- **Content-level deduplication** saves API costs and storage by avoiding duplicate embeddings
- **Batch tracking** allows monitoring of ingestion progress and debugging

### Deduplication Logic

The system uses a two-phase deduplication approach:

1. **API Layer (Request):** Accepts idempotency keys for batch-level tracking
2. **Lambda Consumer:** Deduplicates at the content hash level:
   - Checks if `contentHash` already exists in the `Embedding` table
   - If exists, links the new `Chunk` record to the existing embedding (no OpenAI API call)
   - If not, generates embedding and stores it

This ensures:
- ✅ Same content ingested multiple times = one embedding (cost efficient)
- ✅ New batches are tracked separately (monitoring)
- ✅ Retries are safe (idempotency keys prevent duplicate batch creation)

### Amazon Reviews and Duplicate Content

When ingesting Amazon review data, if the same review appears in multiple batches (e.g., re-ingesting data), it will naturally appear multiple times in search results because each `Chunk` record is unique even if it shares the same `contentHash` with other chunks. This means:

- **Duplicate content gets more weight** - If the same review appears in results multiple times (from different batches), it will naturally rank higher in the context passed to the LLM simply because it appears more frequently
- **No explicit timestamp weighting** - The vector search doesn't use `createdAt` timestamps for ranking; results are ordered purely by cosine similarity distance
- **Future enhancement** - The query endpoint could be extended to incorporate recency weighting or deduplicate at the query level, but currently it's a simple similarity search

---

## 📦 Amazon Reviews Data Pipeline

This project includes scripts to process and ingest Amazon Review data from the [UCSD Amazon Review Dataset](https://cseweb.ucsd.edu/~jmcauley/datasets/amazon_v2/).

### Step 1: Download the Data

Download review and metadata files for your desired category. For example, Toys & Games:

```bash
# Download reviews (5-core subset recommended)
wget https://mcauleylab.ucsd.edu/public_datasets/data/amazon_v2/categoryFilesSmall/Toys_and_Games_5.json.gz

# Download metadata
wget https://mcauleylab.ucsd.edu/public_datasets/data/amazon_v2/metaFiles2/meta_Toys_and_Games.json.gz
```

### Step 2: Prepare the Data

The `join_reviews.py` script combines review data with product metadata and formats it for embedding:

```bash
python3 scripts/join_reviews.py \
  --meta meta_Toys_and_Games.json.gz \
  --reviews Toys_and_Games_5.json.gz \
  --out prepared_reviews.jsonl
```

**What it does:**
- Joins reviews with product metadata (title, brand, category)
- Strips HTML and cleans text
- Creates embedding-ready text format: `Product: {title} Category: {category} Rating: {rating} Review Summary: {summary} Full Review: {text}`
- Outputs JSONL format suitable for ingestion

**Output format:**
```json
{
  "id": "asin_reviewerID_timestamp",
  "asin": "B0001234",
  "embedding_text": "Product: Fisher Price Cars... Category: Toys & Games...",
  "meta": {
    "product_title": "Fisher Price Nesting Action Vehicles",
    "brand": "Fisher-Price",
    "rating": 5,
    "review_text": "...",
    "review_time": "2023-01-15"
  }
}
```

### Step 3: Ingest the Data

Use the `ingest_jsonl.js` script to stream the prepared JSONL file and batch POST requests:

```bash
node scripts/ingest_jsonl.js \
  --file prepared_reviews.jsonl \
  --endpoint http://your-api-endpoint/v1/ingest \
  --batch 100 \
  --concurrency 8 \
  --retries 5 \
  --timeout-ms 60000
```

**Important Notes:**
- **Dataset Size:** Ingesting the **entire** Amazon Reviews dataset will take a considerable amount of time. For testing purposes, you should either interrupt the script early or use the provided `Amazon_Reviews_Short.jsonl` file instead.
- **AWS Free Tier Limits:** AWS Free Tier accounts are capped at **1 million Lambda invocations per month** (not per day). However, when processing large datasets, you may hit rate limits. The ingest script writes messages to SQS faster than Lambda can process them, so you'll need to monitor Lambda invocation counts and potentially throttle the ingest script's concurrency.
- **Recommended Approach:** Start with `Amazon_Reviews_Short.jsonl` to test the full pipeline, then scale up incrementally if you want to process larger datasets.

**Features:**
- Streams large files efficiently (no memory issues)
- Batches records (default 100 per POST)
- Parallel requests with configurable concurrency
- Automatic retries with exponential backoff
- Deterministic idempotency keys per batch (safe to retry)
- Progress logging

**Options:**
- `--batch N` - Records per POST request (default: 100)
- `--concurrency N` - Parallel POST requests (default: 8)
- `--retries N` - Retry attempts on failure (default: 5)
- `--timeout-ms N` - Request timeout in milliseconds (default: 60000)
- `--max-chars N` - Max characters per content field (default: 8000)
- `--log-every N` - Log progress every N batches (default: 100)

---

## 💻 Development

### Local Development Philosophy

This project uses a local development approach that prioritizes working with **real cloud infrastructure** rather than local mocks[³](#footnote-3). Here's the reasoning:

- **CDK makes deploying to real environments trivial** - With infrastructure as code, spinning up a real AWS environment is quick and reliable. Initial creation of everything takes around 15 minutes, but updates (like deploying new ECS tasks or Lambda functions) happen very quickly—just a couple minutes.
- **Testing against real infrastructure is fast** - Modern AWS services (RDS, SQS, Lambda) have low latency, and the feedback loop is actually quite good.
- **Fewer surprises in production** - What you develop against is what runs in production.

**The Tradeoff:**
- For local development, you tunnel into the **real database** via SSM Session Manager (see below). The local API connects to the actual RDS instance through this tunnel.
- The local API can send messages to SQS, but the Lambda consumer must be tested separately by providing an SQS message payload directly (see Lambda Development section).
- This means you can't run a full end-to-end test entirely on your local machine—it's a conscious tradeoff for simplicity. The approach is to test each piece independently during local development, and run end-to-end tests where everything is deployed in real AWS.

### Local Development

Start the API locally (connects to AWS RDS via tunnel):

1. **First, establish a tunnel to the database:**
   ```bash
   ./scripts/tunnel-db.sh
   ```
   This uses AWS SSM Session Manager to create a secure port forward from your local machine to the RDS Proxy through the bastion host. No SSH keys needed!

2. **In a separate terminal, start the API:**
   ```bash
   make run-local
   ```

The API will be available at `http://localhost:3000` and will connect to the real database through the tunnel.

### Debugging

Use the VSCode debugger with Docker:

1. **Start the tunnel** (if not already running):
   ```bash
   ./scripts/tunnel-db.sh
   ```

2. **Start the application in debug mode:**
   ```bash
   make run-debug
   ```

3. In VSCode, navigate to **Run and Debug** and start "Attach to API in Docker"

The debugger attaches to the production container - no special debug setup needed!

### Integration Tests

Run integration tests against the local service:

```bash
make integration-tests
```

### Database Migrations

Create a new Prisma migration (if you make a database schema change, generate a new migration like this):

```bash
make prisma-migrate migration_name
```

Test migrations locally:

```bash
make test-migration
```

### Lambda Development

Build and test the Lambda locally:

```bash
make build-lambda
make debug-lambda
```

**Note:** When testing the Lambda locally, you'll need to provide an SQS message payload directly. The local API sends messages to the real SQS queue, but to test the Lambda consumer, you pass it a message payload manually (see `lambda-test-message.json` for an example).

---

## 📚 Citations

This project uses data from the Amazon Review Dataset (2018) provided by UCSD. If you use this dataset or the scripts provided here, please cite:

**Justifying recommendations using distantly-labeled reviews and fined-grained aspects**
Jianmo Ni, Jiacheng Li, Julian McAuley
_Empirical Methods in Natural Language Processing (EMNLP)_, 2019
[PDF](https://cseweb.ucsd.edu/~jmcauley/pdfs/emnlp2019.pdf) | [Dataset](https://cseweb.ucsd.edu/~jmcauley/datasets/amazon_v2/)

**BibTeX:**
```bibtex
@inproceedings{ni2019justifying,
  title={Justifying recommendations using distantly-labeled reviews and fined-grained aspects},
  author={Ni, Jianmo and Li, Jiacheng and McAuley, Julian},
  booktitle={Proceedings of EMNLP},
  year={2019}
}
```

---

**Built with ❤️ for learning and experimentation**

---

## 📝 Footnotes and Hot Takes

<a name="footnote-1"></a>

¹ **"Production-like," not "production ready"** Many production-grade features are intentionally omitted (HTTPS, authentication, rate limiting, comprehensive test coverage, ECS task autoscaling, OpenAPI specs, bulletproof logging and monitoring, etc.)—I've done those at work. I've asked AI tools to show me how this stuff basically looks in the tech stack I'm using, and I'm content to leave it there for now.

<a name="footnote-2"></a>

² **Yes, ECS, not EKS.** I'm no infrastructure expert, but I've seen and heard about migrations to EKS taking an eternity. I've heard tons of people complain about how hard it is just to get one service to talk to another service. Where possible, my philosophy is to embrace off-the-shelf AWS native tools. ECS seems far simpler and totally AWS native, and makes it quite easy to orchestrate containers and get services talking to each other—seems to give about 80% of the value of Kubernetes with 20% of the pain for simple backend services. Of course, I believe EKS can be great with support from a killer platform team.

<a name="footnote-3"></a>

³ **Why not LocalStack?** Tools like LocalStack exist and are beloved by their supporters, but in my experience, mocked AWS services don't behave like the real thing, and resource setup can be disappointingly cumbersome and error-prone. Considering how easy it is to deploy AWS infrastructure with CDK, testing with real cloud resources is snappy and responsive enough, and gives you confidence that what you're building will behave the same way in production.
