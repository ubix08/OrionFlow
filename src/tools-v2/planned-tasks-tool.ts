// src/tools-v2/planned-tasks-tool.ts - Task Management System

import { Workspace } from '../workspace/workspace';
import type {
  AdminTool,
  ToolResult,
  FunctionDeclaration,
  TodoStructure,
  TodoStep
} from './tool-types';

export class PlannedTasksTool implements AdminTool {
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'planned_tasks',
      description: 'Manage planned tasks with structured todo plans. Create new tasks, load existing tasks for continuation, update progress, or list all tasks.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['new_task', 'load_task', 'update_task', 'list_tasks'],
            description: 'Action to perform: new_task (create), load_task (load for continuation), update_task (update progress), list_tasks (list all)'
          },
          taskId: {
            type: 'string',
            description: 'Task ID (required for load_task and update_task)'
          },
          title: {
            type: 'string',
            description: 'Task title (required for new_task)'
          },
          description: {
            type: 'string',
            description: 'Task description (required for new_task)'
          },
          todo: {
            type: 'object',
            description: 'Todo structure with steps (required for new_task)'
          },
          stepNumber: {
            type: 'number',
            description: 'Step number to update (for update_task)'
          },
          stepStatus: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'skipped', 'failed'],
            description: 'New status for the step (for update_task)'
          },
          stepOutput: {
            type: 'string',
            description: 'Output/notes from step execution (for update_task)'
          }
        },
        required: ['action']
      }
    };
  }

  async execute(args: {
    action: 'new_task' | 'load_task' | 'update_task' | 'list_tasks';
    taskId?: string;
    title?: string;
    description?: string;
    todo?: Partial<TodoStructure>;
    stepNumber?: number;
    stepStatus?: TodoStep['status'];
    stepOutput?: string;
  }): Promise<ToolResult> {
    if (!Workspace.isInitialized()) {
      return {
        success: false,
        data: null,
        summary: 'Workspace not initialized. Cannot manage tasks.',
        metadata: { error: 'WORKSPACE_NOT_AVAILABLE' }
      };
    }

    try {
      switch (args.action) {
        case 'new_task':
          return await this.createNewTask(args);
        case 'load_task':
          return await this.loadTask(args);
        case 'update_task':
          return await this.updateTask(args);
        case 'list_tasks':
          return await this.listTasks();
        default:
          return {
            success: false,
            data: null,
            summary: `Unknown action: ${args.action}`
          };
      }
    } catch (error) {
      console.error('[PlannedTasks] Error:', error);
      return {
        success: false,
        data: null,
        summary: `Task operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: 'OPERATION_FAILED' }
      };
    }
  }

  // -----------------------------------------------------------
  // Create New Task
  // -----------------------------------------------------------

  private async createNewTask(args: {
    title?: string;
    description?: string;
    todo?: Partial<TodoStructure>;
  }): Promise<ToolResult> {
    if (!args.title || !args.description || !args.todo) {
      return {
        success: false,
        data: null,
        summary: 'Missing required fields: title, description, and todo are required'
      };
    }

    // Generate task ID and folder name
    const taskId = `task_${Date.now()}_${this.slugify(args.title)}`;
    const taskPath = `tasks/${taskId}`;

    // Create directory structure
    await Workspace.mkdir(taskPath);
    await Workspace.mkdir(`${taskPath}/artifacts`);
    await Workspace.mkdir(`${taskPath}/checkpoints`);

    // Create metadata
    const metadata = {
      taskId,
      title: args.title,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: args.todo.metadata?.tags || []
    };

    // Create todo structure
    const todo: TodoStructure = {
      taskId,
      title: args.title,
      description: args.description,
      status: 'pending',
      steps: args.todo.steps || [],
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: args.todo.metadata?.tags || []
      }
    };

    // Write files
    await Workspace.writeFile(`${taskPath}/description.md`, args.description);
    await Workspace.writeFile(`${taskPath}/metadata.json`, JSON.stringify(metadata, null, 2));
    await Workspace.writeFile(`${taskPath}/todo.json`, JSON.stringify(todo, null, 2));
    
    // Create human-readable plan
    const planMarkdown = this.generatePlanMarkdown(todo);
    await Workspace.writeFile(`${taskPath}/plan.md`, planMarkdown);

    console.log(`[PlannedTasks] Created task: ${taskId}`);

    return {
      success: true,
      data: {
        taskId,
        taskPath,
        todo,
        metadata
      },
      summary: `Created new task: ${args.title} (${taskId}) with ${todo.steps.length} steps`,
      metadata: {
        taskId,
        taskPath,
        stepCount: todo.steps.length
      }
    };
  }

  // -----------------------------------------------------------
  // Load Existing Task
  // -----------------------------------------------------------

  private async loadTask(args: {
    taskId?: string;
  }): Promise<ToolResult> {
    if (!args.taskId) {
      return {
        success: false,
        data: null,
        summary: 'taskId is required for load_task'
      };
    }

    // Find task folder (search by ID)
    const tasksDir = await Workspace.readdir('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId!));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;

    // Load task files
    const description = await Workspace.readFileText(`${taskPath}/description.md`);
    const metadataStr = await Workspace.readFileText(`${taskPath}/metadata.json`);
    const todoStr = await Workspace.readFileText(`${taskPath}/todo.json`);
    
    const metadata = JSON.parse(metadataStr);
    const todo: TodoStructure = JSON.parse(todoStr);

    // Load artifacts list
    const artifactsDir = await Workspace.readdir(`${taskPath}/artifacts`);
    const artifacts = artifactsDir.files.map(f => ({
      name: f.name,
      size: f.size,
      modified: f.modified
    }));

    console.log(`[PlannedTasks] Loaded task: ${args.taskId}`);

    return {
      success: true,
      data: {
        taskId: args.taskId,
        taskPath,
        description,
        metadata,
        todo,
        artifacts
      },
      summary: `Loaded task: ${metadata.title} (${todo.steps.length} steps, ${artifacts.length} artifacts)`,
      metadata: {
        taskId: args.taskId,
        stepCount: todo.steps.length,
        artifactCount: artifacts.length,
        status: todo.status
      }
    };
  }

  // -----------------------------------------------------------
  // Update Task Progress
  // -----------------------------------------------------------

  private async updateTask(args: {
    taskId?: string;
    stepNumber?: number;
    stepStatus?: TodoStep['status'];
    stepOutput?: string;
  }): Promise<ToolResult> {
    if (!args.taskId) {
      return {
        success: false,
        data: null,
        summary: 'taskId is required for update_task'
      };
    }

    // Find task folder
    const tasksDir = await Workspace.readdir('tasks');
    const taskFolder = tasksDir.directories.find(d => d.includes(args.taskId!));

    if (!taskFolder) {
      return {
        success: false,
        data: null,
        summary: `Task not found: ${args.taskId}`
      };
    }

    const taskPath = `tasks/${taskFolder}`;

    // Load current todo
    const todoStr = await Workspace.readFileText(`${taskPath}/todo.json`);
    const todo: TodoStructure = JSON.parse(todoStr);

    // Update step if specified
    if (args.stepNumber !== undefined) {
      const step = todo.steps.find(s => s.number === args.stepNumber);
      
      if (!step) {
        return {
          success: false,
          data: null,
          summary: `Step ${args.stepNumber} not found in task`
        };
      }

      // Update step status
      if (args.stepStatus) {
        step.status = args.stepStatus;
        
        if (args.stepStatus === 'in_progress' && !step.startedAt) {
          step.startedAt = Date.now();
        }
        if (['completed', 'skipped', 'failed'].includes(args.stepStatus)) {
          step.completedAt = Date.now();
        }
      }

      // Add notes/output
      if (args.stepOutput) {
        step.notes = args.stepOutput;
      }
    }

    // Update task status based on steps
    const allCompleted = todo.steps.every(s => 
      s.status === 'completed' || s.status === 'skipped'
    );
    const anyInProgress = todo.steps.some(s => s.status === 'in_progress');
    const anyFailed = todo.steps.some(s => s.status === 'failed');

    if (allCompleted) {
      todo.status = 'completed';
    } else if (anyFailed) {
      todo.status = 'failed';
    } else if (anyInProgress) {
      todo.status = 'in_progress';
    }

    // Update metadata
    todo.metadata.updatedAt = Date.now();

    // Save updated todo
    await Workspace.writeFile(`${taskPath}/todo.json`, JSON.stringify(todo, null, 2));

    // Update metadata file
    const metadataStr = await Workspace.readFileText(`${taskPath}/metadata.json`);
    const metadata = JSON.parse(metadataStr);
    metadata.status = todo.status;
    metadata.updatedAt = Date.now();
    await Workspace.writeFile(`${taskPath}/metadata.json`, JSON.stringify(metadata, null, 2));

    // Create checkpoint
    const checkpointPath = `${taskPath}/checkpoints/checkpoint_${Date.now()}.json`;
    await Workspace.writeFile(checkpointPath, JSON.stringify({
      timestamp: Date.now(),
      todo,
      stepNumber: args.stepNumber,
      action: 'update'
    }, null, 2));

    console.log(`[PlannedTasks] Updated task: ${args.taskId}, step ${args.stepNumber}`);

    return {
      success: true,
      data: {
        taskId: args.taskId,
        todo,
        updatedStep: args.stepNumber
      },
      summary: `Updated task ${args.taskId}: step ${args.stepNumber} -> ${args.stepStatus}`,
      metadata: {
        taskStatus: todo.status,
        stepNumber: args.stepNumber,
        checkpointCreated: true
      }
    };
  }

  // -----------------------------------------------------------
  // List All Tasks
  // -----------------------------------------------------------

  private async listTasks(): Promise<ToolResult> {
    const tasksDir = await Workspace.readdir('tasks');
    const tasks: any[] = [];

    for (const taskFolder of tasksDir.directories) {
      try {
        const metadataStr = await Workspace.readFileText(`tasks/${taskFolder}/metadata.json`);
        const metadata = JSON.parse(metadataStr);
        tasks.push(metadata);
      } catch (error) {
        console.warn(`[PlannedTasks] Failed to read task: ${taskFolder}`);
      }
    }

    // Sort by updatedAt descending
    tasks.sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      success: true,
      data: { tasks },
      summary: `Found ${tasks.length} tasks`,
      metadata: {
        totalTasks: tasks.length,
        byStatus: this.groupByStatus(tasks)
      }
    };
  }

  // -----------------------------------------------------------
  // Helper Methods
  // -----------------------------------------------------------

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }

  private generatePlanMarkdown(todo: TodoStructure): string {
    const lines = [
      `# ${todo.title}`,
      '',
      `**Status:** ${todo.status}`,
      `**Created:** ${new Date(todo.metadata.createdAt).toISOString()}`,
      '',
      `## Description`,
      todo.description,
      '',
      `## Steps`,
      ''
    ];

    for (const step of todo.steps) {
      lines.push(`### Step ${step.number}: ${step.title}`);
      lines.push(`**Worker:** ${step.workerType}`);
      lines.push(`**Status:** ${step.status}`);
      lines.push(`**Checkpoint:** ${step.checkpoint ? 'Yes' : 'No'}`);
      lines.push('');
      lines.push(`**Objective:** ${step.objective}`);
      lines.push('');
      
      if (step.requirements.length > 0) {
        lines.push('**Requirements:**');
        step.requirements.forEach(r => lines.push(`- ${r}`));
        lines.push('');
      }
      
      if (step.outputs.length > 0) {
        lines.push('**Expected Outputs:**');
        step.outputs.forEach(o => lines.push(`- ${o}`));
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private groupByStatus(tasks: any[]): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const task of tasks) {
      groups[task.status] = (groups[task.status] || 0) + 1;
    }
    return groups;
  }
}
