import "dotenv/config";
import path from "node:path";
import { Kafka, logLevel } from "kafkajs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ChunkWriter } from "./chunkWriter";
import type { PacketDto } from "./types";

const ONE_MB = 1024 * 1024;
const PCM_BYTES_PER_SAMPLE = 2;

const cli = yargs(hideBin(process.argv))
  .scriptName("packet-chunker")
  .option("brokers", {
    type: "string",
    demandOption: false,
    default: process.env.KAFKA_BROKERS ?? "localhost:9092",
    describe: "Comma-separated Kafka brokers (host:port,host:port)",
  })
  .option("topic", {
    type: "string",
    demandOption: false,
    default: process.env.KAFKA_TOPIC,
    describe: "Kafka topic name",
  })
  .option("partition", {
    type: "number",
    demandOption: true,
    describe: "Kafka partition to consume",
  })
  .option("key", {
    type: "string",
    demandOption: false,
    default: process.env.KAFKA_KEY,
    describe: "Kafka message key filter (exact match)",
  })
  .option("group-id", {
    type: "string",
    demandOption: false,
    default: process.env.KAFKA_GROUP_ID ?? "packet-local-chunker",
    describe: "Consumer group id (use dedicated group for this app)",
  })
  .option("from-beginning", {
    type: "boolean",
    demandOption: false,
    default: false,
    describe: "Read from beginning when no committed offsets exist",
  })
  .option("commit", {
    type: "boolean",
    demandOption: false,
    default: true,
    describe: "Commit offsets after processing (disable with --no-commit)",
  })
  .option("chunk-size-mb", {
    type: "number",
    demandOption: false,
    default: Number(process.env.CHUNK_SIZE_MB ?? 5),
    describe: "Chunk file size in MB",
  })
  .option("output-dir", {
    type: "string",
    demandOption: false,
    default: process.env.OUTPUT_DIR ?? "./output",
    describe: "Base local output directory",
  })
  .strict()
  .help();

async function main(): Promise<void> {
  const args = await cli.parseAsync();

  if (!args.topic) {
    throw new Error("Missing --topic (or KAFKA_TOPIC in environment)");
  }
  const topicName = args.topic;

  if (!Number.isInteger(args.partition) || args.partition < 0) {
    throw new Error("--partition must be a non-negative integer");
  }

  if (!Number.isFinite(args["chunk-size-mb"]) || args["chunk-size-mb"] <= 0) {
    throw new Error("--chunk-size-mb must be a positive number");
  }

  const brokers = args.brokers
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  if (brokers.length === 0) {
    throw new Error("At least one broker is required");
  }

  const outputDir = path.join(
    args["output-dir"],
    args.topic,
    `partition-${args.partition}`,
  );

  const chunkWriter = new ChunkWriter(
    outputDir,
    Math.floor(args["chunk-size-mb"] * ONE_MB),
    "pcm",
  );
  let pendingPcmByte: number | null = null;

  const kafka = new Kafka({
    brokers,
    logLevel: logLevel.INFO,
  });

  const admin = kafka.admin();
  await admin.connect();
  const topicOffsets = await admin.fetchTopicOffsets(topicName);
  await admin.disconnect();

  const availablePartitions = topicOffsets
    .map((x) => Number(x.partition))
    .filter((x) => Number.isInteger(x))
    .sort((a, b) => a - b);

  if (!availablePartitions.includes(args.partition)) {
    throw new Error(
      [
        `Requested partition ${args.partition} is not available for topic ${args.topic}.`,
        `Available partitions: [${availablePartitions.join(", ")}]`,
      ].join(" "),
    );
  }

  const consumer = kafka.consumer({ groupId: args["group-id"] });

  consumer.on(consumer.events.GROUP_JOIN, (event) => {
    const assigned = event.payload.memberAssignment[topicName] ?? [];
    const hasRequestedPartition = assigned.includes(args.partition);
    console.log(
      `Group assignment for ${topicName}: [${assigned.join(", ")}]`,
    );
    if (!hasRequestedPartition) {
      console.warn(
        [
          `This consumer was not assigned requested partition ${args.partition}.`,
          "Use a dedicated --group-id (or stop other consumers in same group).",
        ].join(" "),
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Closing consumer and files...`);
    try {
      await consumer.disconnect();
    } finally {
      if (pendingPcmByte !== null) {
        console.warn(
          "Dropping trailing 1 byte to preserve 16-bit PCM sample alignment.",
        );
      }
      chunkWriter.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await consumer.connect();
  await consumer.subscribe({
    topic: args.topic,
    fromBeginning: args["from-beginning"],
  });

  console.log(
    [
      "Consumer started",
      `topic=${args.topic}`,
      `partition=${args.partition}`,
      `key=${args.key ?? "(any)"}`,
      `groupId=${args["group-id"]}`,
      `commit=${args.commit ? "on" : "off"}`,
      `chunkSizeMb=${args["chunk-size-mb"]}`,
      `outputDir=${outputDir}`,
    ].join(" | "),
  );

  const commitProcessedOffset = async (
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> => {
    if (!args.commit) {
      return;
    }
    await consumer.commitOffsets([
      {
        topic,
        partition,
        offset: (BigInt(offset) + 1n).toString(),
      },
    ]);
  };

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({
      topic,
      partition,
      message,
      heartbeat,
      pause,
    }): Promise<void> => {
      if (partition !== args.partition) {
        pause();
        await heartbeat();
        return;
      }
      // console.log(message.key?.toString("utf-8"))

      if (typeof args.key === "string") {
        const messageKey = message.key?.toString("utf-8") ?? "";
        if (messageKey !== args.key) {
          await commitProcessedOffset(topic, partition, message.offset);
          return;
        }
      }

      if (!message.value) {
        await commitProcessedOffset(topic, partition, message.offset);
        return;
      }

      let parsed: PacketDto;
      try {
        parsed = JSON.parse(message.value.toString("utf-8")) as PacketDto;
      } catch (error) {
        console.error(
          `Skipping non-JSON message at offset ${message.offset}:`,
          error,
        );
        await commitProcessedOffset(topic, partition, message.offset);
        return;
      }

      if (!parsed.packet || !Array.isArray(parsed.packet.payload)) {
        console.warn(
          `Skipping message with invalid packet.payload at offset ${message.offset}`,
        );
        await commitProcessedOffset(topic, partition, message.offset);
        return;
      }

      const payload = parsed.packet.payload;
      let invalidByteFound = false;
      for (let i = 0; i < payload.length; i += 1) {
        const value = payload[i];
        if (!Number.isInteger(value) || value < 0 || value > 255) {
          console.warn(
            `Skipping message at offset ${message.offset}: payload contains non-byte value at index ${i}`,
          );
          invalidByteFound = true;
          break;
        }
      }
      if (invalidByteFound) {
        await commitProcessedOffset(topic, partition, message.offset);
        return;
      }

      let bytes = Buffer.from(payload);

      if (pendingPcmByte !== null) {
        if (bytes.length === 0) {
          await commitProcessedOffset(topic, partition, message.offset);
          await heartbeat();
          return;
        }
        bytes = Buffer.concat([Buffer.from([pendingPcmByte]), bytes]);
        pendingPcmByte = null;
      }

      if (bytes.length % PCM_BYTES_PER_SAMPLE !== 0) {
        pendingPcmByte = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }

      if (bytes.length > 0) {
        chunkWriter.write(bytes);
      }

      await commitProcessedOffset(topic, partition, message.offset);

      await heartbeat();
    },
  });
}

void main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
