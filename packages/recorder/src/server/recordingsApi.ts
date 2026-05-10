import { loadMonorepoEnv, PrismaClient, runPrismaMigrateDeploy } from "@cf/db";
import {
  closeServer,
  createRecordingsApiServer,
  listenRecordingsApiServer,
  resolveMergerApiKey,
} from "./recordingsApiServer.js";

loadMonorepoEnv();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }
  runPrismaMigrateDeploy();

  const apiKey = resolveMergerApiKey();
  const prisma = new PrismaClient();
  const port = Number(process.env.MERGER_API_PORT ?? process.env.PORT ?? 3847);

  const server = createRecordingsApiServer({ prisma, apiKey, port });
  await listenRecordingsApiServer(server, port);

  const shutdown = (): void => {
    void closeServer(server).then(() => prisma.$disconnect()).then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
