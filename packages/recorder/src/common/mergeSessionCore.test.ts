import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChunkTimelineTracks,
  type MergeChunkRow,
} from "./mergeSessionCore.js";

function row(input: {
  id: number;
  userId: string;
  trackId: string;
  tsMs: number;
  firstRtpTimestamp?: number;
  lastRtpTimestamp?: number;
  fileS3Key: string;
}): MergeChunkRow {
  return {
    id: input.id,
    userId: input.userId,
    trackId: input.trackId,
    receivedUnixTimestamp: BigInt(input.tsMs),
    firstRtpTimestamp: BigInt(input.firstRtpTimestamp ?? 0),
    lastRtpTimestamp: BigInt(input.lastRtpTimestamp ?? input.firstRtpTimestamp ?? 0),
    fileS3Key: input.fileS3Key,
  };
}

test("uses RTP spacing even when server receive timestamps are noisy", () => {
  const rows: MergeChunkRow[] = [
    row({
      id: 1,
      userId: "u1",
      trackId: "mic",
      tsMs: 1000,
      firstRtpTimestamp: 0,
      lastRtpTimestamp: 96_000,
      fileS3Key: "a.opus",
    }),
    row({
      id: 2,
      userId: "u1",
      trackId: "mic",
      tsMs: 9000,
      firstRtpTimestamp: 96_000,
      lastRtpTimestamp: 192_000,
      fileS3Key: "b.opus",
    }),
  ];
  const durationByKey = new Map<string, number>([
    ["a.opus", 2.0],
    ["b.opus", 2.0],
  ]);

  const tracks = buildChunkTimelineTracks(rows, 1000, durationByKey, (key) => key);

  assert.equal(tracks[0]?.timestampMs, 1000);
  assert.equal(tracks[1]?.timestampMs, 3000);
});

test("allows overlap for different tracks of the same user", () => {
  const rows: MergeChunkRow[] = [
    row({
      id: 1,
      userId: "u1",
      trackId: "A",
      tsMs: 1000,
      firstRtpTimestamp: 0,
      lastRtpTimestamp: 192_000,
      fileS3Key: "a.opus",
    }),
    row({
      id: 2,
      userId: "u1",
      trackId: "B",
      tsMs: 2000,
      firstRtpTimestamp: 0,
      lastRtpTimestamp: 4_800,
      fileS3Key: "b.opus",
    }),
  ];
  const durationByKey = new Map<string, number>([
    ["a.opus", 4.0],
    ["b.opus", 0.1],
  ]);

  const tracks = buildChunkTimelineTracks(rows, 1000, durationByKey, (key) => key);

  assert.equal(tracks[0]?.timestampMs, 1000);
  assert.equal(tracks[1]?.timestampMs, 2000);
});

test("keeps same-lane chunks sequential even when interleaved by another lane", () => {
  const rows: MergeChunkRow[] = [
    row({
      id: 1,
      userId: "u1",
      trackId: "A",
      tsMs: 1000,
      firstRtpTimestamp: 0,
      lastRtpTimestamp: 48_000,
      fileS3Key: "a1.opus",
    }),
    row({
      id: 2,
      userId: "u1",
      trackId: "B",
      tsMs: 1100,
      firstRtpTimestamp: 0,
      lastRtpTimestamp: 24_000,
      fileS3Key: "b1.opus",
    }),
    row({
      id: 3,
      userId: "u1",
      trackId: "A",
      tsMs: 1200,
      firstRtpTimestamp: 9_600,
      lastRtpTimestamp: 57_600,
      fileS3Key: "a2.opus",
    }),
  ];
  const durationByKey = new Map<string, number>([
    ["a1.opus", 1.0],
    ["b1.opus", 0.5],
    ["a2.opus", 1.0],
  ]);

  const tracks = buildChunkTimelineTracks(rows, 1000, durationByKey, (key) => key);

  assert.equal(tracks[0]?.timestampMs, 1000);
  assert.equal(tracks[1]?.timestampMs, 1100);
  assert.equal(tracks[2]?.timestampMs, 2000);
});

test("handles RTP wrap using signed 32-bit delta", () => {
  const rows: MergeChunkRow[] = [
    row({
      id: 1,
      userId: "u1",
      trackId: "mic",
      tsMs: 1000,
      firstRtpTimestamp: 0xffff_ff00,
      lastRtpTimestamp: 0xffff_ff80,
      fileS3Key: "w1.opus",
    }),
    row({
      id: 2,
      userId: "u1",
      trackId: "mic",
      tsMs: 5000,
      firstRtpTimestamp: 0x0000_0080,
      lastRtpTimestamp: 0x0000_0100,
      fileS3Key: "w2.opus",
    }),
  ];
  const durationByKey = new Map<string, number>([
    ["w1.opus", 0.1],
    ["w2.opus", 0.1],
  ]);

  const tracks = buildChunkTimelineTracks(rows, 1000, durationByKey, (key) => key);

  assert.equal(tracks[0]?.timestampMs, 1000);
  assert.equal(tracks[1]?.timestampMs, 1100);
});
