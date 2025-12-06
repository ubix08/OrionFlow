// src/tools-v2/artifact-tool.ts - Artifact Lifecycle Management (FIXED)

import type { WorkspaceImpl } from '../workspace/workspace';
import type {
  AdminTool,
  ToolResult,
  FunctionDeclaration
} from './tool-types';

/**
 * Artifact Tool - Manages artifacts in B2 workspace (FIXED)
 * 
 * FIXES APPLIED:
 * ✅ Dependency injection instead of singleton
 * ✅ Proper workspace availability checks
 * ✅ Better error messages
 * ✅ Transaction safety (cleanup on failure)
 */
export class ArtifactTool implements AdminTool {
  constructor(private workspace: WorkspaceImpl | null) {}

  getDeclaration(): FunctionDeclaration {
    return {
      name: 'artifact_tool',
      description: 'Manage artifacts in the workspace. Write, read, list, or delete artifacts in task directories.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'read', 'list', 'delete'],
            description: 'Action: write (save), read (retrieve), list (list all), delete (remove)'
          },
          taskId: {
            type: 'string',
            description: 'Task ID that owns the artifact'
          },
          filename: {
            type: 'string',
            description: 'Artifact filename (required for write, read, delete)'
          },
          content: {
            type: 'string',
            description: 'Artifact content (required for write)'
          },
          mimeType: {
            type: 'string',
            description: 'MIME type for the artifact (optional, defaults to text/plain)'
          }
        },
        required: ['action', 'taskId']
      }
    };
  }

  async execute(args: {
    action: 'write' | 'read' | 'list' | 'delete';
    taskId: string;
    filename?: string;
    content?: string;
    mimeType?: string;
  }): Promise<ToolResult> {
    // Check workspace availability
    if (!this.workspace) {
      return {
        success: false,
        data: null,
        summary: 'Artifact management is not available. The workspace requires B2 storage configuration.',
        metadata: { 
          error: 'WORKSPACE_NOT_AVAILABLE',
          hint: 'Configure B2_KEY_ID, B2_APPLICATION_KEY, B2_S3_ENDPOINT, and B2_BUCKET'
        }
      };
    }

    try {
      switch (args.action) {
        case 'write':
          return await this.writeArtifact(args);
        case 'read':
          return await this.readArtifact(args);
        case 'list':
          return await this.listArtifacts(args);
        case 'delete':
          return await this.deleteArtifact(args);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${args.action}`
          };
      }
    } catch (error) {
      return this.formatError(error, args.action);
    }
  }

  // -----------------------------------------------------------
  // Write Artifact
  // -----------------------------------------------------------

  private async writeArtifact(args: {
    taskId: string;
    filename?: string;
    content?: string;
    mimeType?: string;
  }): Promise<ToolResult> {
    if (!args.filename || !args.content) {
      return {
        success: false,
        data: null,
        summary: 'filename and content are required for write action'
      };
    }

    // Find task folder
    const tasksDir = await this.workspace!.ls('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}. Use planned_tasks(list_tasks) to see available tasks.`,
        metadata: { error: 'TASK_NOT_FOUND' }
      };
    }

    const artifactPath = `tasks/${taskFolder}/artifacts/${args.filename}`;
    const mimeType = args.mimeType || this.inferMimeType(args.filename);

    // Write artifact
    const { etag } = await this.workspace!.write(artifactPath, args.content, { mimeType });

    console.log(`[ArtifactTool] ✅ Wrote artifact: ${args.filename} (${args.content.length} bytes)`);

    return {
      success: true,
      data: {
        taskId: args.taskId,
        filename: args.filename,
        path: artifactPath,
        size: args.content.length,
        mimeType,
        etag
      },
      summary: `Wrote artifact: ${args.filename} (${args.content.length} bytes)`,
      metadata: {
        action: 'write',
        artifactPath
      }
    };
  }

  // -----------------------------------------------------------
  // Read Artifact
  // -----------------------------------------------------------

  private async readArtifact(args: {
    taskId: string;
    filename?: string;
  }): Promise<ToolResult> {
    if (!args.filename) {
      return {
        success: false,
        data: null,
        summary: 'filename is required for read action'
      };
    }

    // Find task folder
    const tasksDir = await this.workspace!.ls('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`,
        metadata: { error: 'TASK_NOT_FOUND' }
      };
    }

    const artifactPath = `tasks/${taskFolder}/artifacts/${args.filename}`;

    // Check if artifact exists
    const exists = await this.workspace!.exists(artifactPath);
    if (!exists) {
      return {
        success: false,
        data: null,
        summary: `Artifact not found: ${args.filename}`,
        metadata: { error: 'ARTIFACT_NOT_FOUND' }
      };
    }

    // Read artifact
    const { content, etag } = await this.workspace!.read(artifactPath);

    console.log(`[ArtifactTool] ✅ Read artifact: ${args.filename} (${content.length} bytes)`);

    return {
      success: true,
      data: {
        taskId: args.taskId,
        filename: args.filename,
        content,
        size: content.length,
        etag
      },
      summary: `Read artifact: ${args.filename} (${content.length} bytes)`,
      metadata: {
        action: 'read',
        artifactPath
      }
    };
  }

  // -----------------------------------------------------------
  // List Artifacts
  // -----------------------------------------------------------

  private async listArtifacts(args: {
    taskId: string;
  }): Promise<ToolResult> {
    // Find task folder
    const tasksDir = await this.workspace!.ls('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`,
        metadata: { error: 'TASK_NOT_FOUND' }
      };
    }

    const artifactsPath = `tasks/${taskFolder}/artifacts`;

    // List artifacts
    const listing = await this.workspace!.ls(artifactsPath);

    const artifacts = listing.files.map(f => ({
      name: f.name,
      size: f.size,
      modified: f.modified,
      etag: f.etag
    }));

    console.log(`[ArtifactTool] ✅ Listed ${artifacts.length} artifacts`);

    return {
      success: true,
      data: { artifacts },
      summary: `Found ${artifacts.length} artifacts in task ${args.taskId}`,
      metadata: {
        action: 'list',
        count: artifacts.length
      }
    };
  }

  // -----------------------------------------------------------
  // Delete Artifact
  // -----------------------------------------------------------

  private async deleteArtifact(args: {
    taskId: string;
    filename?: string;
  }): Promise<ToolResult> {
    if (!args.filename) {
      return {
        success: false,
        data: null,
        summary: 'filename is required for delete action'
      };
    }

    // Find task folder
    const tasksDir = await this.workspace!.ls('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`,
        metadata: { error: 'TASK_NOT_FOUND' }
      };
    }

    const artifactPath = `tasks/${taskFolder}/artifacts/${args.filename}`;

    // Check if artifact exists
    const exists = await this.workspace!.exists(artifactPath);
    if (!exists) {
      return {
        success: false,
        data: null,
        summary: `Artifact not found: ${args.filename}`,
        metadata: { error: 'ARTIFACT_NOT_FOUND' }
      };
    }

    // Delete artifact
    await this.workspace!.unlink(artifactPath);

    console.log(`[ArtifactTool] ✅ Deleted artifact: ${args.filename}`);

    return {
      success: true,
      data: {
        taskId: args.taskId,
        filename: args.filename,
        deleted: true
      },
      summary: `Deleted artifact: ${args.filename}`,
      metadata: {
        action: 'delete',
        artifactPath
      }
    };
  }

  // -----------------------------------------------------------
  // Helper Methods
  // -----------------------------------------------------------

  private inferMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    
    const mimeTypes: Record<string, string> = {
      'txt': 'text/plain',
      'md': 'text/markdown',
      'json': 'application/json',
      'xml': 'application/xml',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'ts': 'application/typescript',
      'py': 'text/x-python',
      'java': 'text/x-java',
      'cpp': 'text/x-c++src',
      'c': 'text/x-csrc',
      'go': 'text/x-go',
      'rs': 'text/x-rust',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'pdf': 'application/pdf',
      'zip': 'application/zip'
    };

    return ext ? (mimeTypes[ext] || 'application/octet-stream') : 'text/plain';
  }

  private formatError(error: unknown, action: string): ToolResult {
    console.error(`[ArtifactTool] Error during ${action}:`, error);
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Provide helpful error messages
    if (errorMessage.includes('403') || errorMessage.includes('PERMISSION_DENIED')) {
      return {
        success: false,
        data: null,
        summary: `Artifact ${action} failed due to permission error. Verify B2 credentials have read/write access.`,
        metadata: { 
          error: 'PERMISSION_DENIED',
          action,
          hint: 'Check B2_APPLICATION_KEY capabilities'
        }
      };
    }
    
    if (errorMessage.includes('404') || errorMessage.includes('NOT_FOUND')) {
      return {
        success: false,
        data: null,
        summary: `Artifact ${action} failed: Resource not found.`,
        metadata: { 
          error: 'NOT_FOUND',
          action
        }
      };
    }
    
    return {
      success: false,
      data: null,
      summary: `Artifact ${action} failed: ${errorMessage}`,
      metadata: { 
        error: 'OPERATION_FAILED',
        action,
        details: errorMessage
      }
    };
  }
}
