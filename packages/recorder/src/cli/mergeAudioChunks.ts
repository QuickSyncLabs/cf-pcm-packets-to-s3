import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { S3Client } from "@aws-sdk/client-s3";
import { loadMonorepoEnv, PrismaClient, runPrismaMigrateDeploy } from "@cf/db";
import { runMergeSession } from "../common/mergeSessionCore.js";

loadMonorepoEnv();

const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static") as { path: string };

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

    await runMergeSession({
      prisma,
      s3,
      ffmpegPath,
      ffprobePath,
      sessionId,
      bucket,
      uploadToS3: argv["upload-to-s3"],
      outputFilename: argv.output,
      s3OutputKey: argv["s3-output-key"],
    });
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
