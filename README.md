# cf-packet-to-s3 (monorepo)

TypeScript workspaces:

| Package | Path | Role |
|--------|------|------|
| **@cf/db** | `packages/db` | Prisma schema, migrations, `runPrismaMigrateDeploy()`, `PrismaClient` re-exports |
| **@cf/ingest** | `packages/ingest` | Kafka consumer: PCM → OPUS chunks, BullMQ upload to S3 + `AudioChunksLog` rows |
| **@cf/merge** | `packages/merge` | Session merge: read DB + S3, ffmpeg **amix** timeline, optional upload |

From the **repo root**, `npm run dev`, `npm run build`, `npm run merge-audio-chunks`, and `npm start` delegate to the right workspace.

On startup, ingest and merge call **`prisma migrate deploy`** (via `@cf/db`) unless `SKIP_PRISMA_MIGRATE=1`. Set **`DATABASE_URL`**. Migrations live under `packages/db/prisma/migrations/`. Override the Prisma project directory with **`PRISMA_PROJECT_ROOT`** if needed (default is `packages/db`).

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
3. Environment: see `.env.example` — **`DATABASE_URL`**, **`REDIS_URL`**, S3/AWS vars for ingest; merge needs **`DATABASE_URL`** and S3 read (and optional upload) credentials.
4. No system ffmpeg required for ingest (`ffmpeg-static`). Merge uses `ffmpeg-static` + `ffprobe-static`.

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

## Per-package scripts

- `packages/ingest`: `npm run dev` / `npm run build` / `npm start`
- `packages/merge`: `npm run merge-audio-chunks` / `npm run start` (compiled) / `npm run build`
- `packages/db`: `npm run generate` / `npm run migrate-deploy`

## Useful flags (ingest)

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

Build separate images from the **repository root** (both need the full workspace `package-lock.json` and all workspace `package.json` files for `npm ci`):

```bash
docker build -f Dockerfile.ingest -t cf-ingest .
docker build -f Dockerfile.merge -t cf-merge .
```

- **cf-ingest** — runs `node packages/ingest/dist/index.js` (pass ingest flags after the image name).
- **cf-merge** — runs `node packages/merge/dist/mergeAudioChunks.js` (CLI name `merge-audio-chunks`; pass `--session-id`, `--s3-bucket`, etc.).

Example:

```bash
docker run --rm -e DATABASE_URL -e REDIS_URL -e S3_BUCKET -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY cf-ingest \
  --topic packets-topic --partition 0 --s3-bucket my-bucket

docker run --rm -e DATABASE_URL -e S3_BUCKET -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY cf-merge \
  --session-id mySession --s3-bucket my-bucket
```

## Troubleshooting

- Partition / consumer group: use a dedicated `--group-id` if the requested partition is not assigned.
- Migrations: ensure the host running ingest or merge can reach Postgres with `DATABASE_URL`.
