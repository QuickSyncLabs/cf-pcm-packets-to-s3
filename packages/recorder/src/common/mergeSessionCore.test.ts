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
  fileS3Key: string;
}): MergeChunkRow {
  return {
    id: input.id,
    userId: input.userId,
    trackId: input.trackId,
    receivedUnixTimestamp: BigInt(input.tsMs),
    fileS3Key: input.fileS3Key,
  };
}

test("preserves timestamp gaps for consecutive chunks on same lane", () => {
  const rows: MergeChunkRow[] = [
    row({ id: 1, userId: "u1", trackId: "mic", tsMs: 1000, fileS3Key: "a.opus" }),
    row({ id: 2, userId: "u1", trackId: "mic", tsMs: 6000, fileS3Key: "b.opus" }),
  ];
  const durationByKey = new Map<string, number>([
    ["a.opus", 0.1],
    ["b.opus", 0.1],
  ]);

  const tracks = buildChunkTimelineTracks(rows, 1000, durationByKey, (key) => key);

  assert.equal(tracks[0]?.timestampMs, 1000);
  assert.equal(tracks[1]?.timestampMs, 6000);
});

test("allows overlap for different tracks of the same user", () => {
  const rows: MergeChunkRow[] = [
    row({ id: 1, userId: "u1", trackId: "A", tsMs: 1000, fileS3Key: "a.opus" }),
    row({ id: 2, userId: "u1", trackId: "B", tsMs: 2000, fileS3Key: "b.opus" }),
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
    row({ id: 1, userId: "u1", trackId: "A", tsMs: 1000, fileS3Key: "a1.opus" }),
    row({ id: 2, userId: "u1", trackId: "B", tsMs: 1100, fileS3Key: "b1.opus" }),
    row({ id: 3, userId: "u1", trackId: "A", tsMs: 1200, fileS3Key: "a2.opus" }),
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
