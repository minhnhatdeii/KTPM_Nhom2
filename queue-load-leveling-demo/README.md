# Queue Load Leveling Demo (Runnable)

**Flash-sale thumbnailing** style demo:
- Producer API (`/burst`) pushes N jobs quickly → **burst**
- RabbitMQ buffers
- Worker processes **steadily** with **retry**, **DLQ**, **idempotency (demo in-memory)**, **metrics via logs**

## Stack
- Node.js 20 (Alpine images)
- RabbitMQ 3 (management UI)
- `amqplib`, `express` (producer only)

## Run

```bash
# in repo root
docker compose up -d --build
# RabbitMQ UI: http://localhost:15672  (guest/guest)
# Producer API: http://localhost:3000
```

### Queue burst
```bash
# 1,000 jobs
curl "http://localhost:3000/burst?count=1000&topic=thumbnail.create"
# or smaller burst
curl "http://localhost:3000/burst?count=200"
```

### Quick metrics (depth/ dlq) from producer
```bash
curl "http://localhost:3000/metrics"
# => {"queue_depth":123,"dlq_depth":0}
```

### Observe
- RabbitMQ UI → **Queues** → `jobs`, `jobs.dlq`
- Worker logs show:
  - processed / retries / DLQ
  - **idempotency**: duplicates are **skipped** by key
- You can scale workers:
```bash
docker compose up -d --scale worker=3
```

### Tweak behavior
Edit `docker-compose.yml` → `worker` env:
- `PROCESS_MS`: per-job processing time (ms)
- `MAX_RETRY`: max retry attempts
- `PREFETCH`: RabbitMQ prefetch (parallelism per worker)
- `FAILURE_RATE_PCT`: simulate random failures (%)

## Structure
```
queue-load-leveling-demo/
├─ docker-compose.yml
├─ producer/
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/index.js
├─ worker/
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/index.js
└─ README.md
```

## Clean up
```bash
docker compose down -v
```

> Notes: This demo focuses on **load leveling** mechanics. Idempotency here is in-memory (per worker process). In production, store keys in a shared DB/cache (e.g., Redis/DynamoDB) and consider delayed-retry via plugin/TTL queues.
