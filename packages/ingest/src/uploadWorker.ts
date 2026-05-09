import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile, unlink } from "node:fs/promises";
import { Prisma, PrismaClient } from "@cf/db";

export type UploadJobData = {
  localPath: string;
  s3Key: string;
  sessionId: string;
  userId: string;
  trackId: string;
  anchorUnixTimestampMs: number;
};

export type UploadWorkerOptions = {
  queueName: string;
  connection: Redis;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  deleteAfterUpload: boolean;
  concurrency?: number;
};

export type UploadWorkerHandle = {
  worker: Worker<UploadJobData>;
  prisma: PrismaClient;
};

export function createUploadWorker(opts: UploadWorkerOptions): UploadWorkerHandle {
  const prisma = new PrismaClient();
  const s3 = new S3Client({
    region: opts.s3Region,
    ...(opts.s3Endpoint ? { endpoint: opts.s3Endpoint } : {}),
    ...(opts.s3AccessKeyId && opts.s3SecretAccessKey
      ? {
          credentials: {
            accessKeyId: opts.s3AccessKeyId,
            secretAccessKey: opts.s3SecretAccessKey,
          },
        }
      : {}),
  });

  const worker = new Worker<UploadJobData>(
    opts.queueName,
    async (job: Job<UploadJobData>) => {
      const { localPath, s3Key, sessionId, userId, trackId, anchorUnixTimestampMs } =
        job.data;

      const body = await readFile(localPath);

      await s3.send(
        new PutObjectCommand({
          Bucket: opts.s3Bucket,
          Key: s3Key,
          Body: body,
          ContentType: "audio/ogg",
        }),
      );

      console.log(`Uploaded s3://${opts.s3Bucket}/${s3Key} (${body.length} bytes)`);

      try {
        await prisma.audioChunksLog.create({
          data: {
            sessionId,
            userId,
            trackId,
            receivedUnixTimestamp: BigInt(anchorUnixTimestampMs),
            fileS3Key: s3Key,
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          console.warn(
            `AudioChunksLog row already exists for ${s3Key} (job ${job.id}); continuing`,
          );
        } else {
          throw err;
        }
      }

      if (opts.deleteAfterUpload) {
        await unlink(localPath);
        console.log(`Deleted local ${localPath}`);
      }
    },
    {
      connection: opts.connection,
      concurrency: opts.concurrency ?? 3,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`Upload job ${job?.id} failed: ${err.message}`);
  });

  return { worker, prisma };
}
