-- CreateTable
CREATE TABLE "AudioChunksLog" (
    "id" SERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "receivedUnixTimestamp" BIGINT NOT NULL,
    "fileS3Key" TEXT NOT NULL,

    CONSTRAINT "AudioChunksLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AudioChunksLog_fileS3Key_key" ON "AudioChunksLog"("fileS3Key");

-- CreateIndex
CREATE INDEX "AudioChunksLog_sessionId_receivedUnixTimestamp_idx" ON "AudioChunksLog"("sessionId", "receivedUnixTimestamp");
