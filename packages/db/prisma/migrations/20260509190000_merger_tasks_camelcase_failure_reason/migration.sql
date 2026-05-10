-- CamelCase column names (match Prisma fields); optional failureReason
ALTER TABLE "MergerTasks" RENAME COLUMN "TaskId" TO "taskId";
ALTER TABLE "MergerTasks" RENAME COLUMN "OutputS3Key" TO "outputS3Key";
ALTER TABLE "MergerTasks" RENAME COLUMN "CreatedAt" TO "createdAt";
ALTER TABLE "MergerTasks" RENAME COLUMN "EndedAt" TO "endedAt";
ALTER TABLE "MergerTasks" RENAME COLUMN "SizeBytes" TO "sizeBytes";
ALTER TABLE "MergerTasks" RENAME COLUMN "AudioDurationInSeconds" TO "audioDurationInSeconds";

ALTER INDEX "MergerTasks_TaskId_key" RENAME TO "MergerTasks_taskId_key";
ALTER INDEX "MergerTasks_status_CreatedAt_idx" RENAME TO "MergerTasks_status_createdAt_idx";

ALTER TABLE "MergerTasks" ADD COLUMN "failureReason" TEXT;
