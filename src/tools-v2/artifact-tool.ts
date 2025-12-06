// src/tools-v2/artifact-tool.ts - Artifact Lifecycle Management

import { Workspace } from '../workspace/workspace';
import type {
  AdminTool,
  ToolResult,
  FunctionDeclaration,
  ArtifactReference
} from './tool-types';

export class ArtifactTool implements AdminTool {
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'artifact_tool',
      description: 'Manage task artifacts: write new artifacts from worker outputs, load existing artifacts, or delete artifacts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'load', 'delete', 'list'],
            description: 'Action: write (save artifact), load (read artifact), delete (remove artifact), list (list all artifacts for task)'
          },
          taskId: {
            type: 'string',
            description: 'Task ID that owns the artifact'
          },
          artifactId: {
            type: 'string',
            description: 'Unique artifact identifier (for load/delete)'
          },
          stepNumber: {
            type: 'number',
            description: 'Step number that generated the artifact (for write)'
          },
          type: {
            type: 'string',
            enum: ['code', 'research', 'analysis', 'content', 'data', 'report'],
            description: 'Type of artifact (for write)'
          },
          title: {
            type: 'string',
            description: 'Human-readable title (for write)'
          },
          content: {
            type: 'string',
            description: 'Artifact content (for write)'
          },
          format: {
            type: 'string',
            description: 'File format/extension (e.g., md, json, py, txt)'
          }
        },
        required: ['action', 'taskId']
      }
    };
  }

  async execute(args: {
    action: 'write' | 'load' | 'delete' | 'list';
    taskId: string;
    artifactId?: string;
    stepNumber?: number;
    type?: string;
    title?: string;
    content?: string;
    format?: string;
  }): Promise<ToolResult> {
    if (!Workspace.isInitialized()) {
      return {
        success: false,
        data: null,
        summary: 'Workspace not initialized. Cannot manage artifacts.',
        metadata: { error: 'WORKSPACE_NOT_AVAILABLE' }
      };
    }

    try {
      switch (args.action) {
        case 'write':
          return await this.writeArtifact(args);
        case 'load':
          return await this.loadArtifact(args);
        case 'delete':
          return await this.deleteArtifact(args);
        case 'list':
          return await this.listArtifacts(args);
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${args.action}`
          };
      }
    } catch (error) {
      console.error('[ArtifactTool] Error:', error);
      return {
        success: false,
        data: null,
        summary: `Artifact operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: 'OPERATION_FAILED' }
      };
    }
  }

  // -----------------------------------------------------------
  // Write Artifact
  // -----------------------------------------------------------

  private async writeArtifact(args: {
    taskId: string;
    stepNumber?: number;
    type?: string;
    title?: string;
    content?: string;
    format?: string;
  }): Promise<ToolResult> {
    if (!args.content || !args.title || !args.type) {
      return {
        success: false,
        data: null,
        summary: 'Missing required fields: content, title, and type are required for write'
      };
    }

    // Find task folder
    const taskFolder = await this.findTaskFolder(args.taskId);
    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;

    // Generate artifact ID and filename
    const artifactId = `artifact_${Date.now()}_${this.slugify(args.title)}`;
    const format = args.format || this.inferFormat(args.type);
    const filename = `${artifactId}.${format}`;
    const artifactPath = `${taskPath}/artifacts/${filename}`;

    // Create artifact metadata
    const metadata: ArtifactReference = {
      artifactId,
      taskId: args.taskId,
      stepNumber: args.stepNumber || 0,
      path: artifactPath,
      type: args.type,
      title: args.title,
      createdAt: Date.now()
    };

    // Write artifact content
    await Workspace.writeFile(artifactPath, args.content);

    // Write artifact metadata
    const metadataPath = `${taskPath}/artifacts/${artifactId}.meta.json`;
    await Workspace.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    console.log(`[ArtifactTool] Wrote artifact: ${artifactId} to ${taskPath}`);

    return {
      success: true,
      data: {
        artifactId,
        path: artifactPath,
        metadata
      },
      summary: `Saved artifact: ${args.title} (${artifactId})`,
      metadata: {
        artifactId,
        taskId: args.taskId,
        stepNumber: args.stepNumber,
        type: args.type
      }
    };
  }

  // -----------------------------------------------------------
  // Load Artifact
  // -----------------------------------------------------------

  private async loadArtifact(args: {
    taskId: string;
    artifactId?: string;
  }): Promise<ToolResult> {
    if (!args.artifactId) {
      return {
        success: false,
        data: null,
        summary: 'artifactId is required for load'
      };
    }

    // Find task folder
    const taskFolder = await this.findTaskFolder(args.taskId);
    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;

    // Load metadata
    const metadataPath = `${taskPath}/artifacts/${args.artifactId}.meta.json`;
    const metadataExists = await Workspace.exists(metadataPath);
    
    if (!metadataExists) {
      return {
        success: false,
        data: null,
        summary: `Artifact not found: ${args.artifactId}`
      };
    }

    const metadataStr = await Workspace.readFileText(metadataPath);
    const metadata: ArtifactReference = JSON.parse(metadataStr);

    // Load content
    const content = await Workspace.readFileText(metadata.path);

    console.log(`[ArtifactTool] Loaded artifact: ${args.artifactId}`);

    return {
      success: true,
      data: {
        metadata,
        content
      },
      summary: `Loaded artifact: ${metadata.title}`,
      metadata: {
        artifactId: args.artifactId,
        taskId: args.taskId,
        type: metadata.type
      }
    };
  }

  // -----------------------------------------------------------
  // Delete Artifact
  // -----------------------------------------------------------

  private async deleteArtifact(args: {
    taskId: string;
    artifactId?: string;
  }): Promise<ToolResult> {
    if (!args.artifactId) {
      return {
        success: false,
        data: null,
        summary: 'artifactId is required for delete'
      };
    }

    // Find task folder
    const taskFolder = await this.findTaskFolder(args.taskId);
    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;

    // Load metadata to get file path
    const metadataPath = `${taskPath}/artifacts/${args.artifactId}.meta.json`;
    const metadataExists = await Workspace.exists(metadataPath);
    
    if (!metadataExists) {
      return {
        success: false,
        data: null,
        summary: `Artifact not found: ${args.artifactId}`
      };
    }

    const metadataStr = await Workspace.readFileText(metadataPath);
    const metadata: ArtifactReference = JSON.parse(metadataStr);

    // Delete artifact content
    await Workspace.unlink(metadata.path);

    // Delete metadata
    await Workspace.unlink(metadataPath);

    console.log(`[ArtifactTool] Deleted artifact: ${args.artifactId}`);

    return {
      success: true,
      data: { artifactId: args.artifactId },
      summary: `Deleted artifact: ${metadata.title}`,
      metadata: {
        artifactId: args.artifactId,
        taskId: args.taskId
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
    const taskFolder = await this.findTaskFolder(args.taskId);
    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;
    const artifactsDir = await Workspace.readdir(`${taskPath}/artifacts`);

    // Load metadata for each artifact
    const artifacts: ArtifactReference[] = [];
    
    for (const file of artifactsDir.files) {
      if (file.name.endsWith('.meta.json')) {
        try {
          const metadataStr = await Workspace.readFileText(`${taskPath}/artifacts/${file.name}`);
          const metadata: ArtifactReference = JSON.parse(metadataStr);
          artifacts.push(metadata);
        } catch (error) {
          console.warn(`[ArtifactTool] Failed to load artifact metadata: ${file.name}`);
        }
      }
    }

    // Sort by creation time
    artifacts.sort((a, b) => b.createdAt - a.createdAt);

    return {
      success: true,
      data: { artifacts },
      summary: `Found ${artifacts.length} artifacts in task ${args.taskId}`,
      metadata: {
        taskId: args.taskId,
        count: artifacts.length,
        byType: this.groupByType(artifacts)
      }
    };
  }

  // -----------------------------------------------------------
  // Helper Methods
  // -----------------------------------------------------------

  private async findTaskFolder(taskId: string): Promise<string | null> {
    try {
      const tasksDir = await Workspace.readdir('tasks');
      const folder = tasksDir.directories.find(d => d.includes(taskId));
      return folder || null;
    } catch (error) {
      return null;
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }

  private inferFormat(type: string): string {
    const formatMap: Record<string, string> = {
      code: 'py',
      research: 'md',
      analysis: 'json',
      content: 'md',
      data: 'json',
      report: 'md'
    };
    return formatMap[type] || 'txt';
  }

  private groupByType(artifacts: ArtifactReference[]): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const artifact of artifacts) {
      groups[artifact.type] = (groups[artifact.type] || 0) + 1;
    }
    return groups;
  }
}o
