import amqp from "amqplib";
import type { S3Client } from "@aws-sdk/client-s3";
import { v7 as uuidv7 } from "uuid";
import type { PrismaClient } from "@prisma/client";
import { extractSessionIdFromMassTransitBody } from "../common/massTransitEnvelope.js";
import { runMergeSession } from "../common/mergeSessionCore.js";

const EXCHANGE = "Infrastructure.Contracts:SessionDeletedEvent";
const QUEUE = "merger.session-deleted";

function buildAmqpUrl(): string {
  const host = process.env.RABBIT_MQ_HOST ?? "localhost";
  const username = process.env.RABBIT_MQ_USERNAME ?? "guest";
  const password = process.env.RABBIT_MQ_PASSWORD ?? "guest";
  const port = process.env.RABBIT_MQ_PORT ?? "5672";
  const vhost = process.env.RABBIT_MQ_VHOST ?? "/";
  return `amqp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(vhost)}`;
}

export type RecorderMqDeps = {
  prisma: PrismaClient;
  s3: S3Client;
  ffmpegPath: string;
  ffprobePath: string;
  bucket: string;
};

export type RecorderMqHandle = {
  stop: () => Promise<void>;
};

export async function startRecorderMq(deps: RecorderMqDeps): Promise<RecorderMqHandle> {
  const { prisma, s3, ffmpegPath, ffprobePath, bucket } = deps;

  const url = buildAmqpUrl();
  console.log(`RabbitMQ: connecting (exchange ${EXCHANGE}, queue ${QUEUE})`);
  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();
  await ch.assertExchange(EXCHANGE, "fanout", { durable: true });
  const { queue } = await ch.assertQueue(QUEUE, { durable: true });
  await ch.bindQueue(queue, EXCHANGE, "#");
  await ch.prefetch(1);

  console.log("Waiting for SessionDeletedEvent messages…");

  await ch.consume(queue, (msg) => {
    void (async () => {
      if (!msg) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.content.toString("utf-8"));
      } catch {
        console.error("Invalid JSON envelope, nack");
        ch.nack(msg, false, false);
        return;
      }

      const sessionId = extractSessionIdFromMassTransitBody(parsed);
      if (!sessionId) {
        console.error("No sessionId in MassTransit body:", parsed);
        ch.nack(msg, false, false);
        return;
      }

      const taskId = uuidv7();
      try {
        await prisma.mergerTask.create({
          data: {
            taskId,
            sessionId,
            status: "IN_PROGRESS",
          },
        });
      } catch (e) {
        console.error("mergerTask.create failed:", e);
        ch.nack(msg, false, false);
        return;
      }

      try {
        const outName = `merged-${sessionId}.opus`;
        const result = await runMergeSession({
          prisma,
          s3,
          ffmpegPath,
          ffprobePath,
          sessionId,
          bucket,
          uploadToS3: true,
          outputFilename: outName,
        });

        await prisma.mergerTask.update({
          where: { taskId },
          data: {
            status: "COMPLETED",
            outputS3Key: result.outputS3Key,
            endedAt: new Date(),
            sizeBytes: result.sizeBytes,
            audioDurationInSeconds: result.audioDurationInSeconds,
          },
        });
        ch.ack(msg);
        console.log(`Done task ${taskId} session=${sessionId}`);
      } catch (err) {
        console.error(`Merge failed task=${taskId} session=${sessionId}:`, err);
        const failureReason =
          err instanceof Error
            ? err.message.slice(0, 8000)
            : String(err).slice(0, 8000);
        try {
          await prisma.mergerTask.update({
            where: { taskId },
            data: {
              status: "FAILED",
              endedAt: new Date(),
              failureReason,
            },
          });
        } catch (upErr) {
          console.error("mergerTask FAILED update:", upErr);
        }
        ch.nack(msg, false, false);
      }
    })().catch((e) => {
      console.error("consume handler error:", e);
      if (msg) {
        ch.nack(msg, false, false);
      }
    });
  });

  return {
    stop: async (): Promise<void> => {
      await ch.close();
      await conn.close();
    },
  };
}
