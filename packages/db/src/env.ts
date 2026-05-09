import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads `.env` from the monorepo root (parent of `packages/`), e.g. when
 * `npm run dev -w @cf/ingest` makes cwd `packages/ingest` and the default
 * `dotenv/config` would not see repo-root `.env`.
 */
export function loadMonorepoEnv(): void {
  const dbPackageRoot = path.resolve(__dirname, "..");
  const monorepoRoot = path.resolve(dbPackageRoot, "..", "..");
  const rootEnvPath = path.join(monorepoRoot, ".env");
  if (existsSync(rootEnvPath)) {
    config({ path: rootEnvPath });
  }
}
