import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadMonorepoEnv } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Runs `prisma migrate deploy` from the @cf/db package root (where `prisma/schema.prisma` lives).
 * Loads monorepo-root `.env` first (see {@link loadMonorepoEnv}).
 * Skipped when SKIP_PRISMA_MIGRATE=1. Override Prisma cwd with PRISMA_PROJECT_ROOT.
 */
export function runPrismaMigrateDeploy(): void {
  if (process.env.SKIP_PRISMA_MIGRATE === "1") {
    console.warn("SKIP_PRISMA_MIGRATE=1: skipping prisma migrate deploy");
    return;
  }

  loadMonorepoEnv();

  const dbPackageRoot = path.resolve(__dirname, "..");
  const projectRoot = process.env.PRISMA_PROJECT_ROOT ?? dbPackageRoot;

  const prismaPkgDir = path.dirname(require.resolve("prisma/package.json"));
  const prismaCli = path.join(prismaPkgDir, "build/index.js");

  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy exited with code ${result.status ?? "null"}`);
  }
}
