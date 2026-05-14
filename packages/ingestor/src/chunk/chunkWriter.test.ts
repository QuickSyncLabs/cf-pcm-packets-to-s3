import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ChunkWriter, type ChunkResult } from "./chunkWriter.js";

test("tracks first/last RTP across chunk split boundaries", async () => {
  const baseOutputDir = await mkdtemp(path.join(tmpdir(), "chunk-writer-"));
  const seen: ChunkResult[] = [];

  try {
    const writer = new ChunkWriter({
      baseOutputDir,
      sessionId: "s1",
      userId: "u1",
      trackId: "t1",
      chunkSizeBytes: 8,
      onChunkReady: (result) => {
        seen.push(result);
      },
    });

    await writer.write(Buffer.alloc(12, 1), 1000, 111);
    await writer.write(Buffer.alloc(4, 2), 2000, 222);
    await writer.close();

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.anchorUnixTimestampMs, 1000);
    assert.equal(seen[0]?.firstRtpTimestamp, 111);
    assert.equal(seen[0]?.lastRtpTimestamp, 111);

    assert.equal(seen[1]?.anchorUnixTimestampMs, 1000);
    assert.equal(seen[1]?.firstRtpTimestamp, 111);
    assert.equal(seen[1]?.lastRtpTimestamp, 222);
  } finally {
    await rm(baseOutputDir, { recursive: true, force: true });
  }
});
