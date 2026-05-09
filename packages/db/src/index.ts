import prisma from "@prisma/client";

/** Re-export via default import — native `export { x } from "@prisma/client"` breaks under Node ESM + Prisma’s CJS build (e.g. Docker). */
export const PrismaClient = prisma.PrismaClient;
export const Prisma = prisma.Prisma;

export { loadMonorepoEnv } from "./env.js";
export { runPrismaMigrateDeploy } from "./migrateDeploy.js";
