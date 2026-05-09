import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadMonorepoEnv, PrismaClient, runPrismaMigrateDeploy } from "@cf/db";
import {
  MULTIPART_CHUNK_SIZE,
  buildTimelineFilterMs,
  multipartUpload,
  probeDurationSec,
  runFfmpeg,
  type OpusTrackMs,
} from "./mergeCommon.js";

loadMonorepoEnv();

const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static") as { path: string };

async function downloadOpusByKeys(
  s3: S3Client,
  bucket: string,
  keys: string[],
): Promise<string> {
  const tempDir = path.resolve("output", "tmp", `merge-db-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  for (const key of keys) {
    const getResp = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!getResp.Body) {
      throw new Error(`Empty body for s3://${bucket}/${key}`);
    }
    const bodyBytes = await getResp.Body.transformToByteArray();
    const safeName = key.replace(/\//g, "_");
    const localPath = path.join(tempDir, safeName);
    await writeFile(localPath, bodyBytes);
    console.log(`Downloaded s3://${bucket}/${key} → ${localPath}`);
  }

  return tempDir;
}

async function main(): Promise<void> {
  const ffmpegPath = ffmpegStatic as unknown as string | null;
  const ffprobePath = ffprobeStatic.path;

  if (!ffmpegPath) {
    throw new Error("ffmpeg-static path missing");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }
  runPrismaMigrateDeploy();

  const argv = await yargs(hideBin(process.argv))
    .scriptName("merge-audio-chunks")
    .option("session-id", {
      type: "string",
      demandOption: true,
      describe: "Session id (matches AudioChunksLog.sessionId)",
    })
    .option("s3-bucket", {
      type: "string",
      demandOption: false,
      default: process.env.S3_BUCKET,
      describe: "S3 bucket for chunk objects",
    })
    .option("s3-region", {
      type: "string",
      demandOption: false,
      default: process.env.S3_REGION ?? "us-east-1",
    })
    .option("s3-endpoint", {
      type: "string",
      demandOption: false,
      default: process.env.S3_ENDPOINT,
    })
    .option("output", {
      type: "string",
      demandOption: false,
      default: "merged-session.opus",
    })
    .option("upload-to-s3", {
      type: "boolean",
      demandOption: false,
      default: false,
    })
    .option("s3-output-key", {
      type: "string",
      demandOption: false,
      describe:
        "S3 object key for merged file when --upload-to-s3 (default: recordings/<session-id>/<output basename>)",
    })
    .check((args) => {
      if (!args["s3-bucket"]) {
        throw new Error("--s3-bucket or S3_BUCKET is required");
      }
      return true;
    })
    .strict()
    .help()
    .parseAsync();

  const sessionId = argv["session-id"]!;
  const bucket = argv["s3-bucket"]!;
  const prisma = new PrismaClient();

  try {
    const s3 = new S3Client({
      region: argv["s3-region"],
      ...(argv["s3-endpoint"] ? { endpoint: argv["s3-endpoint"] } : {}),
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });

    const rows = await prisma.audioChunksLog.findMany({
      where: { sessionId },
      orderBy: [{ receivedUnixTimestamp: "asc" }, { id: "asc" }],
    });

    if (rows.length === 0) {
      throw new Error(`No AudioChunksLog rows for sessionId=${sessionId}`);
    }

    const sessionT0 = Number(rows[0]!.receivedUnixTimestamp);
    if (!Number.isSafeInteger(sessionT0)) {
      throw new Error("session anchor receivedUnixTimestamp out of safe integer range");
    }

    const keys = rows.map((r) => r.fileS3Key);
    let tempDir: string | null = null;
    try {
      tempDir = await downloadOpusByKeys(s3, bucket, keys);

      const durationByKey = new Map<string, number>();
      for (const row of rows) {
        const safeName = row.fileS3Key.replace(/\//g, "_");
        const absPath = path.join(tempDir, safeName);
        durationByKey.set(
          row.fileS3Key,
          await probeDurationSec(ffprobePath, absPath),
        );
      }

      const perUserMixEndOffsetMs = new Map<string, number>();
      const tracks: OpusTrackMs[] = [];

      for (const row of rows) {
        const rowTs = Number(row.receivedUnixTimestamp);
        if (!Number.isSafeInteger(rowTs)) {
          throw new Error(
            `receivedUnixTimestamp out of safe integer range for row id=${row.id}`,
          );
        }

        const idealOffsetMs = rowTs - sessionT0;
        const userEnd = perUserMixEndOffsetMs.get(row.userId) ?? 0;

        // Wall-clock mix across users: same idealOffset → overlap in amix (OK).
        // Per-user floor: restarted client / new trackId can send timestamps backward;
        // then bump so this user's chunk does not overlap their own prior mix tail.
        let delayOffsetMs = Math.max(idealOffsetMs, userEnd);
        if (delayOffsetMs > idealOffsetMs) {
          console.log(
            `userId=${row.userId} row id=${row.id} trackId=${row.trackId}: bump ${idealOffsetMs}ms → ${delayOffsetMs}ms (after this user's prior audio)`,
          );
        }

        const durationSec = durationByKey.get(row.fileS3Key)!;
        const durationMs = Math.ceil(durationSec * 1000);
        const chunkMixEnd = delayOffsetMs + durationMs;
        perUserMixEndOffsetMs.set(
          row.userId,
          Math.max(userEnd, chunkMixEnd),
        );

        const safeName = row.fileS3Key.replace(/\//g, "_");
        const absPath = path.join(tempDir, safeName);
        tracks.push({
          absPath,
          timestampMs: sessionT0 + delayOffsetMs,
          fileOrdinal: row.id,
          durationSec,
        });
      }

      console.log(`Found ${tracks.length} chunks. sessionT0Ms=${sessionT0}`);

      const filterComplex = buildTimelineFilterMs(tracks, sessionT0);

      const outputFilename = argv.output;
      const outputPath = argv["upload-to-s3"]
        ? path.resolve("output", "tmp", outputFilename)
        : path.resolve(outputFilename);

      if (argv["upload-to-s3"]) {
        await mkdir(path.dirname(outputPath), { recursive: true });
      }

      const ffArgs: string[] = ["-y"];
      for (const t of tracks) {
        ffArgs.push("-i", t.absPath);
      }
      ffArgs.push(
        "-filter_complex",
        filterComplex,
        "-map",
        "[out]",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        "-f",
        "opus",
        outputPath,
      );

      await runFfmpeg(ffmpegPath, ffArgs);
      console.log(`Merged ${tracks.length} tracks → ${outputPath}`);

      if (argv["upload-to-s3"]) {
        const defaultKey = `recordings/${sessionId}/${path.basename(outputFilename)}`;
        const outKey = argv["s3-output-key"] ?? defaultKey;
        console.log(
          `Uploading merge to s3://${bucket}/${outKey} (multipart ${MULTIPART_CHUNK_SIZE / 1024 / 1024}MB parts)...`,
        );
        await multipartUpload(s3, bucket, outKey, outputPath);
        await rm(outputPath, { force: true });
        console.log(`Uploaded s3://${bucket}/${outKey}`);
      }
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
        console.log(`Cleaned up temp dir ${tempDir}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
