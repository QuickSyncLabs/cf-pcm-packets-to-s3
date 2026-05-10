# cf-packet-to-s3 (monorepo)

TypeScript workspaces:

| Package | Path | Role |
|--------|------|------|
| **@cf/db** | `packages/db` | Prisma schema, migrations, `runPrismaMigrateDeploy()`, `PrismaClient` re-exports |
| **@cf/ingestor** | `packages/ingestor` | Kafka consumer: PCM → OPUS chunks, BullMQ upload to S3 + `AudioChunksLog` rows |
| **@cf/recorder** | `packages/recorder` | Session merge from DB + S3, ffmpeg **amix** timeline; Rabbit worker + recordings HTTP API |

From the **repo root**, `npm run dev`, `npm run build`, `npm run merge-audio-chunks`, and `npm start` delegate to the right workspace.

On startup, ingestor and recorder call **`prisma migrate deploy`** (via `@cf/db`) unless `SKIP_PRISMA_MIGRATE=1`. Set **`DATABASE_URL`**. Migrations live under `packages/db/prisma/migrations/`. Override the Prisma project directory with **`PRISMA_PROJECT_ROOT`** if needed (default is `packages/db`).

## Data shape

Expected Kafka message value (JSON). **`unixTimestamp`** must be **Unix time in milliseconds**. Message **key** must be `sessionId::userId::trackId` (segments sanitized). After a client restart, use a **new** `trackId` in the key so the merger can re-anchor and avoid timeline overlap when device timestamps reset.

```json
{
  "trackId": "08f8f2b2-346e-4d9b-9e6b-930ef66b4d00",
  "userId": "",
  "packet": {
    "sequenceNumber": 27798,
    "timestamp": 3077091851,
    "payload": [244, 255, 244, 255]
  },
  "unixTimestamp": 1717764123456
}
```

## Setup

1. Node 22 recommended.
2. From repo root: `npm install` (runs `prisma generate` for `@cf/db`).
3. Environment: see `.env.example` — **`DATABASE_URL`**, **`REDIS_URL`**, S3/AWS vars for ingestor; recorder needs **`DATABASE_URL`** and S3 read (and optional upload) credentials.
4. No system ffmpeg required for ingestor (`ffmpeg-static`). Recorder uses `ffmpeg-static` + `ffprobe-static`.

## Run ingest (dev)

```bash
npm run dev -- --topic packets-topic --partition 2 --brokers localhost:9092 --s3-bucket my-bucket
```

## Run ingest (compiled)

```bash
npm run build
npm start -- --topic packets-topic --partition 2 --brokers localhost:9092 --s3-bucket my-bucket
```

## Merge session from database + S3 (`merge-audio-chunks`)

```bash
npm run merge-audio-chunks -- --session-id mySession --s3-bucket my-bucket
```

The first **`--`** is required so npm passes the rest through to the merge CLI (without it, npm treats flags like `--session-id` as its own options and the CLI never sees them).

Optional: `--upload-to-s3`, `--s3-output-key`, `--output merged.opus`, `--s3-region`, `--s3-endpoint`.

### Recorder (Rabbit + HTTP)

- Rabbit consumer for **`SessionDeletedEvent`** + **recordings HTTP API** in one process.
- Asserts **topic** exchange `SessionDeletedEvent`, queue `merger.session-deleted`, bind `#`.
- Expects MassTransit-style JSON body with `sessionId` or `message.sessionId`.
- Uses **`S3_BUCKET`** from env (required); merge + multipart upload to `recordings/<sessionId>/merged-<sessionId>.opus`.
- Env: `RABBIT_MQ_HOST` (default `localhost`), `RABBIT_MQ_USERNAME` / `RABBIT_MQ_PASSWORD` (default `guest`), optional `RABBIT_MQ_PORT`, `RABBIT_MQ_VHOST`.
- Inserts **`MergerTasks`** row (`IN_PROGRESS` → `COMPLETED` or `FAILED`) with `taskId` (UUIDv7), `outputS3Key`, `sizeBytes`, `audioDurationInSeconds`, `failureReason` on failure.

```bash
npm run recorder --
```

Also starts **recordings HTTP API** same process (`MERGER_API_PORT` / `X-API-KEY` same as standalone).

### Recordings status HTTP API

- `GET /recordings/<sessionId>` — JSON `{ "s3Key", "status", "durationInSeconds?" }` from latest **`MergerTasks`** row for that session.
- Auth: header **`X-API-KEY`** must match **`MERGER_API_KEY`**. If unset at startup → **`randomUUID()`** generated + **`console.warn`** with value (set in `.env` for prod).
- Bind port **`MERGER_API_PORT`** or **`PORT`** (default **3847**).

```bash
npm run recordings-api --
```

## Per-package scripts

- `packages/ingestor`: `npm run dev` / `npm run build` / `npm start`
- `packages/recorder`: `merge-audio-chunks` / `recorder` / `recordings-api` / `build`
- `packages/db`: `npm run generate` / `npm run migrate-deploy`

## Useful flags (ingestor)

- `--partition` (required): partition to process
- `--key`: Kafka message key filter (exact match)
- `--topic` / `--brokers` / `--group-id` / `--from-beginning` / `--commit` or `--no-commit`
- `--chunk-size-mb`, `--output-dir`, `--pcm-sample-rate`, `--pcm-channels`, `--redis-url`
- `--delete-after-upload` / `--no-delete-after-upload`: after upload, deletes the local chunk file only (session/user/track dirs stay)

Local layout: `<output-dir>/<sessionId>/<userId>/<trackId>/<uuidv7>.opus`.  
S3 keys: `recordings/<sessionId>/<userId>/<trackId>/<uuidv7>.opus`.

## Notes

- Upload jobs: **6 attempts**, **5s fixed** BullMQ backoff.
- Offsets commit after PCM write and enqueue, not after S3/DB complete.
- `AudioChunksLog.fileS3Key` is **unique**; duplicate inserts after success are ignored in the worker.

## Docker

Build separate images from the **repository root**. Each Dockerfile runs `npm ci` with all three workspace `package.json` files (required by the lockfile), but the **build stage** only copies **`packages/db`** plus **`packages/ingestor`** or **`packages/recorder`** sources so the sibling app’s `src/` is not in the image build context for compile.

```bash
docker build -f Dockerfile.ingestor -t cf-ingestor .
docker build -f Dockerfile.recorder -t cf-recorder .
```

- **cf-ingestor** — runs `node packages/ingestor/dist/index.js` (pass ingest flags after the image name).
- **cf-recorder** — default entry `node packages/recorder/dist/main.js` (Rabbit + recordings API). CLI merge: `node packages/recorder/dist/cli/mergeAudioChunks.js`. API-only: `node packages/recorder/dist/server/recordingsApi.js`.

Example:

```bash
docker run --rm -e DATABASE_URL -e REDIS_URL -e S3_BUCKET -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY cf-ingestor \
  --topic packets-topic --partition 0 --s3-bucket my-bucket

docker run --rm -e DATABASE_URL -e S3_BUCKET -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY cf-recorder \
  node packages/recorder/dist/cli/mergeAudioChunks.js --session-id mySession --s3-bucket my-bucket
```

## Troubleshooting

- Partition / consumer group: use a dedicated `--group-id` if the requested partition is not assigned.
- Migrations: ensure the host running ingestor or recorder can reach Postgres with `DATABASE_URL`.
