import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export function resolveMergerApiKey(): string {
  const fromEnv = process.env.MERGER_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const generated = randomUUID();
  console.warn(
    `[recordings-api] MERGER_API_KEY unset — generated (set in .env for stable auth):\n${generated}`,
  );
  return generated;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json, "utf8"),
  });
  res.end(json);
}

function getHeaderKey(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-api-key"];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export type RecordingsApiServerOptions = {
  prisma: PrismaClient;
  apiKey: string;
  port: number;
};

/**
 * Binds GET /recordings/:sessionId. Does not call listen — caller can await listenSync or wrap server.listen.
 */
export function createRecordingsApiServer(opts: RecordingsApiServerOptions): Server {
  const { prisma, apiKey: expectedKey } = opts;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/$/, "") || "/";

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }

      const m = /^\/recordings\/([^/]+)$/.exec(path);
      if (!m) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const sessionId = decodeURIComponent(m[1]!);
      const key = getHeaderKey(req);
      if (!key || key !== expectedKey) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      try {
        const task = await prisma.mergerTask.findFirst({
          where: { sessionId },
          orderBy: { createdAt: "desc" },
        });

        if (!task) {
          sendJson(res, 404, { error: "not found" });
          return;
        }

        const payload: {
          s3Key: string;
          status: string;
          durationInSeconds?: number;
        } = {
          s3Key: task.outputS3Key ?? "",
          status: task.status,
        };
        if (task.audioDurationInSeconds != null) {
          payload.durationInSeconds = Math.round(task.audioDurationInSeconds);
        }
        sendJson(res, 200, payload);
      } catch (e) {
        console.error("[recordings-api] error:", e);
        sendJson(res, 500, { error: "internal error" });
      }
    })();
  });
}

export function listenRecordingsApiServer(
  server: Server,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      console.log(`[recordings-api] listening on :${port} GET /recordings/:sessionId`);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
