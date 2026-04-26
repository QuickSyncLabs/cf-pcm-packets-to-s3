import { createWriteStream, existsSync, mkdirSync, WriteStream } from "node:fs";
import path from "node:path";

export class ChunkWriter {
  private readonly chunkSizeBytes: number;
  private readonly outputDir: string;
  private readonly fileExtension: string;
  private chunkIndex = 1;
  private bytesWrittenInChunk = 0;
  private stream: WriteStream;

  constructor(outputDir: string, chunkSizeBytes: number, fileExtension = "bin") {
    this.outputDir = outputDir;
    this.chunkSizeBytes = chunkSizeBytes;
    this.fileExtension = fileExtension;

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    this.stream = this.createNewStream();
  }

  write(buffer: Buffer): void {
    if (buffer.length === 0) {
      return;
    }

    let cursor = 0;
    while (cursor < buffer.length) {
      const remainingInChunk = this.chunkSizeBytes - this.bytesWrittenInChunk;
      const remainingInBuffer = buffer.length - cursor;
      const bytesToWrite = Math.min(remainingInChunk, remainingInBuffer);

      const slice = buffer.subarray(cursor, cursor + bytesToWrite);
      this.stream.write(slice);
      this.bytesWrittenInChunk += bytesToWrite;
      cursor += bytesToWrite;

      if (this.bytesWrittenInChunk >= this.chunkSizeBytes) {
        this.rollChunk();
      }
    }
  }

  close(): void {
    this.stream.end();
  }

  private rollChunk(): void {
    this.stream.end();
    this.chunkIndex += 1;
    this.bytesWrittenInChunk = 0;
    this.stream = this.createNewStream();
  }

  private createNewStream(): WriteStream {
    const fileName = `chunk-${this.chunkIndex.toString().padStart(6, "0")}.${this.fileExtension}`;
    const filePath = path.join(this.outputDir, fileName);
    return createWriteStream(filePath, { flags: "a" });
  }
}
