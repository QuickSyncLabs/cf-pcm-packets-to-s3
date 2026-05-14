import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { PrismaClient } from "@prisma/client";
import {
  MULTIPART_CHUNK_SIZE,
  buildTimelineFilterMs,
  multipartUpload,
  probeDurationSec,
  runFfmpeg,
  type OpusTrackMs,
} from "./mergeCommon.js";

export type RunMergeSessionParams = {
  prisma: PrismaClient;
  s3: S3Client;
  ffmpegPath: string;
  ffprobePath: string;
  sessionId: string;
  bucket: string;
  uploadToS3: boolean;
  outputFilename: string;
  s3OutputKey?: string;
};

export type RunMergeSessionResult = {
  outputS3Key: string | null;
  sizeBytes: bigint;
  audioDurationInSeconds: number;
};

export type MergeChunkRow = {
  id: number;
  userId: string;
  trackId: string;
  receivedUnixTimestamp: bigint;
  firstRtpTimestamp: bigint;
  lastRtpTimestamp: bigint;
  fileS3Key: string;
};

const RTP_CLOCK_RATE_HZ = 48_000;
const RTP_MODULUS = 2 ** 32;
const RTP_HALF_MODULUS = 2 ** 31;

type LaneTimingState = {
  laneAnchorOffsetMs: number;
  laneBaseRtpTimestamp: number;
  laneEndMs: number;
};

function parseUnsignedRtpTimestamp(
  value: bigint,
  rowId: number,
  fieldName: "firstRtpTimestamp" | "lastRtpTimestamp",
): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 0xffff_ffff) {
    throw new Error(`${fieldName} out of uint32 range for row id=${rowId}`);
  }
  return num;
}

function signedRtpDelta(current: number, baseline: number): number {
  const wrapped = ((((current - baseline) % RTP_MODULUS) + RTP_MODULUS) % RTP_MODULUS) as number;
  return wrapped >= RTP_HALF_MODULUS ? wrapped - RTP_MODULUS : wrapped;
}

export function buildChunkTimelineTracks(
  rows: MergeChunkRow[],
  sessionT0: number,
  durationByKey: Map<string, number>,
  resolveAbsPath: (fileS3Key: string) => string,
): OpusTrackMs[] {
  /** Timing state for each (userId, trackId) lane. */
  const perLaneTiming = new Map<string, LaneTimingState>();
  const tracks: OpusTrackMs[] = [];

  for (const row of rows) {
    const rowTs = Number(row.receivedUnixTimestamp);
    if (!Number.isSafeInteger(rowTs)) {
      throw new Error(
        `receivedUnixTimestamp out of safe integer range for row id=${row.id}`,
      );
    }

    const firstRtpTimestamp = parseUnsignedRtpTimestamp(
      row.firstRtpTimestamp,
      row.id,
      "firstRtpTimestamp",
    );
    const lastRtpTimestamp = parseUnsignedRtpTimestamp(
      row.lastRtpTimestamp,
      row.id,
      "lastRtpTimestamp",
    );
    const chunkRtpSpan = signedRtpDelta(lastRtpTimestamp, firstRtpTimestamp);
    if (chunkRtpSpan < 0) {
      throw new Error(`lastRtpTimestamp precedes firstRtpTimestamp for row id=${row.id}`);
    }

    const laneKey = `${row.userId}\x1e${row.trackId}`;
    const laneState = perLaneTiming.get(laneKey);
    const laneAnchorOffsetMs = laneState?.laneAnchorOffsetMs ?? rowTs - sessionT0;
    const laneBaseRtpTimestamp = laneState?.laneBaseRtpTimestamp ?? firstRtpTimestamp;
    const laneEnd = laneState?.laneEndMs ?? 0;
    const laneRtpDeltaTicks = signedRtpDelta(firstRtpTimestamp, laneBaseRtpTimestamp);
    const laneRtpDeltaMs = (laneRtpDeltaTicks * 1000) / RTP_CLOCK_RATE_HZ;
    const idealOffsetMs = laneAnchorOffsetMs + laneRtpDeltaMs;
    const delayOffsetMs = Math.max(idealOffsetMs, laneEnd);
    if (delayOffsetMs > idealOffsetMs) {
      console.log(
        `userId=${row.userId} row id=${row.id} trackId=${row.trackId}: bump ${idealOffsetMs}ms → ${delayOffsetMs}ms (after this lane's prior audio)`,
      );
    }

    const durationSec = durationByKey.get(row.fileS3Key);
    if (durationSec === undefined) {
      throw new Error(`Missing duration for key ${row.fileS3Key}`);
    }
    const durationMs = Math.ceil(durationSec * 1000);
    const chunkMixEnd = delayOffsetMs + durationMs;
    perLaneTiming.set(laneKey, {
      laneAnchorOffsetMs,
      laneBaseRtpTimestamp,
      laneEndMs: chunkMixEnd,
    });

    tracks.push({
      absPath: resolveAbsPath(row.fileS3Key),
      timestampMs: sessionT0 + delayOffsetMs,
      fileOrdinal: row.id,
      durationSec,
    });
  }

  return tracks;
}

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

export async function runMergeSession(
  params: RunMergeSessionParams,
): Promise<RunMergeSessionResult> {
  const {
    prisma,
    s3,
    ffmpegPath,
    ffprobePath,
    sessionId,
    bucket,
    uploadToS3,
    outputFilename,
    s3OutputKey: s3OutKeyOpt,
  } = params;

  const rows = (await prisma.audioChunksLog.findMany({
    where: { sessionId },
    orderBy: [{ receivedUnixTimestamp: "asc" }, { id: "asc" }],
  })) as MergeChunkRow[];

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

    const resolvedTempDir = tempDir;
    const tracks = buildChunkTimelineTracks(
      rows,
      sessionT0,
      durationByKey,
      (fileS3Key) => {
        const safeName = fileS3Key.replace(/\//g, "_");
        return path.join(resolvedTempDir, safeName);
      },
    );

    console.log(`Found ${tracks.length} chunks. sessionT0Ms=${sessionT0}`);

    const filterComplex = buildTimelineFilterMs(tracks, sessionT0);

    const outputPath = uploadToS3
      ? path.resolve("output", "tmp", outputFilename)
      : path.resolve(outputFilename);

    if (uploadToS3) {
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

    const audioDurationInSeconds = await probeDurationSec(ffprobePath, outputPath);
    const st = await stat(outputPath);
    const sizeBytes = BigInt(st.size);

    let finalS3Key: string | null = null;
    if (uploadToS3) {
      const defaultKey = `recordings/${sessionId}/${path.basename(outputFilename)}`;
      const outKey = s3OutKeyOpt ?? defaultKey;
      finalS3Key = outKey;
      console.log(
        `Uploading merge to s3://${bucket}/${outKey} (multipart ${MULTIPART_CHUNK_SIZE / 1024 / 1024}MB parts)...`,
      );
      await multipartUpload(s3, bucket, outKey, outputPath, {
        acl: "public-read",
      });
      await rm(outputPath, { force: true });
      console.log(`Uploaded s3://${bucket}/${outKey}`);
    }

    return {
      outputS3Key: finalS3Key,
      sizeBytes,
      audioDurationInSeconds,
    };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      console.log(`Cleaned up temp dir ${tempDir}`);
    }
  }
}
