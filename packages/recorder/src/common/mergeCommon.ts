import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type S3Client,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";

export const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;

export type OpusTrackLegacy = {
  absPath: string;
  /** Wall-clock anchor in unix seconds (filename / legacy). */
  timestamp: number;
  fileOrdinal: number;
  durationSec: number;
};

export type OpusTrackMs = {
  absPath: string;
  timestampMs: number;
  fileOrdinal: number;
  durationSec: number;
};

export async function multipartUpload(
  s3: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  options?: {
    acl?: ObjectCannedACL;
  },
): Promise<void> {
  const fileStats = await stat(filePath);
  const fileSize = fileStats.size;

  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: "audio/ogg",
      ...(options?.acl ? { ACL: options.acl } : {}),
    }),
  );

  if (!UploadId) {
    throw new Error("Failed to initiate multipart upload");
  }

  const parts: { ETag: string; PartNumber: number }[] = [];

  try {
    let partNumber = 1;
    let offset = 0;

    while (offset < fileSize) {
      const end = Math.min(offset + MULTIPART_CHUNK_SIZE, fileSize);

      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = createReadStream(filePath, { start: offset, end: end - 1 });
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      });

      const { ETag } = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
          PartNumber: partNumber,
          Body: chunk,
        }),
      );

      if (!ETag) {
        throw new Error(`Missing ETag for part ${partNumber}`);
      }

      parts.push({ ETag, PartNumber: partNumber });
      console.log(`  Uploaded part ${partNumber} (${chunk.length} bytes)`);

      partNumber += 1;
      offset = end;
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
      }),
    ).catch(() => {});
    throw err;
  }
}

export async function probeDurationSec(ffprobePath: string, filePath: string): Promise<number> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffprobe failed for ${filePath} (exit=${code}): ${Buffer.concat(stderrChunks).toString("utf-8")}`,
          ),
        );
        return;
      }

      const text = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const value = Number.parseFloat(text);
      if (!Number.isFinite(value) || value <= 0) {
        reject(new Error(`ffprobe returned invalid duration for ${filePath}: "${text}"`));
        return;
      }

      resolve(value);
    });
  });
}

export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    const stderrChunks: Buffer[] = [];

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `ffmpeg failed (exit=${code}): ${Buffer.concat(stderrChunks).toString("utf-8")}`,
        ),
      );
    });
  });
}

/** Legacy: `timestamp` and `t0` are unix seconds (merge-opus filenames). */
export function buildTimelineFilter(tracks: OpusTrackLegacy[], t0: number): string {
  if (tracks.length === 0) {
    throw new Error("internal: no tracks");
  }

  if (tracks.length === 1) {
    const d = Math.max(0, Math.round((tracks[0]!.timestamp - t0) * 1000));
    return `[0:a]adelay=${d}|${d}[out]`;
  }

  const delayedLabels: string[] = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const delayMs = Math.max(0, Math.round((tracks[i]!.timestamp - t0) * 1000));
    const label = `a${i}`;
    delayedLabels.push(`[${i}:a]adelay=${delayMs}|${delayMs}[${label}]`);
  }

  const mixInputs = delayedLabels.map((_, i) => `[a${i}]`).join("");
  return `${delayedLabels.join(";")};${mixInputs}amix=inputs=${tracks.length}:dropout_transition=0:normalize=0[out]`;
}

/** DB merger: timestamps already in unix milliseconds. */
export function buildTimelineFilterMs(tracks: OpusTrackMs[], t0Ms: number): string {
  if (tracks.length === 0) {
    throw new Error("internal: no tracks");
  }

  if (tracks.length === 1) {
    const d = Math.max(0, Math.round(tracks[0]!.timestampMs - t0Ms));
    return `[0:a]adelay=${d}|${d}[out]`;
  }

  const delayedLabels: string[] = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const delayMs = Math.max(0, Math.round(tracks[i]!.timestampMs - t0Ms));
    const label = `a${i}`;
    delayedLabels.push(`[${i}:a]adelay=${delayMs}|${delayMs}[${label}]`);
  }

  const mixInputs = delayedLabels.map((_, i) => `[a${i}]`).join("");
  return `${delayedLabels.join(";")};${mixInputs}amix=inputs=${tracks.length}:dropout_transition=0:normalize=0[out]`;
}
