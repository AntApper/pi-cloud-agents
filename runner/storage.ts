/**
 * Storage Sink for in-VM MicroVM runner state and bundle persistence.
 * Provides S3StorageSink for AWS S3 and LocalStorageSink / FakeStorageSink for local execution & tests.
 */

import fs from "node:fs";
import path from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * StorageSink interface for object persistence and retrieval.
 */
export interface StorageSink {
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, data: Buffer | string | Uint8Array, contentType?: string): Promise<void>;
  listObjects?(prefix: string): Promise<string[]>;
}

export interface S3StorageSinkOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  client?: S3Client;
}

/**
 * AWS S3 implementation of StorageSink.
 */
export class S3StorageSink implements StorageSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(options: S3StorageSinkOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/^\/+|\/+$/g, "") : "";
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
      });
  }

  private resolveKey(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    if (this.prefix && !cleanKey.startsWith(`${this.prefix}/`)) {
      return `${this.prefix}/${cleanKey}`;
    }
    return cleanKey;
  }

  public async getObject(key: string): Promise<Buffer> {
    const resolvedKey = this.resolveKey(key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: resolvedKey,
    });

    const response = await this.client.send(command);
    if (!response.Body) {
      throw new Error(`S3 object '${resolvedKey}' in bucket '${this.bucket}' has empty body`);
    }

    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  public async putObject(
    key: string,
    data: Buffer | string | Uint8Array,
    contentType?: string,
  ): Promise<void> {
    const resolvedKey = this.resolveKey(key);
    const body = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: resolvedKey,
      Body: body,
      ContentType:
        contentType ??
        (resolvedKey.endsWith(".json") ? "application/json" : "application/octet-stream"),
    });

    await this.client.send(command);
  }

  public async listObjects(prefix: string): Promise<string[]> {
    const resolvedPrefix = this.resolveKey(prefix);
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: resolvedPrefix,
    });

    const response = await this.client.send(command);
    const contents = response.Contents ?? [];
    return contents.map((item) => item.Key).filter((k): k is string => typeof k === "string");
  }
}

export interface LocalStorageSinkOptions {
  baseDir?: string;
}

/**
 * Filesystem or in-memory storage sink for local testing and offline simulation.
 */
export class LocalStorageSink implements StorageSink {
  private readonly baseDir?: string;
  private readonly memoryStore = new Map<string, Buffer>();

  constructor(options: LocalStorageSinkOptions = {}) {
    this.baseDir = options.baseDir;
    if (this.baseDir) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public async getObject(key: string): Promise<Buffer> {
    const cleanKey = key.replace(/^\/+/, "");

    if (this.baseDir) {
      const filePath = path.join(this.baseDir, cleanKey);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File '${cleanKey}' not found in local storage sink at '${filePath}'`);
      }
      return fs.readFileSync(filePath);
    }

    const memData = this.memoryStore.get(cleanKey);
    if (!memData) {
      throw new Error(`Object '${cleanKey}' not found in memory storage sink`);
    }
    return memData;
  }

  public async putObject(
    key: string,
    data: Buffer | string | Uint8Array,
    _contentType?: string,
  ): Promise<void> {
    const cleanKey = key.replace(/^\/+/, "");
    const buffer = Buffer.isBuffer(data)
      ? data
      : typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data);

    if (this.baseDir) {
      const filePath = path.join(this.baseDir, cleanKey);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
    } else {
      this.memoryStore.set(cleanKey, buffer);
    }
  }

  public async listObjects(prefix: string): Promise<string[]> {
    const cleanPrefix = prefix.replace(/^\/+/, "");

    if (this.baseDir) {
      const results: string[] = [];
      const searchDir = path.join(this.baseDir, cleanPrefix);

      function walk(currentDir: string, relBase: string) {
        if (!fs.existsSync(currentDir)) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const relPath = path.join(relBase, entry.name);
          if (entry.isDirectory()) {
            walk(path.join(currentDir, entry.name), relPath);
          } else {
            results.push(relPath);
          }
        }
      }

      walk(searchDir, cleanPrefix);
      return results;
    }

    const results: string[] = [];
    for (const key of this.memoryStore.keys()) {
      if (key.startsWith(cleanPrefix)) {
        results.push(key);
      }
    }
    return results;
  }
}

/** Alias for LocalStorageSink without baseDir (in-memory). */
export class FakeStorageSink extends LocalStorageSink {}
