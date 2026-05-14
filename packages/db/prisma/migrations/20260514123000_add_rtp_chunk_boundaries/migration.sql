-- AlterTable
ALTER TABLE "AudioChunksLog"
ADD COLUMN "firstRtpTimestamp" BIGINT NOT NULL,
ADD COLUMN "lastRtpTimestamp" BIGINT NOT NULL;
