import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";
import { S3Client } from "@aws-sdk/client-s3";
import { loadMonorepoEnv, PrismaClient, runPrismaMigrateDeploy } from "@cf/db";
import {
  closeServer,
  createRecordingsApiServer,
  listenRecordingsApiServer,
  resolveMergerApiKey,
} from "./server/recordingsApiServer.js";
import { startRecorderMq } from "./mq/recorderMq.js";

loadMonorepoEnv();

const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static") as { path: string };

async function run(): Promise<void> {
  const ffmpegPath = ffmpegStatic as unknown as string | null;
  const ffprobePath = ffprobeStatic.path;
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static path missing");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET required for merge worker");
  }

  runPrismaMigrateDeploy();

  const prisma = new PrismaClient();
  const apiKey = resolveMergerApiKey();
  const apiPort = Number(process.env.MERGER_API_PORT ?? process.env.PORT ?? 3847);
  const httpServer = createRecordingsApiServer({ prisma, apiKey, port: apiPort });
  await listenRecordingsApiServer(httpServer, apiPort);

  const s3 = new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  const mq = await startRecorderMq({
    prisma,
    s3,
    ffmpegPath,
    ffprobePath,
    bucket,
  });

  const shutdown = async (): Promise<void> => {
    await closeServer(httpServer);
    await mq.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void run().catch((e) => {
  console.error(e);
  process.exit(1);
});
