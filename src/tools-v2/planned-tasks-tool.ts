// src/tools-v2/planned-tasks-tool.ts - Fixed with Workspace Availability Check

import type { AdminTool, ToolResult } from './tool-types';
import { Workspace } from '../workspace/workspace';

interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  steps: Array<{
    id: string;
    description: string;
    workerType: string;
    status: 'pending' | 'completed' | 'skipped';
    dependencies?: string[];
    artifacts?: string[];
  }>;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, any>;
}

/**
 * Planned Tasks Tool - Fixed with Workspace Availability
 * 
 * Manages structured task execution with persistent storage.
 * Now properly handles workspace availability.
 */
export class PlannedTasksTool implements AdminTool {
  name = 'planned_tasks';
  description = `Manage structured, multi-step tasks with persistent storage.
  
Actions:
- new_task: Create a new task with steps
- load_task: Load existing task by ID
- update_task: Update task progress/status
- list_tasks: List all tasks
- delete_task: Delete a task

Creates todo.json files in tasks/<task-id>/ directory.`;

  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['new_task', 'load_task', 'update_task', 'list_tasks', 'delete_task'],
        description: 'Action to perform'
      },
      task_id: {
        type: 'string',
        description: 'Task ID (required for load, update, delete)'
      },
      title: {
        type: 'string',
        description: 'Task title (required for new_task)'
      },
      description: {
        type: 'string',
        description: 'Task description (optional for new_task)'
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            workerType: { 
              type: 'string',
              enum: ['researcher', 'coder', 'writer', 'analyst', 'designer']
            },
            dependencies: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['description', 'workerType']
        },
        description: 'Task steps (required for new_task)'
      },
      updates: {
        type: 'object',
        description: 'Updates to apply (for update_task)'
      }
    },
    required: ['action']
  };

  private workspaceEnabled: boolean;

  constructor(workspaceEnabled: boolean = false) {
    this.workspaceEnabled = workspaceEnabled;
  }

  async execute(args: any): Promise<ToolResult> {
    const action = args.action;

    // First check: Is workspace configured?
    if (!this.workspaceEnabled) {
      return {
        success: false,
        summary: 'Task management requires B2 workspace configuration. Please set B2_KEY_ID, B2_APPLICATION_KEY, B2_S3_ENDPOINT, and B2_BUCKET environment variables.',
        data: null,
        metadata: { 
          errorCode: 'WORKSPACE_NOT_CONFIGURED',
          reason: 'B2 environment variables not set',
          required: [
            'B2_KEY_ID',
            'B2_APPLICATION_KEY', 
            'B2_S3_ENDPOINT',
            'B2_BUCKET'
          ]
        }
      };
    }

    // Second check: Is workspace actually initialized?
    if (!Workspace.isInitialized()) {
      return {
        success: false,
        summary: 'Workspace initialization failed. Check B2 credentials and endpoint configuration.',
        data: null,
        metadata: { 
          errorCode: 'WORKSPACE_NOT_INITIALIZED',
          reason: 'Workspace.initialize() failed or was not called',
          hint: 'Verify B2 endpoint format: https://s3.<region>.backblazeb2.com'
        }
      };
    }

    // Execute action
    try {
      switch (action) {
        case 'new_task':
          return await this.createNewTask(args);
        case 'load_task':
          return await this.loadTask(args);
        case 'update_task':
          return await this.updateTask(args);
        case 'list_tasks':
          return await this.listTasks();
        case 'delete_task':
          return await this.deleteTask(args);
        default:
          return {
            success: false,
            summary: `Unknown action: ${action}`,
            data: null,
            metadata: { errorCode: 'UNKNOWN_ACTION' }
          };
      }
    } catch (error) {
      console.error('[PlannedTasksTool] Error:', error);
      
      return {
        success: false,
        summary: `Task operation failed: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_OPERATION_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  // =============================================================
  // Task Operations
  // =============================================================

  private async createNewTask(args: any): Promise<ToolResult> {
    const { title, description, steps } = args;

    if (!title || !steps || !Array.isArray(steps) || steps.length === 0) {
      return {
        success: false,
        summary: 'Missing required fields: title and steps',
        data: null,
        metadata: { errorCode: 'INVALID_PARAMETERS' }
      };
    }

    // Generate task ID
    const taskId = this.generateTaskId(title);
    const taskDir = `tasks/${taskId}`;

    // Create task object
    const task: Task = {
      id: taskId,
      title,
      description: description || '',
      status: 'pending',
      steps: steps.map((step: any, index: number) => ({
        id: `step_${index + 1}`,
        description: step.description,
        workerType: step.workerType,
        status: 'pending',
        dependencies: step.dependencies || [],
        artifacts: []
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {}
    };

    try {
      // Create task directory structure
      await Workspace.mkdir(taskDir);
      await Workspace.mkdir(`${taskDir}/artifacts`);
      await Workspace.mkdir(`${taskDir}/context`);

      // Write todo.json
      await Workspace.writeFile(
        `${taskDir}/todo.json`,
        JSON.stringify(task, null, 2),
        'application/json'
      );

      // Write README
      const readme = this.generateTaskReadme(task);
      await Workspace.writeFile(
        `${taskDir}/README.md`,
        readme,
        'text/markdown'
      );

      console.log(`[PlannedTasksTool] Created task: ${taskId}`);

      return {
        success: true,
        summary: `Created task "${title}" with ${steps.length} steps`,
        data: {
          taskId,
          taskPath: taskDir,
          task
        },
        metadata: {
          action: 'new_task',
          taskId,
          stepCount: steps.length
        }
      };
    } catch (error) {
      console.error('[PlannedTasksTool] Failed to create task:', error);
      
      return {
        success: false,
        summary: `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_CREATION_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async loadTask(args: any): Promise<ToolResult> {
    const { task_id } = args;

    if (!task_id) {
      return {
        success: false,
        summary: 'Missing required field: task_id',
        data: null,
        metadata: { errorCode: 'INVALID_PARAMETERS' }
      };
    }

    try {
      const taskPath = `tasks/${task_id}/todo.json`;
      const exists = await Workspace.exists(taskPath);

      if (!exists) {
        return {
          success: false,
          summary: `Task not found: ${task_id}`,
          data: null,
          metadata: { errorCode: 'TASK_NOT_FOUND' }
        };
      }

      const content = await Workspace.readFileText(taskPath);
      const task: Task = JSON.parse(content);

      return {
        success: true,
        summary: `Loaded task "${task.title}"`,
        data: {
          task,
          taskPath: `tasks/${task_id}`
        },
        metadata: {
          action: 'load_task',
          taskId: task_id
        }
      };
    } catch (error) {
      console.error('[PlannedTasksTool] Failed to load task:', error);
      
      return {
        success: false,
        summary: `Failed to load task: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_LOAD_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async updateTask(args: any): Promise<ToolResult> {
    const { task_id, updates } = args;

    if (!task_id || !updates) {
      return {
        success: false,
        summary: 'Missing required fields: task_id and updates',
        data: null,
        metadata: { errorCode: 'INVALID_PARAMETERS' }
      };
    }

    try {
      const taskPath = `tasks/${task_id}/todo.json`;
      const content = await Workspace.readFileText(taskPath);
      const task: Task = JSON.parse(content);

      // Apply updates
      if (updates.status) task.status = updates.status;
      if (updates.steps) {
        updates.steps.forEach((stepUpdate: any) => {
          const step = task.steps.find(s => s.id === stepUpdate.id);
          if (step) {
            Object.assign(step, stepUpdate);
          }
        });
      }

      task.updatedAt = Date.now();

      // Save updated task
      await Workspace.writeFile(
        taskPath,
        JSON.stringify(task, null, 2),
        'application/json'
      );

      return {
        success: true,
        summary: `Updated task "${task.title}"`,
        data: {
          task,
          taskPath: `tasks/${task_id}`
        },
        metadata: {
          action: 'update_task',
          taskId: task_id,
          taskStatus: task.status
        }
      };
    } catch (error) {
      console.error('[PlannedTasksTool] Failed to update task:', error);
      
      return {
        success: false,
        summary: `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_UPDATE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async listTasks(): Promise<ToolResult> {
    try {
      const tasksDir = 'tasks';
      const listing = await Workspace.readdir(tasksDir);
      
      const tasks: Array<{ id: string; title: string; status: string; stepCount: number }> = [];

      for (const dir of listing.directories) {
        try {
          const todoPath = `${tasksDir}/${dir}/todo.json`;
          const content = await Workspace.readFileText(todoPath);
          const task: Task = JSON.parse(content);
          
          tasks.push({
            id: task.id,
            title: task.title,
            status: task.status,
            stepCount: task.steps.length
          });
        } catch (err) {
          console.warn(`[PlannedTasksTool] Failed to load task ${dir}:`, err);
        }
      }

      return {
        success: true,
        summary: `Found ${tasks.length} tasks`,
        data: { tasks },
        metadata: {
          action: 'list_tasks',
          taskCount: tasks.length
        }
      };
    } catch (error) {
      console.error('[PlannedTasksTool] Failed to list tasks:', error);
      
      return {
        success: false,
        summary: `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_LIST_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private async deleteTask(args: any): Promise<ToolResult> {
    const { task_id } = args;

    if (!task_id) {
      return {
        success: false,
        summary: 'Missing required field: task_id',
        data: null,
        metadata: { errorCode: 'INVALID_PARAMETERS' }
      };
    }

    try {
      const taskDir = `tasks/${task_id}`;
      
      // Note: Workspace.rm is a recursive delete
      await Workspace.rm(taskDir);

      return {
        success: true,
        summary: `Deleted task: ${task_id}`,
        data: { taskId: task_id },
        metadata: {
          action: 'delete_task',
          taskId: task_id
        }
      };
    } catch (error) {
      console.error('[PlannedTasksTool] Failed to delete task:', error);
      
      return {
        success: false,
        summary: `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TASK_DELETE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private generateTaskId(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    
    const timestamp = Date.now().toString(36);
    return `${slug}-${timestamp}`;
  }

  private generateTaskReadme(task: Task): string {
    return `# ${task.title}

${task.description}

## Status
${task.status.toUpperCase()}

## Steps
${task.steps.map((step, i) => `${i + 1}. [${step.status.toUpperCase()}] ${step.description} (${step.workerType})`).join('\n')}

## Created
${new Date(task.createdAt).toISOString()}

## Last Updated
${new Date(task.updatedAt).toISOString()}
`;
  }
}

export default PlannedTasksTool;
