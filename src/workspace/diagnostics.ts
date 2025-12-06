// src/workspace/diagnostics.ts - B2 Workspace Diagnostic Tool

import { Workspace } from './workspace';
import type { Env } from '../types';

export interface DiagnosticResult {
  category: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  details?: any;
}

export class WorkspaceDiagnostics {
  private results: DiagnosticResult[] = [];
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async runAll(): Promise<{
    success: boolean;
    results: DiagnosticResult[];
    summary: string;
  }> {
    console.log('[Diagnostics] Starting B2 Workspace diagnostics...');
    
    this.results = [];
    
    await this.testEnvironmentVariables();
    await this.testInitialization();
    
    if (Workspace.isInitialized()) {
      await this.testBasicOperations();
      await this.testDirectoryOperations();
      await this.testFileOperations();
      await this.testErrorHandling();
    }
    
    const failCount = this.results.filter(r => r.status === 'fail').length;
    const warnCount = this.results.filter(r => r.status === 'warning').length;
    const passCount = this.results.filter(r => r.status === 'pass').length;
    
    const success = failCount === 0;
    const summary = `${passCount} passed, ${warnCount} warnings, ${failCount} failed`;
    
    console.log(`[Diagnostics] Complete: ${summary}`);
    
    return { success, results: this.results, summary };
  }

  private async testEnvironmentVariables(): Promise<void> {
    const required = [
      'B2_KEY_ID',
      'B2_APPLICATION_KEY',
      'B2_S3_ENDPOINT',
      'B2_BUCKET'
    ];

    for (const key of required) {
      const value = this.env[key as keyof Env];
      
      if (!value) {
        this.results.push({
          category: 'Environment',
          status: 'fail',
          message: `Missing required variable: ${key}`
        });
      } else {
        this.results.push({
          category: 'Environment',
          status: 'pass',
          message: `${key} is set`,
          details: { length: String(value).length }
        });
      }
    }

    const basePath = this.env.B2_BASE_PATH;
    this.results.push({
      category: 'Environment',
      status: basePath ? 'pass' : 'warning',
      message: `B2_BASE_PATH: ${basePath || 'not set (using root)'}`,
      details: { value: basePath }
    });

    const endpoint = this.env.B2_S3_ENDPOINT as string;
    if (endpoint) {
      const validFormat = /^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com\/?$/i.test(endpoint);
      
      this.results.push({
        category: 'Environment',
        status: validFormat ? 'pass' : 'fail',
        message: `Endpoint format: ${validFormat ? 'valid' : 'invalid'}`,
        details: {
          endpoint,
          expectedFormat: 'https://s3.<region>.backblazeb2.com'
        }
      });
    }
  }

  private async testInitialization(): Promise<void> {
    try {
      Workspace.initialize(this.env);
      
      if (Workspace.isInitialized()) {
        this.results.push({
          category: 'Initialization',
          status: 'pass',
          message: 'Workspace initialized successfully'
        });
        
        const config = Workspace.getConfig();
        this.results.push({
          category: 'Initialization',
          status: 'pass',
          message: 'Configuration retrieved',
          details: {
            endpoint: config.endpoint,
            bucket: config.bucket,
            region: config.region,
            basePath: config.basePath || '(root)'
          }
        });
      } else {
        this.results.push({
          category: 'Initialization',
          status: 'fail',
          message: 'Workspace.isInitialized() returned false'
        });
      }
    } catch (error) {
      this.results.push({
        category: 'Initialization',
        status: 'fail',
        message: 'Initialization threw error',
        details: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      });
    }
  }

  private async testBasicOperations(): Promise<void> {
    const testFile = `_diagnostic_test_${Date.now()}.txt`;
    const testContent = 'B2 Workspace Diagnostic Test';

    try {
      await Workspace.writeFile(testFile, testContent);
      this.results.push({
        category: 'Basic Operations',
        status: 'pass',
        message: 'Write operation successful'
      });

      const exists = await Workspace.exists(testFile);
      this.results.push({
        category: 'Basic Operations',
        status: exists === 'file' ? 'pass' : 'fail',
        message: `Exists check: ${exists || 'not found'}`
      });

      const content = await Workspace.readFileText(testFile);
      const contentMatches = content === testContent;
      this.results.push({
        category: 'Basic Operations',
        status: contentMatches ? 'pass' : 'fail',
        message: `Read operation: ${contentMatches ? 'content matches' : 'content mismatch'}`,
        details: { expected: testContent, actual: content }
      });

      await Workspace.unlink(testFile);
      const stillExists = await Workspace.exists(testFile);
      this.results.push({
        category: 'Basic Operations',
        status: !stillExists ? 'pass' : 'fail',
        message: `Delete operation: ${!stillExists ? 'file removed' : 'file still exists'}`
      });

    } catch (error) {
      this.results.push({
        category: 'Basic Operations',
        status: 'fail',
        message: 'Basic operations failed',
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async testDirectoryOperations(): Promise<void> {
    const testDir = `_diagnostic_dir_${Date.now()}`;

    try {
      await Workspace.mkdir(testDir);
      this.results.push({
        category: 'Directory Operations',
        status: 'pass',
        message: 'Directory creation successful'
      });

      const listing1 = await Workspace.readdir(testDir);
      this.results.push({
        category: 'Directory Operations',
        status: listing1.files.length === 0 ? 'pass' : 'warning',
        message: `List empty directory: ${listing1.files.length} files, ${listing1.directories.length} dirs`
      });

      await Workspace.writeFile(`${testDir}/test.txt`, 'test content');
      
      const listing2 = await Workspace.readdir(testDir);
      const hasFile = listing2.files.some(f => f.name === 'test.txt');
      this.results.push({
        category: 'Directory Operations',
        status: hasFile ? 'pass' : 'fail',
        message: `List directory with file: ${hasFile ? 'file found' : 'file not found'}`,
        details: { files: listing2.files.map(f => f.name) }
      });

      await Workspace.mkdir(`${testDir}/subdir`);
      const listing3 = await Workspace.readdir(testDir);
      const hasSubdir = listing3.directories.includes('subdir');
      this.results.push({
        category: 'Directory Operations',
        status: hasSubdir ? 'pass' : 'fail',
        message: `Nested directories: ${hasSubdir ? 'subdir found' : 'subdir not found'}`
      });

      await Workspace.unlink(`${testDir}/test.txt`);
      await Workspace.unlink(`${testDir}/subdir/`);
      await Workspace.unlink(`${testDir}/`);

    } catch (error) {
      this.results.push({
        category: 'Directory Operations',
        status: 'fail',
        message: 'Directory operations failed',
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async testFileOperations(): Promise<void> {
    const testFile = `_diagnostic_file_ops_${Date.now()}.txt`;

    try {
      await Workspace.appendFile(testFile, 'Line 1\n');
      const content1 = await Workspace.readFileText(testFile);
      this.results.push({
        category: 'File Operations',
        status: content1 === 'Line 1\n' ? 'pass' : 'fail',
        message: 'Append to new file',
        details: { content: content1 }
      });

      await Workspace.appendFile(testFile, 'Line 2\n');
      const content2 = await Workspace.readFileText(testFile);
      this.results.push({
        category: 'File Operations',
        status: content2 === 'Line 1\nLine 2\n' ? 'pass' : 'fail',
        message: 'Append to existing file',
        details: { content: content2 }
      });

      const binaryData = new Uint8Array([0, 1, 2, 255, 254, 253]);
      await Workspace.writeFile(`${testFile}.bin`, binaryData);
      const readBinary = await Workspace.readFileBytes(`${testFile}.bin`);
      const binaryMatches = readBinary.length === binaryData.length &&
        readBinary.every((v, i) => v === binaryData[i]);
      
      this.results.push({
        category: 'File Operations',
        status: binaryMatches ? 'pass' : 'fail',
        message: 'Binary file operations',
        details: {
          written: Array.from(binaryData),
          read: Array.from(readBinary)
        }
      });

      await Workspace.unlink(testFile);
      await Workspace.unlink(`${testFile}.bin`);

    } catch (error) {
      this.results.push({
        category: 'File Operations',
        status: 'fail',
        message: 'File operations failed',
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async testErrorHandling(): Promise<void> {
    try {
      try {
        await Workspace.readFileText('_nonexistent_file_12345.txt');
        this.results.push({
          category: 'Error Handling',
          status: 'fail',
          message: 'Reading non-existent file should throw error'
        });
      } catch (error) {
        const isNotFoundError = error instanceof Error && 
          error.message.includes('not found');
        this.results.push({
          category: 'Error Handling',
          status: isNotFoundError ? 'pass' : 'warning',
          message: 'Non-existent file error handling',
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }

      try {
        await Workspace.writeFile('../../../etc/passwd', 'test');
        this.results.push({
          category: 'Error Handling',
          status: 'warning',
          message: 'Path traversal attempt did not throw error (check sanitization)'
        });
      } catch (error) {
        this.results.push({
          category: 'Error Handling',
          status: 'pass',
          message: 'Path traversal protection working'
        });
      }

    } catch (error) {
      this.results.push({
        category: 'Error Handling',
        status: 'fail',
        message: 'Error handling test failed',
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  printReport(): string {
    const lines: string[] = [];
    lines.push('');
    lines.push('═'.repeat(80));
    lines.push('  B2 WORKSPACE DIAGNOSTIC REPORT');
    lines.push('═'.repeat(80));
    lines.push('');

    const categories = [...new Set(this.results.map(r => r.category))];
    
    for (const category of categories) {
      lines.push(`▸ ${category}`);
      lines.push('─'.repeat(80));
      
      const categoryResults = this.results.filter(r => r.category === category);
      
      for (const result of categoryResults) {
        const icon = result.status === 'pass' ? '✓' : 
                     result.status === 'fail' ? '✗' : '⚠';
        
        lines.push(`  ${icon} ${result.message}`);
        
        if (result.details) {
          lines.push(`    Details: ${JSON.stringify(result.details, null, 2)}`);
        }
      }
      
      lines.push('');
    }

    const failCount = this.results.filter(r => r.status === 'fail').length;
    const warnCount = this.results.filter(r => r.status === 'warning').length;
    const passCount = this.results.filter(r => r.status === 'pass').length;

    lines.push('═'.repeat(80));
    lines.push(`  SUMMARY: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);
    lines.push('═'.repeat(80));
    lines.push('');

    return lines.join('\n');
  }
}

export async function runWorkspaceDiagnostics(env: Env): Promise<void> {
  const diagnostics = new WorkspaceDiagnostics(env);
  const result = await diagnostics.runAll();
  
  console.log(diagnostics.printReport());
  
  if (!result.success) {
    console.error('[Diagnostics] ❌ Workspace has issues. See report above.');
  } else {
    console.log('[Diagnostics] ✅ All tests passed!');
  }
}
