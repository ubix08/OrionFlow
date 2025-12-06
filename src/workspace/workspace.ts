// src/workspace/workspace.ts - Fixed B2 Workspace Implementation

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

/**
 * Production-Ready B2 Workspace - FIXED VERSION
 * 
 * Key Fixes:
 * 1. Virtual-hosted-style URLs (bucket.s3.region.backblazeb2.com)
 * 2. Correct AWS4 signing configuration
 * 3. Content-MD5 headers for PUT operations
 * 4. Proper error handling for B2-specific responses
 * 5. Fixed ListObjectsV2 parameter encoding
 */

// =============================================================
// Types
// =============================================================

interface B2Config {
  endpoint: string;     // Virtual-hosted endpoint
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
  }>;
}

interface B2Error {
  code: string;
  message: string;
  requestId?: string;
}

// =============================================================
// XML Parser
// =============================================================

class SimpleXMLParser {
  static parseListObjectsV2(xml: string): {
    contents: Array<{ key: string; size: number; lastModified: string }>;
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  } {
    const contents: Array<{ key: string; size: number; lastModified: string }> = [];
    const commonPrefixes: string[] = [];

    // Parse <Contents> elements
    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;
    
    while ((match = contentsRegex.exec(xml)) !== null) {
      const contentBlock = match[1];
      
      const keyMatch = /<Key>([^<]+)<\/Key>/.exec(contentBlock);
      const sizeMatch = /<Size>(\d+)<\/Size>/.exec(contentBlock);
      const lastModifiedMatch = /<LastModified>([^<]+)<\/LastModified>/.exec(contentBlock);
      
      if (keyMatch && sizeMatch && lastModifiedMatch) {
        contents.push({
          key: this.decodeXmlEntities(keyMatch[1]),
          size: parseInt(sizeMatch[1], 10),
          lastModified: lastModifiedMatch[1]
        });
      }
    }

    // Parse <CommonPrefixes>
    const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>([^<]+)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
    while ((match = prefixRegex.exec(xml)) !== null) {
      commonPrefixes.push(this.decodeXmlEntities(match[1]));
    }

    const isTruncatedMatch = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml);
    const isTruncated = isTruncatedMatch ? isTruncatedMatch[1] === 'true' : false;
    
    const nextTokenMatch = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
    const nextContinuationToken = nextTokenMatch ? this.decodeXmlEntities(nextTokenMatch[1]) : undefined;

    return { contents, commonPrefixes, isTruncated, nextContinuationToken };
  }

  static parseError(xml: string): B2Error {
    const codeMatch = /<Code>([^<]+)<\/Code>/.exec(xml);
    const messageMatch = /<Message>([^<]+)<\/Message>/.exec(xml);
    const requestIdMatch = /<RequestId>([^<]+)<\/RequestId>/.exec(xml);

    return {
      code: codeMatch ? codeMatch[1] : 'UnknownError',
      message: messageMatch ? this.decodeXmlEntities(messageMatch[1]) : 'Unknown error',
      requestId: requestIdMatch ? requestIdMatch[1] : undefined
    };
  }

  static decodeXmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  static encodeXmlEntities(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// =============================================================
// MD5 Hash (for Content-MD5)
// =============================================================

class MD5 {
  static async hash(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' 
      ? new TextEncoder().encode(data)
      : data;
    
    const hashBuffer = await crypto.subtle.digest('MD5', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < hashArray.length; i++) {
      binary += String.fromCharCode(hashArray[i]);
    }
    return btoa(binary);
  }
}

// =============================================================
// B2 Workspace Implementation
// =============================================================

class WorkspaceImpl {
  private s3: AwsClient;
  private config: B2Config;
  private virtualHostedEndpoint: string;

  constructor(env: Env) {
    // Parse endpoint to extract region
    const endpointUrl = env.B2_S3_ENDPOINT as string;
    const regionMatch = /s3\.([^.]+)\.backblazeb2\.com/.exec(endpointUrl);
    
    if (!regionMatch) {
      throw new Error(`Invalid B2 endpoint: ${endpointUrl}. Expected: https://s3.<region>.backblazeb2.com`);
    }

    const region = regionMatch[1];
    const bucket = env.B2_BUCKET as string;

    // Build virtual-hosted-style endpoint
    // Format: https://<bucket>.s3.<region>.backblazeb2.com
    this.virtualHostedEndpoint = `https://${bucket}.s3.${region}.backblazeb2.com`;

    this.config = {
      endpoint: this.virtualHostedEndpoint,
      region,
      bucket,
      basePath: this.normalizeBasePath(env.B2_BASE_PATH as string | undefined)
    };

    // Initialize AWS client with virtual-hosted endpoint
    this.s3 = new AwsClient({
      accessKeyId: env.B2_KEY_ID as string,
      secretAccessKey: env.B2_APPLICATION_KEY as string,
      service: 's3',
      region: this.config.region
    });

    console.log('[B2Workspace] Initialized:', {
      virtualHostedEndpoint: this.virtualHostedEndpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      basePath: this.config.basePath
    });
  }

  // -----------------------------------------------------------
  // Path Utilities
  // -----------------------------------------------------------

  private normalizeBasePath(path: string | undefined): string {
    if (!path || path.trim() === '') return '';
    const normalized = path.replace(/^\/+|\/+$/g, '');
    return normalized ? `${normalized}/` : '';
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

  private buildUrl(key: string): string {
    const fullKey = this.getFullPath(key);
    // Virtual-hosted-style: https://<bucket>.s3.<region>.backblazeb2.com/<key>
    return `${this.virtualHostedEndpoint}/${encodeURIComponent(fullKey).replace(/%2F/g, '/')}`;
  }

  // -----------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------

  private async handleResponse(response: Response, operation: string): Promise<Response> {
    if (response.ok) {
      return response;
    }

    let error: B2Error;
    const contentType = response.headers.get('content-type') || '';

    try {
      if (contentType.includes('xml') || contentType.includes('text')) {
        const xml = await response.text();
        error = SimpleXMLParser.parseError(xml);
      } else if (contentType.includes('json')) {
        const json = await response.json();
        error = {
          code: json.code || 'ServerError',
          message: json.message || 'Server error'
        };
      } else {
        const text = await response.text();
        error = {
          code: `HTTP_${response.status}`,
          message: text || response.statusText
        };
      }
    } catch (parseError) {
      error = {
        code: `HTTP_${response.status}`,
        message: response.statusText
      };
    }

    const errorMessage = `[B2Workspace] ${operation} failed (${response.status}): ${error.message}`;
    console.error(errorMessage, error.requestId ? `[RequestId: ${error.requestId}]` : '');
    
    throw new Error(errorMessage);
  }

  // -----------------------------------------------------------
  // Core Operations
  // -----------------------------------------------------------

  async write(
    path: string,
    content: string | Uint8Array,
    mimeType = 'application/octet-stream'
  ): Promise<void> {
    const url = this.buildUrl(path);
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    
    // Calculate Content-MD5 for data integrity
    const contentMD5 = await MD5.hash(body);
    
    const response = await this.s3.fetch(url, {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': mimeType,
        'Content-MD5': contentMD5,
        'Content-Length': body.length.toString()
      }
    });

    await this.handleResponse(response, `write(${path})`);
  }

  async read(path: string): Promise<string> {
    const url = this.buildUrl(path);
    
    const response = await this.s3.fetch(url, {
      method: 'GET'
    });

    if (response.status === 404) {
      throw new Error(`File not found: ${path}`);
    }

    await this.handleResponse(response, `read(${path})`);
    return await response.text();
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const url = this.buildUrl(path);
    
    const response = await this.s3.fetch(url, {
      method: 'GET'
    });

    if (response.status === 404) {
      throw new Error(`File not found: ${path}`);
    }

    await this.handleResponse(response, `readBytes(${path})`);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async exists(path: string): Promise<'file' | 'directory' | false> {
    // Check as file using HEAD
    try {
      const url = this.buildUrl(path);
      const response = await this.s3.fetch(url, { method: 'HEAD' });
      
      if (response.ok) {
        return 'file';
      }
    } catch (err) {
      console.debug(`[B2Workspace] exists check failed for ${path}:`, err);
    }

    // Check as directory
    try {
      const listing = await this.ls(path);
      if (listing.files.length > 0 || listing.directories.length > 0) {
        return 'directory';
      }
    } catch (err) {
      console.debug(`[B2Workspace] directory check failed for ${path}:`, err);
    }

    return false;
  }

  async unlink(path: string): Promise<void> {
    const url = this.buildUrl(path);
    
    const response = await this.s3.fetch(url, {
      method: 'DELETE'
    });

    // B2 returns 204 No Content on successful delete
    if (response.status === 204 || response.status === 200) {
      return;
    }

    await this.handleResponse(response, `unlink(${path})`);
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
    
    await this.write(path, existing + content, 'text/plain');
  }

  update = this.write;

  // -----------------------------------------------------------
  // Directory Operations
  // -----------------------------------------------------------

  async mkdir(path: string): Promise<void> {
    if (!path.trim()) {
      throw new Error('Path cannot be empty');
    }

    // Create directory marker (zero-byte object with trailing slash)
    const dirPath = path.endsWith('/') ? path : `${path}/`;
    const url = this.buildUrl(dirPath);
    
    const body = new Uint8Array(0);
    const contentMD5 = await MD5.hash(body);
    
    const response = await this.s3.fetch(url, {
      method: 'PUT',
      body,
      headers: {
        'Content-Length': '0',
        'Content-Type': 'application/x-directory',
        'Content-MD5': contentMD5
      }
    });

    await this.handleResponse(response, `mkdir(${path})`);
  }

  async ls(path: string = ''): Promise<ListResult> {
    const prefix = this.getFullPath(path);
    const prefixWithSlash = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
    
    // Build query parameters
    const params = new URLSearchParams({
      'list-type': '2',
      'delimiter': '/',
      'max-keys': '1000'
    });
    
    if (prefixWithSlash) {
      params.set('prefix', prefixWithSlash);
    }
    
    const url = `${this.virtualHostedEndpoint}?${params.toString()}`;
    
    const response = await this.s3.fetch(url, {
      method: 'GET'
    });

    await this.handleResponse(response, `ls(${path})`);
    
    const xml = await response.text();
    const parsed = SimpleXMLParser.parseListObjectsV2(xml);

    const directories: string[] = [];
    const files: Array<{ name: string; size: number; modified: Date }> = [];

    // Extract directory names
    for (const prefix of parsed.commonPrefixes) {
      let dirName = prefix.slice(prefixWithSlash.length);
      if (dirName.endsWith('/')) {
        dirName = dirName.slice(0, -1);
      }
      if (dirName && !dirName.includes('/')) {
        directories.push(dirName);
      }
    }

    // Extract file names
    for (const item of parsed.contents) {
      const fileName = item.key.slice(prefixWithSlash.length);
      
      // Skip directory markers, empty names, and nested paths
      if (fileName && !fileName.endsWith('/') && !fileName.includes('/')) {
        files.push({
          name: fileName,
          size: item.size,
          modified: new Date(item.lastModified)
        });
      }
    }

    return { directories, files };
  }

  async rm(path: string): Promise<void> {
    if (!path.trim()) {
      throw new Error('Cannot delete workspace root');
    }

    const prefix = this.getFullPath(path);
    const prefixWithSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;

    let continuationToken: string | undefined;
    const keysToDelete: string[] = [];

    // List all objects
    do {
      const params = new URLSearchParams({
        'list-type': '2',
        'prefix': prefixWithSlash,
        'max-keys': '1000'
      });
      
      if (continuationToken) {
        params.set('continuation-token', continuationToken);
      }

      const listUrl = `${this.virtualHostedEndpoint}?${params.toString()}`;
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

    console.log(`[B2Workspace] Deleted ${keysToDelete.length} objects from ${path}`);
  }

  private async deleteBatch(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const deleteXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Delete>',
      ...keys.map(key => `<Object><Key>${SimpleXMLParser.encodeXmlEntities(key)}</Key></Object>`),
      '<Quiet>true</Quiet>',
      '</Delete>'
    ].join('');

    const body = new TextEncoder().encode(deleteXml);
    const contentMD5 = await MD5.hash(body);
    
    const url = `${this.virtualHostedEndpoint}?delete`;
    
    const response = await this.s3.fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/xml',
        'Content-MD5': contentMD5
      }
    });

    await this.handleResponse(response, 'deleteBatch');
  }

  // -----------------------------------------------------------
  // Utility Methods
  // -----------------------------------------------------------

  async createDirectoryStructure(base: string, dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      const path = base ? `${base}/${dir}` : dir;
      await this.mkdir(path);
    }
  }

  getConfig(): B2Config {
    return { ...this.config };
  }
}

// =============================================================
// Singleton Wrapper
// =============================================================

class WorkspaceSingleton {
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

export { WorkspaceSingleton as Workspace };
export default WorkspaceSingleton;
