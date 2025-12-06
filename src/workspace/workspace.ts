// src/workspace/b2Workspace.ts
// Production-ready Backblaze B2 S3-compatible workspace using AWS SDK v3
// - Uses @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
// - Path sanitization, retries, batch deletes, presigned URLs
// - Designed for Node / server environments. For Workers/Edge ask for alternative.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommandInput,
  DeleteObjectsCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

export interface Env {
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_S3_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_BASE_PATH?: string;
  B2_FORCE_HTTPS?: string | boolean; // optional - enforce HTTPS
}

export interface B2Config {
  endpoint: string;
  region: string;
  bucket: string;
  basePath: string; // trailing slash or empty
}

export interface ListResult {
  directories: string[];
  files: Array<{ name: string; size: number; modified: Date }>;
}

export class B2Workspace {
  private s3: S3Client;
  private config: B2Config;
  private maxRetries: number;
  private baseBackoffMs: number;

  constructor(env: Env, options?: { maxRetries?: number; baseBackoffMs?: number }) {
    this.validateEnvironment(env);

    const endpointUrl = String(env.B2_S3_ENDPOINT).trim().replace(/\/$/, '');
    const region = this.extractRegion(endpointUrl);

    this.config = {
      endpoint: endpointUrl,
      region,
      bucket: String(env.B2_BUCKET).trim(),
      basePath: this.normalizeBasePath(env.B2_BASE_PATH),
    };

    this.maxRetries = options?.maxRetries ?? 3;
    this.baseBackoffMs = options?.baseBackoffMs ?? 200;

    // Initialize S3 client pointing to B2 S3 endpoint
    // forcePathStyle: true ensures URL is endpoint/<bucket>/...
    this.s3 = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: String(env.B2_KEY_ID).trim(),
        secretAccessKey: String(env.B2_APPLICATION_KEY).trim(),
      },
      forcePathStyle: true as any, // typed differently in some SDK versions; cast to any if needed
      // Note: For Node.js runtime no special fetch polyfill needed.
    });

    // Quick URL sanity check (will throw if invalid)
    this.validateUrlConstruction();
  }

  // -------------------------
  // Validation & Helpers
  // -------------------------
  private validateEnvironment(env: Env): void {
    const required = [
      { key: 'B2_KEY_ID', value: env.B2_KEY_ID },
      { key: 'B2_APPLICATION_KEY', value: env.B2_APPLICATION_KEY },
      { key: 'B2_S3_ENDPOINT', value: env.B2_S3_ENDPOINT },
      { key: 'B2_BUCKET', value: env.B2_BUCKET },
    ];

    const missing = required.filter(r => !r.value || String(r.value).trim() === '');
    if (missing.length > 0) {
      throw new Error(`Missing required B2 environment variables: ${missing.map(m => m.key).join(', ')}`);
    }

    const endpoint = String(env.B2_S3_ENDPOINT).trim();
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      throw new Error(`B2_S3_ENDPOINT must start with http:// or https://. Got: "${endpoint}"`);
    }

    if (!endpoint.includes('.backblazeb2.com')) {
      throw new Error(`B2_S3_ENDPOINT must be a Backblaze S3 endpoint (contain ".backblazeb2.com"). Got: "${endpoint}"`);
    }
  }

  private extractRegion(endpoint: string): string {
    const m = /s3\.([^.]+)\.backblazeb2\.com/.exec(endpoint);
    if (!m) {
      throw new Error(`Cannot extract region from endpoint: "${endpoint}". Expected "s3.<region>.backblazeb2.com"`);
    }
    return m[1];
  }

  private normalizeBasePath(path?: string): string {
    if (!path) return '';
    const p = String(path).trim().replace(/^\/+|\/+$/g, '');
    return p ? `${p}/` : '';
  }

  private validateUrlConstruction(): void {
    // Try constructing a URL to check configuration correctness
    const testKey = `${this.config.basePath}__b2_workspace_test__`;
    // Path-style URL: endpoint/bucket/key
    const testUrl = `${this.config.endpoint}/${this.config.bucket}/${encodeURIComponent(testKey)}`;
    try {
      new URL(testUrl);
    } catch (err) {
      throw new Error(`Invalid B2 URL construction: ${testUrl}`);
    }
  }

  /**
   * Sanitize user-supplied path to prevent traversal & other attacks.
   * Returns a normalized key (no leading slash, no .., no null bytes)
   */
  private sanitizePath(path: string): string {
    if (typeof path !== 'string') throw new Error('Path must be a string');
    // Remove leading slashes
    let p = path.replace(/^\/+/, '');
    // Decode if percent-encoded (best-effort)
    try {
      p = decodeURIComponent(p);
    } catch {
      /* ignore decode errors - use raw */
    }
    // Remove null bytes
    if (p.includes('\0')) throw new Error('Null bytes are not allowed in path');
    // Normalize segments (remove '.' and resolve '..')
    const parts = p.split('/').filter(Boolean);
    const resolved: string[] = [];
    for (const seg of parts) {
      if (seg === '.') continue;
      if (seg === '..') {
        resolved.pop();
      } else {
        resolved.push(seg);
      }
    }
    return resolved.join('/');
  }

  /**
   * Full object key used in the bucket (includes configured basePath)
   */
  private getFullKey(path: string): string {
    const sanitized = this.sanitizePath(path);
    return `${this.config.basePath}${sanitized}`.replace(/^\/+/, '');
  }

  // -------------------------
  // Low-level retry wrapper
  // -------------------------
  private async withRetries<T>(fn: () => Promise<T>, operation = 'operation'): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        attempt++;
        const retriable = this.isRetriableError(err);
        if (!retriable || attempt > this.maxRetries) {
          // Attach attempt info
          const e = new Error(`Operation ${operation} failed after ${attempt} attempt(s): ${err?.message ?? String(err)}`);
          (e as any).cause = err;
          throw e;
        }
        const delayMs = this.baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
        await new Promise(res => setTimeout(res, delayMs));
        // try again
      }
    }
  }

  private isRetriableError(err: any): boolean {
    if (!err) return false;
    const transientStatus = [500, 502, 503, 504];
    if (err?.$metadata?.httpStatusCode && transientStatus.includes(err.$metadata.httpStatusCode)) return true;
    // SDK throttling or request timeout may present as code 'Throttling' or 'TimeoutError'
    const code = err?.name || err?.code || '';
    if (['Throttling', 'Throttled', 'RequestTimeout', 'TimeoutError', 'NetworkingError'].includes(code)) return true;
    return false;
  }

  // -------------------------
  // Public API
  // -------------------------

  /**
   * Write object (PUT). Accepts string or Uint8Array or Buffer.
   */
  async write(path: string, content: string | Uint8Array | Buffer, mimeType = 'application/octet-stream'): Promise<void> {
    const key = this.getFullKey(path);
    const input: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: key,
      Body: content as any,
      ContentType: mimeType,
    };

    await this.withRetries(
      () => this.s3.send(new PutObjectCommand(input)),
      `write(${path})`
    );
  }

  /**
   * Read object as text
   */
  async read(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const key = this.getFullKey(path);

    const res = await this.withRetries(
      () => this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })),
      `read(${path})`
    );

    if (!res.Body) throw new Error(`No body returned for ${path}`);
    return await this.streamToString(res.Body as Readable, encoding);
  }

  /**
   * Read object as bytes
   */
  async readBytes(path: string): Promise<Uint8Array> {
    const key = this.getFullKey(path);

    const res = await this.withRetries(
      () => this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })),
      `readBytes(${path})`
    );

    if (!res.Body) throw new Error(`No body returned for ${path}`);
    const buffer = await this.streamToBuffer(res.Body as Readable);
    return new Uint8Array(buffer);
  }

  /**
   * Convert stream to string
   */
  private async streamToString(stream: Readable, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    // Node Readable stream
    const chunks: Buffer[] = [];
    return await new Promise<string>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('error', err => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString(encoding)));
    });
  }

  /**
   * Convert stream to buffer
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return await new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('error', err => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * Check whether path exists: returns 'file' | 'directory' | false
   */
  async exists(path: string): Promise<'file' | 'directory' | false> {
    const key = this.getFullKey(path);

    // First try HEAD (file)
    try {
      const head = await this.withRetries(
        () => this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })),
        `exists-head(${path})`
      );
      if (head) return 'file';
    } catch (err: any) {
      // If 404 or NotFound, proceed to check listing.
      const code = err?.$metadata?.httpStatusCode;
      if (code && code !== 404) {
        // If other error, rethrow
        // but if retriable the wrapper would have retried already
      }
    }

    // Check as directory: list objects with prefix key + '/'
    const prefix = key.endsWith('/') ? key : `${key}/`;
    const list = await this.ls(path);
    if (list.files.length > 0 || list.directories.length > 0) return 'directory';
    return false;
  }

  /**
   * Delete single object
   */
  async unlink(path: string): Promise<void> {
    const key = this.getFullKey(path);
    await this.withRetries(
      () => this.s3.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })),
      `unlink(${path})`
    );
  }

  /**
   * Append string to existing file (read + write). Not efficient for big files.
   */
  async append(path: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
    let existing = '';
    try {
      existing = await this.read(path, encoding);
    } catch (err: any) {
      // If not found, we treat as empty
      if (!/NotFound|404|NoSuchKey/i.test(err?.message ?? '')) throw err;
    }
    await this.write(path, Buffer.concat([Buffer.from(existing, encoding), Buffer.from(content, encoding)]));
  }

  /**
   * Create directory marker (zero-byte object ending with '/')
   */
  async mkdir(path: string): Promise<void> {
    if (!path || !String(path).trim()) throw new Error('Path cannot be empty');
    const dirPath = path.endsWith('/') ? path : `${path}/`;
    const key = this.getFullKey(dirPath);
    await this.withRetries(
      () =>
        this.s3.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: new Uint8Array(0),
            ContentType: 'application/x-directory',
          })
        ),
      `mkdir(${path})`
    );
  }

  /**
   * List objects in directory (prefix). Uses ListObjectsV2 + delimiter='/' to simulate directories.
   */
  async ls(path = ''): Promise<ListResult> {
    const prefixRaw = this.getFullKey(path);
    const prefix = prefixRaw && !prefixRaw.endsWith('/') ? `${prefixRaw}/` : prefixRaw;

    const params = {
      Bucket: this.config.bucket,
      Prefix: prefix || undefined,
      Delimiter: '/',
      MaxKeys: 1000,
    };

    const res = await this.withRetries(
      () => this.s3.send(new ListObjectsV2Command(params)),
      `ls(${path})`
    );

    const directories: string[] = [];
    const files: Array<{ name: string; size: number; modified: Date }> = [];

    // CommonPrefixes -> directories
    const common = (res.CommonPrefixes || []).map(cp => cp.Prefix || '').filter(Boolean);
    for (const cp of common) {
      let dirName = cp;
      if (prefix) dirName = dirName.slice(prefix.length);
      if (dirName.endsWith('/')) dirName = dirName.slice(0, -1);
      if (dirName) directories.push(dirName);
    }

    // Contents -> files
    for (const obj of res.Contents || []) {
      const key = obj.Key || '';
      // skip the directory marker object if it's exactly same as prefix
      if (!key) continue;
      const name = prefix ? key.slice(prefix.length) : key;
      if (!name) continue; // skip base dir marker
      if (name.endsWith('/')) continue; // skip directory markers as files
      files.push({
        name,
        size: obj.Size ?? 0,
        modified: obj.LastModified ? new Date(obj.LastModified) : new Date(0),
      });
    }

    return { directories, files };
  }

  /**
   * Recursively delete directory - lists all keys with the prefix and deletes in batches (1000).
   */
  async rm(path: string): Promise<void> {
    if (!path || !String(path).trim()) throw new Error('Cannot delete workspace root');

    const prefixRaw = this.getFullKey(path);
    const prefix = prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;

    // Collect keys (pagination)
    const allKeys: string[] = [];
    let continuationToken: string | undefined = undefined;

    do {
      const params: any = {
        Bucket: this.config.bucket,
        Prefix: prefix,
        MaxKeys: 1000,
      };
      if (continuationToken) params.ContinuationToken = continuationToken;

      const res = await this.withRetries(
        () => this.s3.send(new ListObjectsV2Command(params)),
        `rm-list(${path})`
      );

      for (const c of res.Contents || []) {
        if (c.Key) allKeys.push(c.Key);
      }

      continuationToken = res.IsTruncated ? (res.NextContinuationToken as string | undefined) : undefined;
    } while (continuationToken);

    // Delete in batches of 1000 (S3 DeleteObjects limit)
    const batchSize = 1000;
    for (let i = 0; i < allKeys.length; i += batchSize) {
      const batch = allKeys.slice(i, i + batchSize);
      const delInput: DeleteObjectsCommandInput = {
        Bucket: this.config.bucket,
        Delete: { Objects: batch.map(k => ({ Key: k })), Quiet: true },
      };
      await this.withRetries(() => this.s3.send(new DeleteObjectsCommand(delInput)), `rm-delete-batch(${i})`);
    }
  }

  /**
   * Batch delete helper (exposed if needed)
   */
  async deleteBatch(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const delInput: DeleteObjectsCommandInput = {
      Bucket: this.config.bucket,
      Delete: { Objects: keys.map(k => ({ Key: k })), Quiet: true },
    };
    await this.withRetries(() => this.s3.send(new DeleteObjectsCommand(delInput)), `deleteBatch`);
  }

  /**
   * Create multiple directory markers under base
   */
  async createDirectoryStructure(base: string, dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      const joined = base ? `${base}/${dir}` : dir;
      await this.mkdir(joined);
    }
  }

  /**
   * Generate presigned URL (GET or PUT)
   * type: 'get' | 'put'
   * expiresIn: seconds (default 15 minutes = 900)
   */
  async presignUrl(path: string, type: 'get' | 'put' = 'get', expiresIn = 900): Promise<string> {
    const key = this.getFullKey(path);

    if (type === 'get') {
      const cmd = new GetObjectCommand({ Bucket: this.config.bucket, Key: key });
      return await getSignedUrl(this.s3, cmd, { expiresIn });
    } else {
      const cmd = new PutObjectCommand({ Bucket: this.config.bucket, Key: key });
      return await getSignedUrl(this.s3, cmd, { expiresIn });
    }
  }

  /**
   * Return config (copy)
   */
  getConfig(): B2Config {
    return { ...this.config };
  }
}
