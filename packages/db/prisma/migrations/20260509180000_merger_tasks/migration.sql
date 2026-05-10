-- CreateEnum
CREATE TYPE "MergerTaskStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "MergerTasks" (
    "id" SERIAL NOT NULL,
    "TaskId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "MergerTaskStatus" NOT NULL,
    "OutputS3Key" TEXT,
    "CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "EndedAt" TIMESTAMP(3),
    "SizeBytes" BIGINT,
    "AudioDurationInSeconds" DOUBLE PRECISION,

    CONSTRAINT "MergerTasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MergerTasks_TaskId_key" ON "MergerTasks"("TaskId");

-- CreateIndex
CREATE INDEX "MergerTasks_sessionId_idx" ON "MergerTasks"("sessionId");

-- CreateIndex
CREATE INDEX "MergerTasks_status_CreatedAt_idx" ON "MergerTasks"("status", "CreatedAt");
