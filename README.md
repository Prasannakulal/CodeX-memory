# CodexMemory

CodexMemory is a local Retrieval-Augmented Generation (RAG) system and Model Context Protocol (MCP) server. It enables AI assistants to semantically search local Markdown notes and documentation stored in the `docs/` directory.

The system features an automated, asynchronous document ingestion pipeline with file-system watching, Redis-backed BullMQ job queues, Ollama vector embeddings, LanceDB local vector storage, retry handling, a dead-letter queue (DLQ), and Prometheus-compatible metrics.

---

## Capabilities

- **Model Context Protocol (MCP) Integration**: Exposes semantic similarity search over standard I/O (`stdio`) for AI clients (such as Claude Desktop and other MCP-compatible clients).
- **Asynchronous Ingestion Pipeline**: Decouples document change detection from computationally heavy embedding and storage tasks using BullMQ and Redis.
- **Automatic Document Watching**: Uses Chokidar to monitor the `docs/` directory for additions, modifications, and deletions of `.md` files in real time.
- **Local Vector Embeddings**: Uses a local Ollama instance running `nomic-embed-text` to generate vector embeddings with zero external cloud dependencies.
- **Embedded Vector Database**: Stores vector embeddings and document metadata locally using LanceDB.
- **Resilience & Fault Tolerance**: Jobs automatically retry on transient failures with exponential backoff; permanently failing jobs are recorded in a dedicated dead-letter queue (`document-ingestion-dlq`).
- **Observability**: Exposes Prometheus-compatible queue depth, ingestion latency, and status metrics via an Express HTTP server on port 9090, backed by shared Redis state.
- **Graceful Shutdown**: Handles `SIGINT` and `SIGTERM` signals across services to complete in-flight work and cleanly close Redis, LanceDB, and HTTP connections.

---

## Architecture

```
                      +-------------------+
                      |   Markdown Docs   |
                      |     (docs/)       |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      | Document Watcher  | (src/watcher.js)
                      +---------+---------+
                                |
                                v (adds/updates)
                      +-------------------+
                      |   BullMQ Queue    | ("document-ingestion")
                      |     (Redis)       |
                      +---------+---------+
                                |
                                v
                      +-------------------+
                      | Ingestion Worker  | (src/worker.js)
                      +----+---------+----+
                           |         |
    (embedText)            |         | (stores/deletes vectors)
           v               v         v
+--------------------+           +--------------------+
|  Ollama Embeddings |           |  LanceDB Database  |
| (nomic-embed-text) |           |  (data/lancedb)    |
+--------------------+           +---------+----------+
                                           ^
                                           | (search query)
+--------------------+           +---------+----------+
|     MCP Client     |<--stdio-->|     MCP Server     | (src/server.js)
| (Claude, IDE, etc) |           +--------------------+
+--------------------+
```

### Components

1. **MCP Server (`src/server.js`)**:
   - Built on `@modelcontextprotocol/sdk`.
   - Communicates over `StdioServerTransport`.
   - Exposes the `search_documents` tool which embeds the query and retrieves nearest matches from LanceDB.

2. **Document Watcher (`src/watcher.js`)**:
   - Watches `./docs` for `.md` files using Chokidar.
   - On `add` / `change`: enqueues an `ingest-document` job via `queueDocument(filePath)`.
   - On `unlink`: calls `deleteDocument(filePath)` to purge the document's records from LanceDB.
   - Implements graceful shutdown for file watchers and Redis queue connections.

3. **BullMQ Queue (`src/queue.js`)**:
   - Queue name: `document-ingestion`.
   - Connects to Redis at `redis://127.0.0.1:6379` with `maxRetriesPerRequest: null`.
   - Default job settings: 3 retry attempts, exponential backoff starting at 1000 ms, keeps last 100 completed/failed jobs.

4. **Ingestion Worker (`src/worker.js`)**:
   - Consumes jobs from `document-ingestion` with `concurrency: 1`.
   - Parses the document, chunks it via `chunkText()`, requests embeddings via `embedText()`, and stores records in LanceDB via `ingestFile()`.
   - Records execution status, duration, and retry counts in Redis metrics.
   - Structured JSON logging using Pino (`src/logger.js`).

5. **Ollama Embeddings (`src/embedder.js`)**:
   - Sends HTTP POST requests to Ollama at `http://localhost:11434/api/embed`.
   - Model: `nomic-embed-text`.
   - Returns float vector embeddings.

6. **LanceDB Vector Storage (`src/database.js`)**:
   - Stores vectors and metadata at `./data/lancedb` in table `documents`.
   - Pinned to `@lancedb/lancedb@0.22.3` for cross-platform compatibility (including Intel macOS).
   - Fields: `id`, `text`, `sourceFile`, `chunkIndex`, `vector`.

7. **Redis (`127.0.0.1:6379`)**:
   - Serves as the message broker for BullMQ queues.
   - Stores shared multi-process metrics counters and histograms under key `codexmemory:metrics:ingestion`.

8. **Metrics Server (`src/metrics-server.js` & `src/metrics.js`)**:
   - Express server listening on `http://localhost:9090/metrics`.
   - Collects default `prom-client` metrics and custom Redis-backed metrics.

9. **Retry Handling**:
   - Managed automatically by BullMQ with 3 attempts and exponential backoff (`delay: 1000` ms).
   - If `job.attemptsMade > 0`, the worker tracks retry attempts via `recordIngestionRetry()`.

10. **Dead-Letter Queue (DLQ)**:
    - Queue name: `document-ingestion-dlq`.
    - When a job exceeds its configured retry attempts, the worker automatically transfers it to the DLQ.
    - Preserves: `originalJobId`, `filePath`, `jobName`, `errorMessage`, `attempts`, and `failedAt`.
    - Increments the `codexmemory_dead_letter_jobs_total` metric.

---

## Prerequisites and Installation

### 1. System Requirements
- **Node.js**: Node.js 18+ (requires native ES modules and `node --test` support).
- **Redis**: Running on `localhost:6379`.
- **Ollama**: Running locally on `http://localhost:11434`.
- **Ollama Embedding Model**: `nomic-embed-text`.

### 2. Service Setup

#### Install and Run Redis
- **macOS (Homebrew)**:
  ```bash
  brew install redis
  brew services start redis
  # Or run in foreground:
  redis-server
  ```
- Verify Redis is running:
  ```bash
  redis-cli ping
  # Expected output: PONG
  ```

#### Install and Run Ollama
- Install Ollama from [ollama.com](https://ollama.com) or via Homebrew:
  ```bash
  brew install ollama
  ollama serve
  ```
- Pull the required embedding model:
  ```bash
  ollama pull nomic-embed-text
  ```

### 3. Install Project Dependencies
In the project root directory:
```bash
npm install
```

---

## Configuration

CodexMemory centralizes runtime configuration in `src/config.js`. All configuration values provide safe defaults matching the default local development environment, so **no environment file is required to start the application**.

To customize settings, copy `.env.example` to `.env` or set environment variables in your runtime environment:

```bash
cp .env.example .env
```

### Supported Environment Variables

| Variable | Default Value | Description |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL used by BullMQ queues and shared metrics |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Base URL for the Ollama API |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model name |
| `DOCS_DIR` | `./docs` | Path to the directory containing Markdown documents to watch and ingest |
| `LANCEDB_PATH` | `./data/lancedb` | Storage directory for LanceDB vector tables |
| `METRICS_PORT` | `9090` | HTTP port for the Prometheus metrics server |
| `WORKER_CONCURRENCY` | `1` | Concurrency limit for the BullMQ ingestion worker |
| `INGESTION_RETRY_ATTEMPTS` | `3` | Maximum retry attempts for failed ingestion jobs |
| `INGESTION_RETRY_DELAY` | `1000` | Base exponential backoff delay in milliseconds |
| `LOG_LEVEL` | `info` | Pino logger level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |

---

## Project Scripts & Startup Commands

The current `package.json` defines the following test script:
- `npm test`: Runs automated test suite (`node --test test/*.test.js`).

To run the various services and tools of CodexMemory, use the corresponding Node commands:

### Quick Start with Docker Compose (Recommended)

Start the entire stack (CodexMemory services, Redis, Prometheus, and Grafana) with a single command:

```bash
docker compose up -d --build
```

This automatically runs:
- **CodexMemory**: Worker, watcher, metrics server, and Streamable HTTP MCP server (`http://127.0.0.1:3001/mcp`)
- **Redis**: Port `6379` (with persistent volume)
- **Prometheus**: Port `9091` (scraping CodexMemory metrics)
- **Grafana**: Port `3000` (with pre-provisioned dashboard)
- **Host Ollama**: Automatically bridged via `host.docker.internal:11434`

To stop:
```bash
docker compose down
```

### Running Natively with Node.js

| Component | Command | Description |
|---|---|---|
| **All Services (Dev)** | `npm run dev` | Concurrently starts metrics server, worker, watcher, and MCP HTTP server |
| **MCP Server (HTTP)** | `npm run start:mcp` | Starts the Streamable HTTP MCP server on `http://127.0.0.1:3001/mcp` |
| **MCP Server (Stdio)** | `npm run start:mcp:stdio` | Starts the MCP server using legacy stdio transport for direct CLI spawns |
| **Automated Tests** | `npm test` | Runs the full automated test suite using Node's native test runner |
| **Ingestion Worker** | `node src/worker.js` | Starts the BullMQ worker processing ingestion jobs |
| **Document Watcher** | `node src/watcher.js` | Starts watching `./docs` for file changes |
| **Metrics Server** | `node src/metrics-server.js` | Starts the Prometheus metrics HTTP server on port 9090 |

### Helper Scripts

| Script | Command | Description |
|---|---|---|
| **One-Time Bulk Ingestion** | `node scripts/ingest-once.js` | Scans `./docs`, embeds all `.md` files, and re-creates LanceDB `documents` table |
| **Manual Document Queueing** | `node scripts/queue-document.js [path]` | Enqueues a specific document into the BullMQ queue (defaults to `./docs/test.md`) |
| **Test Search Script** | `node scripts/test-search.js` | Runs a sample semantic search query directly against LanceDB |

---

## MCP Client Configuration

CodexMemory uses the official **Streamable HTTP transport** (`http://127.0.0.1:3001/mcp`), enabling any workspace or AI client to connect over HTTP without needing local file path bindings or process spawning.

### 1. VS Code Configuration (`.vscode/mcp.json`)

To connect from **any VS Code project** (fresh folder or existing repository), create a `.vscode/mcp.json` file in that project:

```json
{
  "servers": {
    "codex-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

If you have enabled Bearer token authentication by setting `MCP_AUTH_TOKEN=your-token`, include the authorization header:

```json
{
  "servers": {
    "codex-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

### 2. VS Code Global Settings (`settings.json`)

To make CodexMemory available across **all** your VS Code workspaces automatically, add the following to your User `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "codex-memory": {
        "type": "http",
        "url": "http://127.0.0.1:3001/mcp"
      }
    }
  }
}
```

### 3. Claude Desktop Configuration (`claude_desktop_config.json`)

Claude Desktop currently uses local command execution (`stdio`). You can connect using the stdio entrypoint:

```json
{
  "mcpServers": {
    "codex-memory": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/codex-memory/src/server.js",
        "--stdio"
      ]
    }
  }
}
```

---

## Available MCP Tools

The MCP server exposes the following tool:

### `search_documents`

Searches local documents using semantic similarity against the LanceDB vector table.

- **Description**: `"Searches local documents using semantic similarity"`
- **Input Parameters**:
  - `query` (*string*, required, min length: 1): The search text or question to embed and search for.
  - `topK` (*number*, optional, integer between 1 and 10, default: 5): The maximum number of nearest document chunks to return.
- **Output**:
  Formatted text list of matched chunks:
  ```text
  --- Result 1 ---
  Text: <matching chunk text>
  Source: <source file path>
  Distance: <vector distance score>
  ```
  Returns `"No matching documents found."` if no matches are found.

---

## Document Ingestion Workflow

1. **Document Placement / Modification**:
   - A Markdown file (`.md`) is created, updated, or removed in the `docs/` directory.
2. **Detection (`src/watcher.js`)**:
   - Chokidar detects file system events.
   - Non-markdown files are ignored.
3. **Queueing (`src/queue.js`)**:
   - For `add` and `change` events, `queueDocument(filePath)` adds an `ingest-document` job to the `document-ingestion` BullMQ queue in Redis.
   - For `unlink` events, `deleteDocument(filePath)` is called immediately to remove existing chunks from LanceDB without re-ingestion.
4. **Processing (`src/worker.js`)**:
   - The worker picks up the job and invokes `ingestFile()` (`src/ingest.js`).
   - The file content is read from disk.
   - `chunkText()` splits the document into chunks (chunk size: 500 words, overlap: 50 words).
   - `embedText()` sends each chunk to Ollama (`nomic-embed-text`) to generate a vector embedding.
5. **Database Storage (`src/database.js`)**:
   - The worker connects to LanceDB (`data/lancedb`).
   - Existing chunks matching the `sourceFile` path are deleted via SQL expression (`` `sourceFile` = '...' ``).
   - New chunk records are inserted into the `documents` table.
6. **Metrics & Logging**:
   - Pino logs job lifecycle (`Starting ingestion job`, `Ingestion job completed`, or `Ingestion job failed`).
   - Status, processing duration, and retry counts are written to the Redis metrics hash.
7. **Failure and Dead-Letter Queue**:
   - If an error occurs (e.g. Ollama unreachable), BullMQ retries the job up to 3 times with exponential backoff.
   - When retry attempts are exhausted, worker transfers the job to `document-ingestion-dlq` and increments `codexmemory_dead_letter_jobs_total`.

---

## Automated Tests

Run the test suite using:

```bash
npm test
```

This runs:
```bash
node --test test/*.test.js
```

### Covered Test Suites
- **`test/chunker.test.js`**: Verifies text splitting into word chunks with proper overlap.
- **`test/ingestion.test.js`**: Verifies LanceDB document chunk creation, updating/replacing chunks on file edit, and deleting chunks on document deletion using temporary test fixtures.
- **`test/search.test.js`**: Verifies validation logic for `searchDocuments()` (rejects whitespace-only queries, validates `topK` range between 1 and 50).

---

## Metrics and Observability

### Endpoint
- **URL**: `http://localhost:9090/metrics`
- **Method**: `GET`
- **Content-Type**: `text/plain`

### Exposed Metrics

#### Ingestion Metrics
- `codexmemory_ingestion_jobs_total{status="success"}`: Total number of successfully completed ingestion jobs.
- `codexmemory_ingestion_jobs_total{status="failed"}`: Total number of failed ingestion jobs.
- `codexmemory_ingestion_duration_seconds`: Histogram measuring time spent processing ingestion jobs.
  - Buckets: `0.5`, `1`, `2`, `5`, `10`, `30`, `60`, `+Inf`.
  - Sum: `codexmemory_ingestion_duration_seconds_sum`.
  - Count: `codexmemory_ingestion_duration_seconds_count`.
- `codexmemory_ingestion_retries_total`: Total count of job retry attempts.
- `codexmemory_dead_letter_jobs_total`: Total number of permanently failed jobs written to the dead-letter queue.

#### Queue Depth Metrics
- `codexmemory_ingestion_queue_jobs{state="waiting"}`: Current number of jobs waiting in the queue.
- `codexmemory_ingestion_queue_jobs{state="active"}`: Current number of jobs actively being processed.
- `codexmemory_ingestion_queue_jobs{state="completed"}`: Number of completed jobs currently retained in the queue.
- `codexmemory_ingestion_queue_jobs{state="failed"}`: Number of failed jobs currently retained in the queue.

#### Process Metrics
Standard Node.js runtime metrics collected by `prom-client` (CPU usage, memory heap statistics, event loop lag, etc.).

### Local Prometheus & Grafana Setup

A development-focused Docker Compose configuration is provided in `docker-compose.yml` to visualize CodexMemory metrics in real time.

#### 1. Start Observability Stack
Ensure Docker is running, then launch Prometheus and Grafana:

```bash
docker compose up -d
```

#### 2. Access Dashboards
- **Prometheus**: [`http://localhost:9091`](http://localhost:9091)
  - Scrapes `host.docker.internal:9090/metrics` every 5 seconds.
  - Port 9091 is mapped on the host to avoid collision with the Node.js metrics server running on port 9090.
- **Grafana**: [`http://localhost:3000`](http://localhost:3000)
  - Anonymous login is enabled by default for local development.
  - Automatically provisions the Prometheus datasource (`http://prometheus:9090`) and pre-loads the **CodexMemory Metrics** dashboard under the `CodexMemory` folder.
  - Dashboard panels include:
    - **Successful Jobs** & **Failed Jobs** (stat counters)
    - **Retry Count** & **Dead-Letter Jobs** (stat counters)
    - **Queue Waiting Jobs** & **Queue Active Jobs** (stat gauges)
    - **Ingestion Jobs by Status** (timeseries)
    - **Average Ingestion Duration** (timeseries)
    - **Queue Depth by State** (timeseries)

#### 3. Stop Observability Stack
```bash
docker compose down
```

> [!NOTE]
> If running Prometheus natively outside Docker, use `monitoring/prometheus/prometheus.yml` and replace `host.docker.internal:9090` with `127.0.0.1:9090`.

---

## Troubleshooting

### 1. Redis Not Running
- **Symptoms**:
  - `ECONNREFUSED 127.0.0.1:6379`
  - Worker or watcher fails to connect or logs unhandled connection errors.
- **Resolution**:
  - Verify Redis status: `redis-cli ping` (should output `PONG`).
  - Start the Redis service:
    ```bash
    brew services start redis
    # Or manually:
    redis-server
    ```

### 2. Ollama Unavailable
- **Symptoms**:
  - Worker logs: `Ollama error: fetch failed` or `ECONNREFUSED 127.0.0.1:11434`.
  - Searches fail with connection errors.
- **Resolution**:
  - Check whether the Ollama server is running:
    ```bash
    curl http://localhost:11434
    # Expected output: "Ollama is running"
    ```
  - Start Ollama:
    ```bash
    ollama serve
    ```

### 3. Embedding Model Missing
- **Symptoms**:
  - Worker logs: `Ollama error: 404` or error message stating model `nomic-embed-text` is not found.
- **Resolution**:
  - Pull the required model:
    ```bash
    ollama pull nomic-embed-text
    ```
  - Confirm the model is available:
    ```bash
    ollama list
    ```

### 4. LanceDB or Native Dependency Issues
- **Symptoms**:
  - `Cannot find module ... @lancedb/lancedb` or architecture/platform mismatch errors (such as on Intel Macs).
- **Resolution**:
  - The project pins `@lancedb/lancedb@0.22.3` in `package.json` specifically for platform stability.
  - Reinstall node modules:
    ```bash
    rm -rf node_modules package-lock.json
    npm install
    ```
  - Ensure the `./data/lancedb` folder is readable and writable by your user account.

### 5. Stale or Failed Queue Jobs
- **Symptoms**:
  - Jobs stuck in `waiting` or `active` states without making progress.
  - Jobs repeatedly failing and accumulating in `document-ingestion-dlq`.
- **Resolution**:
  - Check the worker logs for the root exception causing job failures.
  - Review queue counts via the metrics endpoint:
    ```bash
    curl http://localhost:9090/metrics | grep codexmemory_ingestion_queue_jobs
    ```
  - In a development environment, if you need to clear all BullMQ queue data and reset Redis metrics:
    ```bash
    redis-cli flushdb
    ```
