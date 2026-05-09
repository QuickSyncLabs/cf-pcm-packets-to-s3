-- AlterTable
ALTER TABLE "AudioChunksLog" ADD COLUMN "trackId" TEXT NOT NULL DEFAULT '__legacy__';

-- CreateIndex
CREATE INDEX "AudioChunksLog_sessionId_trackId_receivedUnixTimestamp_idx" ON "AudioChunksLog"("sessionId", "trackId", "receivedUnixTimestamp");
