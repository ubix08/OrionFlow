// src/workspace/workspace.ts - Enhanced B2 Workspace with Retry & Error Handling

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

// =============================================================
// Types
// =============================================================

interface B2Config {
  endpoint: string;
  region: string;
  bucket: string;
  basePath: string;
}

interface ListResult {
  directories: string[];
  files: Array<{
    name: string;
    size: number;
    modified: Date;
    etag?: string;
  }>;
}

interface B2Error {
  code: string;
  message: string;
  requestId?: string;
  resource?: string;
}

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

// =============================================================
// XML Parser (Workers-Compatible)
// =============================================================

class SimpleXMLParser {
  static parseListObjectsV2(xml: string): {
    contents: Array<{ key: string; size: number; lastModified: string; etag?: string }>;
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  } {
    const contents: Array<{ key: string; size: number; lastModified: string; etag?: string }> = [];
    const commonPrefixes: string[] = [];

    // Parse <Contents> blocks
    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;
    
    while ((match = contentsRegex.exec(xml)) !== null) {
      const contentBlock = match[1];
      
      const keyMatch = /<Key>([^<]+)<\/Key>/.exec(contentBlock);
      const sizeMatch = /<Size>(\d+)<\/Size>/.exec(contentBlock);
      const lastModifiedMatch = /<LastModified>([^<]+)<\/LastModified>/.exec(contentBlock);
      const etagMatch = /<ETag>"?([^<"]+)"?<\/ETag>/.exec(contentBlock);
      
      if (keyMatch && sizeMatch && lastModifiedMatch) {
        contents.push({
          key: keyMatch[1],
          size: parseInt(sizeMatch[1], 10),
          lastModified: lastModifiedMatch[1],
          etag: etagMatch ? etagMatch[1] : undefined
        });
      }
    }

    // Parse <CommonPrefixes> blocks
    const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>([^<]+)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
    while ((match = prefixRegex.exec(xml)) !== null) {
      commonPrefixes.push(match[1]);
    }

    // Parse pagination info
    const isTruncatedMatch = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml);
    const isTruncated = isTruncatedMatch ? isTruncatedMatch[1] === 'true' : false;
    
    const nextTokenMatch = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    const nextContinuationToken = nextTokenMatch ? nextTokenMatch[1] : undefined;

    return { contents, commonPrefixes, isTruncated, nextContinuationToken };
  }

  static parseError(xml: string): B2Error {
    const codeMatch = /<Code>([^<]+)<\/Code>/.exec(xml);
    const messageMatch = /<Message>([^<]+)<\/Message>/.exec(xml);
    const requestIdMatch = /<RequestId>([^<]+)<\/RequestId>/.exec(xml);
    const resourceMatch = /<Resource>([^<]+)<\/Resource>/.exec(xml);

    return {
      code: codeMatch ? codeMatch[1] : 'UnknownError',
      message: messageMatch ? messageMatch[1] : 'Unknown error occurred',
      requestId: requestIdMatch ? requestIdMatch[1] : undefined,
      resource: resourceMatch ? resourceMatch[1] : undefined
    };
  }
}

// =============================================================
// Retry Logic with Exponential Backoff
// =============================================================

class RetryHelper {
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const {
      maxAttempts = 3,
      initialDelayMs = 1000,
      maxDelayMs = 10000,
      backoffMultiplier = 2
    } = options;

    let lastError: Error | undefined;
    let delay = initialDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on certain errors
        if (this.isNonRetryableError(lastError)) {
          throw lastError;
        }

        if (attempt < maxAttempts) {
          console.warn(`[RetryHelper] Attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
          await this.sleep(delay);
          delay = Math.min(delay * backoffMultiplier, maxDelayMs);
        }
      }
    }

    throw lastError || new Error('Operation failed after retries');
  }

  private static isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    // Don't retry on client errors (4xx except 429)
    const nonRetryable = [
      '400', '401', '403', '404', '405', '409', '410', '422'
    ];
    
    return nonRetryable.some(code => message.includes(code));
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================
// B2 Workspace Implementation
// =============================================================

class WorkspaceImpl {
  private s3: AwsClient;
  private config: B2Config;

  constructor(env: Env) {
    this.validateEnvironment(env);

    const endpointUrl = String(env.B2_S3_ENDPOINT).trim();
    const region = this.extractRegion(endpointUrl);

    this.config = {
      endpoint: endpointUrl.replace(/\/$/, ''),
      region,
      bucket: String(env.B2_BUCKET).trim(),
      basePath: this.normalizeBasePath(env.B2_BASE_PATH as string | undefined)
    };

    this.s3 = new AwsClient({
      accessKeyId: String(env.B2_KEY_ID).trim(),
      secretAccessKey: String(env.B2_APPLICATION_KEY).trim(),
      service: 's3',
      region: this.config.region
    });

    console.log('[B2Workspace] Initialized:', {
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      basePath: this.config.basePath || '(root)'
    });

    this.validateUrlConstruction();
  }

  private validateEnvironment(env: Env): void {
    const required = [
      { key: 'B2_KEY_ID', value: env.B2_KEY_ID },
      { key: 'B2_APPLICATION_KEY', value: env.B2_APPLICATION_KEY },
      { key: 'B2_S3_ENDPOINT', value: env.B2_S3_ENDPOINT },
      { key: 'B2_BUCKET', value: env.B2_BUCKET }
    ];

    const missing = required.filter(r => !r.value || String(r.value).trim() === '');
    
    if (missing.length > 0) {
      throw new Error(`Missing B2 environment variables: ${missing.map(m => m.key).join(', ')}`);
    }

    const endpoint = String(env.B2_S3_ENDPOINT).trim();
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      throw new Error(
        `B2_S3_ENDPOINT must start with http:// or https://. ` +
        `Expected: https://s3.<region>.backblazeb2.com`
      );
    }

    if (!endpoint.includes('.backblazeb2.com')) {
      throw new Error(
        `B2_S3_ENDPOINT appears invalid. ` +
        `Expected format: https://s3.<region>.backblazeb2.com`
      );
    }
  }

  private extractRegion(endpoint: string): string {
    const regionMatch = /s3\.([^.]+)\.backblazeb2\.com/.exec(endpoint);
    
    if (!regionMatch) {
      throw new Error(
        `Cannot extract region from B2_S3_ENDPOINT: "${endpoint}". ` +
        `Expected format: https://s3.<region>.backblazeb2.com`
      );
    }

    return regionMatch[1];
  }

  private normalizeBasePath(path: string | undefined): string {
    if (!path || path.trim() === '') return '';
    const normalized = path.replace(/^\/+|\/+$/g, '');
    return normalized ? `${normalized}/` : '';
  }

  private validateUrlConstruction(): void {
    try {
      const testPath = 'test/file.txt';
      const testUrl = this.buildUrl(testPath);
      new URL(testUrl);
    } catch (error) {
      throw new Error(
        `B2 configuration validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private sanitizePath(path: string): string {
    let clean = path.replace(/^\/+/, '');
    
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // Use as-is if decode fails
    }
    
    const parts = clean.split('/').filter(p => p && p !== '.');
    const resolved: string[] = [];
    
    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    
    const sanitized = resolved.join('/');
    
    if (sanitized.includes('\0')) {
      throw new Error('Null bytes not allowed in path');
    }
    
    return sanitized;
  }

  private getFullPath(path: string): string {
    const sanitized = this.sanitizePath(path);
    return this.config.basePath + sanitized;
  }

  private buildUrl(path: string): string {
    const fullPath = this.getFullPath(path);
    const encodedPath = fullPath.split('/').map(s => encodeURIComponent(s)).join('/');
    const url = `${this.config.endpoint}/${this.config.bucket}/${encodedPath}`;
    
    try {
      new URL(url);
      return url;
    } catch (error) {
      throw new Error(`Failed to construct valid B2 URL for path "${path}"`);
    }
  }

  private async handleResponse(response: Response, operation: string): Promise<Response> {
    if (response.ok) {
      return response;
    }

    const contentType = response.headers.get('content-type') || '';
    let error: B2Error;

    try {
      if (contentType.includes('xml') || contentType.includes('text')) {
        const xml = await response.text();
        error = SimpleXMLParser.parseError(xml);
      } else if (contentType.includes('json')) {
        const json = await response.json();
        error = {
          code: json.code || 'ServerError',
          message: json.message || 'Server error occurred'
        };
      } else {
        const text = await response.text();
        error = {
          code: `HTTP_${response.status}`,
          message: text || response.statusText
        };
      }
    } catch {
      error = {
        code: `HTTP_${response.status}`,
        message: response.statusText
      };
    }

    const errorMessage = `[B2Workspace] ${operation} failed (${response.status}): ${error.message}`;
    console.error(errorMessage);
    throw new Error(errorMessage);
  }

  // =============================================================
  // Public API Methods with Retry Logic
  // =============================================================

  async write(
    path: string,
    content: string | Uint8Array,
    mimeType = 'application/octet-stream'
  ): Promise<void> {
    await RetryHelper.withRetry(async () => {
      const url = this.buildUrl(path);
      
      const response = await this.s3.fetch(url, {
        method: 'PUT',
        body: content,
        headers: {
          'Content-Type': mimeType
        }
      });

      await this.handleResponse(response, `write(${path})`);
      
      const etag = response.headers.get('etag')?.replace(/"/g, '');
      const size = typeof content === 'string' ? content.length : content.byteLength;
      console.log(`[B2Workspace] ✅ Wrote: ${path} (${size} bytes)${etag ? ` [ETag: ${etag}]` : ''}`);
    }, { maxAttempts: 3 });
  }

  async read(path: string): Promise<string> {
    return RetryHelper.withRetry(async () => {
      const url = this.buildUrl(path);
      
      const response = await this.s3.fetch(url, { method: 'GET' });

      if (response.status === 404) {
        throw new Error(`File not found: ${path}`);
      }

      await this.handleResponse(response, `read(${path})`);
      return await response.text();
    }, { maxAttempts: 3 });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return RetryHelper.withRetry(async () => {
      const url = this.buildUrl(path);
      
      const response = await this.s3.fetch(url, { method: 'GET' });

      if (response.status === 404) {
        throw new Error(`File not found: ${path}`);
      }

      await this.handleResponse(response, `readBytes(${path})`);
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    }, { maxAttempts: 3 });
  }

  async exists(path: string): Promise<'file' | 'directory' | false> {
    // Try as file first (HEAD request)
    try {
      const url = this.buildUrl(path);
      const response = await this.s3.fetch(url, { method: 'HEAD' });
      
      if (response.ok) {
        return 'file';
      }
    } catch {
      // Not a file
    }

    // Try as directory (list with prefix)
    try {
      const listing = await this.ls(path);
      if (listing.files.length > 0 || listing.directories.length > 0) {
        return 'directory';
      }
    } catch {
      // Not a directory
    }

    return false;
  }

  async unlink(path: string): Promise<void> {
    return RetryHelper.withRetry(async () => {
      const url = this.buildUrl(path);
      
      const response = await this.s3.fetch(url, { method: 'DELETE' });
      await this.handleResponse(response, `unlink(${path})`);
      
      console.log(`[B2Workspace] ✅ Deleted: ${path}`);
    }, { maxAttempts: 2 }); // Fewer retries for DELETE
  }

  async append(path: string, content: string): Promise<void> {
    let existing = '';
    
    try {
      existing = await this.read(path);
    } catch (error: any) {
      if (!error.message.includes('not found')) {
        throw error;
      }
    }
    
    await this.write(path, existing + content);
  }

  async mkdir(path: string): Promise<void> {
    if (!path.trim()) {
      throw new Error('Path cannot be empty');
    }

    return RetryHelper.withRetry(async () => {
      const dirPath = path.endsWith('/') ? path : `${path}/`;
      const url = this.buildUrl(dirPath);
      
      const response = await this.s3.fetch(url, {
        method: 'PUT',
        body: new Uint8Array(0),
        headers: {
          'Content-Length': '0',
          'Content-Type': 'application/x-directory'
        }
      });

      await this.handleResponse(response, `mkdir(${path})`);
      console.log(`[B2Workspace] ✅ Created directory: ${path}`);
    }, { maxAttempts: 3 });
  }

  async ls(path: string = ''): Promise<ListResult> {
    return RetryHelper.withRetry(async () => {
      const prefix = this.getFullPath(path);
      const prefixWithSlash = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
      
      const baseUrl = `${this.config.endpoint}/${this.config.bucket}`;
      const params = new URLSearchParams({
        'list-type': '2',
        'delimiter': '/',
        'prefix': prefixWithSlash,
        'max-keys': '1000' // B2 supports up to 1000
      });
      
      const url = `${baseUrl}?${params.toString()}`;
      
      const response = await this.s3.fetch(url, { method: 'GET' });
      await this.handleResponse(response, `ls(${path})`);
      
      const xml = await response.text();
      const parsed = SimpleXMLParser.parseListObjectsV2(xml);

      const directories: string[] = [];
      const files: Array<{ name: string; size: number; modified: Date; etag?: string }> = [];

      // Process common prefixes (directories)
      for (const prefix of parsed.commonPrefixes) {
        let dirName = prefix.slice(prefixWithSlash.length);
        if (dirName.endsWith('/')) {
          dirName = dirName.slice(0, -1);
        }
        if (dirName) {
          directories.push(dirName);
        }
      }

      // Process contents (files)
      for (const item of parsed.contents) {
        const fileName = item.key.slice(prefixWithSlash.length);
        
        if (fileName && !fileName.endsWith('/')) {
          files.push({
            name: fileName,
            size: item.size,
            modified: new Date(item.lastModified),
            etag: item.etag
          });
        }
      }

      console.log(`[B2Workspace] ✅ Listed: ${directories.length} dirs, ${files.length} files`);
      return { directories, files };
    }, { maxAttempts: 3 });
  }

  async rm(path: string): Promise<void> {
    if (!path.trim()) {
      throw new Error('Cannot delete workspace root');
    }

    const prefix = this.getFullPath(path);
    const prefixWithSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;

    console.log(`[B2Workspace] Recursively deleting: ${path}`);

    let continuationToken: string | undefined;
    const keysToDelete: string[] = [];

    // List all objects with prefix
    do {
      const baseUrl = `${this.config.endpoint}/${this.config.bucket}`;
      const params = new URLSearchParams({
        'list-type': '2',
        'prefix': prefixWithSlash
      });
      
      if (continuationToken) {
        params.set('continuation-token', continuationToken);
      }

      const listUrl = `${baseUrl}?${params.toString()}`;
      const response = await this.s3.fetch(listUrl, { method: 'GET' });
      await this.handleResponse(response, `rm-list(${path})`);

      const xml = await response.text();
      const parsed = SimpleXMLParser.parseListObjectsV2(xml);

      keysToDelete.push(...parsed.contents.map(c => c.key));
      
      if (!parsed.isTruncated) break;
      continuationToken = parsed.nextContinuationToken;
      
    } while (continuationToken);

    // Delete in batches
    const batchSize = 1000;
    for (let i = 0; i < keysToDelete.length; i += batchSize) {
      const batch = keysToDelete.slice(i, i + batchSize);
      await this.deleteBatch(batch);
    }

    console.log(`[B2Workspace] ✅ Deleted ${keysToDelete.length} objects from ${path}`);
  }

  private async deleteBatch(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const deleteXml = [
      '<Delete>',
      ...keys.map(key => `<Object><Key>${this.escapeXml(key)}</Key></Object>`),
      '<Quiet>true</Quiet>',
      '</Delete>'
    ].join('');

    const url = `${this.config.endpoint}/${this.config.bucket}?delete`;
    
    const response = await this.s3.fetch(url, {
      method: 'POST',
      body: deleteXml,
      headers: {
        'Content-Type': 'application/xml'
      }
    });

    await this.handleResponse(response, 'deleteBatch');
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async createDirectoryStructure(base: string, dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      await this.mkdir(`${base}/${dir}`);
    }
  }

  getConfig(): B2Config {
    return { ...this.config };
  }
}

// =============================================================
// Singleton Wrapper
// =============================================================

class WorkspaceClass {
  private static instance: WorkspaceImpl | null = null;

  static initialize(env: Env): void {
    if (!this.instance) {
      this.instance = new WorkspaceImpl(env);
      console.log('[B2Workspace] Singleton initialized');
    }
  }

  static isInitialized(): boolean {
    return this.instance !== null;
  }

  static async readdir(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.ls(path);
  }

  static async readFileText(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.read(path);
  }

  static async readFileBytes(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.readBytes(path);
  }

  static async writeFile(path: string, content: string | Uint8Array, mimeType?: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.write(path, content, mimeType);
  }

  static async appendFile(path: string, content: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.append(path, content);
  }

  static async unlink(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.unlink(path);
  }

  static async mkdir(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.mkdir(path);
  }

  static async exists(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.exists(path);
  }

  static async rm(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.rm(path);
  }

  static async createDirectoryStructure(base: string, dirs: string[]): Promise<void> {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.createDirectoryStructure(base, dirs);
  }

  static getConfig(): B2Config {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.getConfig();
  }
}

export const Workspace = WorkspaceClass;
export default WorkspaceClass;
