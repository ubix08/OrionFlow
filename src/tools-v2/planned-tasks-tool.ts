// src/tools-v2/planned-tasks-tool.ts - FULLY FIXED & COMPILABLE

import { Workspace } from '../workspace/workspace';
import type { AdminTool, ToolResult, FunctionDeclaration } from './tool-types';

// =============================================================
// Types
// =============================================================

export type TodoStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TodoStep {
  number: number;
  title: string;
  workerType: string;
  status: TodoStepStatus;
  checkpoint?: boolean;
  objective?: string;
  requirements?: string[];
  outputs?: string[];
  notes?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface TodoMetadata {
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}

export interface TodoStructure {
  taskId: string;
  title: string;
  description: string;
  status: TodoTaskStatus;
  steps: TodoStep[];
  metadata: TodoMetadata;
}

// =============================================================
// PlannedTasksTool Implementation
// =============================================================

export class PlannedTasksTool implements AdminTool {

  getDeclaration(): FunctionDeclaration {
    return {
      name: 'planned_tasks',
      description: 'Manage structured todo tasks: create, load, update, or list.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['new_task', 'load_task', 'update_task', 'list_tasks'], description: 'Action to perform on tasks' },
          taskId: { type: 'string', description: 'Task ID for load/update' },
          title: { type: 'string', description: 'Task title for new_task' },
          description: { type: 'string', description: 'Task description for new_task' },
          todo: { type: 'object', description: 'Todo structure with steps for new_task' },
          stepNumber: { type: 'number', description: 'Step number to update' },
          stepStatus: { type: 'string', enum: ['pending','in_progress','completed','skipped','failed'], description: 'Status for updating a step' },
          stepOutput: { type: 'string', description: 'Notes/output for step update' }
        },
        required: ['action']
      }
    };
  }

  async execute(args: { action: 'new_task'|'load_task'|'update_task'|'list_tasks'; taskId?: string; title?: string; description?: string; todo?: Partial<TodoStructure>; stepNumber?: number; stepStatus?: TodoStep['status']; stepOutput?: string }): Promise<ToolResult> {
    if (!Workspace.isInitialized()) {
      return {
        success: false,
        data: null,
        summary: 'Workspace not initialized. Task management requires B2 storage configuration.',
        metadata: { error: 'WORKSPACE_NOT_AVAILABLE', hint: 'Configure B2_KEY_ID, B2_APPLICATION_KEY, B2_S3_ENDPOINT, B2_BUCKET' }
      };
    }

    try {
      switch(args.action) {
        case 'new_task': return await this.createNewTask(args);
        case 'load_task': return await this.loadTask(args);
        case 'update_task': return await this.updateTask(args);
        case 'list_tasks': return await this.listTasks();
        default: return { success:false, data:null, summary:`Unknown action: ${args.action}` };
      }
    } catch(error) {
      console.error('[PlannedTasks] Error:', error);
      return {
        success:false,
        data:null,
        summary:`Task operation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata:{ error:'OPERATION_FAILED', errorDetails: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  // =============================================================
  // CREATE NEW TASK
  // =============================================================

  private async createNewTask(args: { title?: string; description?: string; todo?: Partial<TodoStructure>; }): Promise<ToolResult> {
    if (!args.title || !args.description || !args.todo?.steps || !Array.isArray(args.todo.steps)) {
      return { success:false, data:null, summary:'Missing required fields: title, description, todo.steps array required' };
    }

    const taskId = `task_${Date.now()}_${this.slugify(args.title)}`;
    const taskPath = `tasks/${taskId}`;

    await Workspace.mkdir(taskPath);
    await Workspace.mkdir(`${taskPath}/artifacts`);
    await Workspace.mkdir(`${taskPath}/checkpoints`);

    const steps: TodoStep[] = (args.todo.steps || []).map((step: Partial<TodoStep>, index: number) => ({
      number: index + 1,
      title: step.title ?? `Step ${index+1}`,
      workerType: step.workerType ?? 'agent',
      status: step.status ?? 'pending',
      checkpoint: step.checkpoint ?? false,
      objective: step.objective ?? '',
      requirements: step.requirements ?? [],
      outputs: step.outputs ?? [],
      notes: step.notes,
      startedAt: step.startedAt,
      completedAt: step.completedAt
    }));

    const todo: TodoStructure = {
      taskId,
      title: args.title,
      description: args.description,
      status: steps.length===0 ? 'completed' : 'pending',
      steps,
      metadata:{ createdAt: Date.now(), updatedAt: Date.now(), tags: args.todo.metadata?.tags ?? [] }
    };

    this.recomputeTaskStatus(todo);

    const metadata = { taskId, title: args.title, status: todo.status, createdAt: Date.now(), updatedAt: Date.now(), tags: args.todo.metadata?.tags ?? [] };

    await Workspace.writeFile(`${taskPath}/description.md`, args.description, 'text/markdown');
    await Workspace.writeFile(`${taskPath}/metadata.json`, JSON.stringify(metadata, null,2), 'application/json');
    await Workspace.writeFile(`${taskPath}/todo.json`, JSON.stringify(todo,null,2),'application/json');
    await Workspace.writeFile(`${taskPath}/plan.md`, this.generatePlanMarkdown(todo), 'text/markdown');

    return { success:true, data:{taskId, taskPath, todo, metadata, action:'new_task'}, summary:`Created new task: ${args.title} (${taskId}) with ${steps.length} steps`, metadata:{action:'new_task', taskId, stepCount: steps.length} };
  }

  // =============================================================
  // LOAD TASK
  // =============================================================

  private async loadTask(args:{taskId?:string}): Promise<ToolResult> {
    if (!args.taskId) return { success:false, data:null, summary:'taskId is required for load_task' };

    const tasksDir = await Workspace.readdir('tasks');
    const taskFolder = tasksDir.directories.find(d=>d.includes(args.taskId!));
    if (!taskFolder) return { success:false, data:null, summary:`Task not found: ${args.taskId}` };

    const taskPath = `tasks/${taskFolder}`;
    const description = await Workspace.readFileText(`${taskPath}/description.md`);
    const metadataStr = await Workspace.readFileText(`${taskPath}/metadata.json`);
    const todoStr = await Workspace.readFileText(`${taskPath}/todo.json`);

    const metadata = JSON.parse(metadataStr);
    let todo:TodoStructure = JSON.parse(todoStr);

    let modified=false;
    todo.steps = todo.steps.map((step:any, index:number)=>{
      const fixed={...step};
      if(fixed.number==null){ fixed.number=index+1; modified=true; }
      if(!fixed.status){ fixed.status='pending'; modified=true; }
      if(!fixed.workerType){ fixed.workerType='agent'; modified=true; }
      return fixed as TodoStep;
    });

    this.recomputeTaskStatus(todo);
    if(metadata.status!==todo.status){ metadata.status=todo.status; modified=true; }

    if(modified){
      todo.metadata.updatedAt=Date.now();
      metadata.updatedAt=Date.now();
      await Workspace.writeFile(`${taskPath}/todo.json`, JSON.stringify(todo,null,2),'application/json');
      await Workspace.writeFile(`${taskPath}/metadata.json`, JSON.stringify(metadata,null,2),'application/json');
    }

    const artifactsDir = await Workspace.readdir(`${taskPath}/artifacts`);
    const artifacts = artifactsDir.files.map(f=>({name:f.name,size:f.size,modified:f.modified}));

    return { success:true, data:{taskId:args.taskId, taskPath, description, metadata, todo, artifacts, action:'load_task'}, summary:`Loaded task: ${metadata.title} (${todo.steps.length} steps, ${artifacts.length} artifacts)`, metadata:{action:'load_task', taskId:args.taskId, stepCount:todo.steps.length, artifactCount:artifacts.length, status:todo.status, repaired:modified} };
  }

  // =============================================================
  // UPDATE TASK
  // =============================================================

  private async updateTask(args:{taskId?:string; stepNumber?:number; stepStatus?:TodoStep['status']; stepOutput?:string}): Promise<ToolResult> {
    if(!args.taskId) return {success:false, data:null, summary:'taskId required'};

    const tasksDir = await Workspace.readdir('tasks');
    const taskFolder = tasksDir.directories.find(d=>d.includes(args.taskId!));
    if(!taskFolder) return {success:false, data:null, summary:`Task not found: ${args.taskId}`};

    const taskPath = `tasks/${taskFolder}`;
    const todoStr = await Workspace.readFileText(`${taskPath}/todo.json`);
    const todo:TodoStructure = JSON.parse(todoStr);

    if(args.stepNumber!==undefined){
      const step = todo.steps.find(s=>s.number===args.stepNumber);
      if(!step) return {success:false, data:null, summary:`Step ${args.stepNumber} not found`};

      if(args.stepStatus){
        step.status=args.stepStatus;
        if(args.stepStatus==='in_progress'&&!step.startedAt) step.startedAt=Date.now();
        if(['completed','skipped','failed'].includes(args.stepStatus)) step.completedAt=Date.now();
      }

      if(args.stepOutput){
        step.notes = step.notes ? step.notes+'\n\n'+args.stepOutput : args.stepOutput;
      }
    }

    this.recomputeTaskStatus(todo);
    todo.metadata.updatedAt=Date.now();
    await Workspace.writeFile(`${taskPath}/todo.json`, JSON.stringify(todo,null,2),'application/json');

    const metadataStr = await Workspace.readFileText(`${taskPath}/metadata.json`);
    const metadata = JSON.parse(metadataStr);
    metadata.status=todo.status;
    metadata.updatedAt=Date.now();
    await Workspace.writeFile(`${taskPath}/metadata.json`, JSON.stringify(metadata,null,2),'application/json');

    const checkpointPath = `${taskPath}/checkpoints/checkpoint_${Date.now()}.json`;
    await Workspace.writeFile(checkpointPath, JSON.stringify({timestamp:Date.now(),todo,updatedStep:args.stepNumber??null,action:'update'},null,2),'application/json');

    return { success:true, data:{taskId:args.taskId,todo,updatedStep:args.stepNumber,action:'update_task'}, summary:`Updated task ${args.taskId} → ${todo.status}${args.stepNumber?`, step ${args.stepNumber} → ${args.stepStatus}`:''}`, metadata:{action:'update_task', taskStatus:todo.status} };
  }

  // =============================================================
  // LIST TASKS
  // =============================================================

  private async listTasks(): Promise<ToolResult> {
    const tasksDir = await Workspace.readdir('tasks');
    const tasks = await Promise.all(tasksDir.directories.map(async dir=>{
      const taskPath = `tasks/${dir}`;
      try{
        const metadataStr = await Workspace.readFileText(`${taskPath}/metadata.json`);
        const metadata = JSON.parse(metadataStr);
        return {taskId:dir,title:metadata.title,status:metadata.status,updatedAt:metadata.updatedAt};
      }catch{ return {taskId:dir,title:'(failed to read)',status:'pending',updatedAt:0}; }
    }));
    return {success:true,data:tasks,summary:`Listed ${tasks.length} tasks`,metadata:{count:tasks.length}};
  }

  // =============================================================
  // HELPERS
  // =============================================================

  private recomputeTaskStatus(todo:TodoStructure):void{
    if(!todo.steps.length){ todo.status='completed'; return; }
    const statuses=todo.steps.map(s=>s.status);
    if(statuses.every(s=>s==='completed'||s==='skipped')) todo.status='completed';
    else if(statuses.some(s=>s==='in_progress')) todo.status='in_progress';
    else if(statuses.some(s=>s==='failed')) todo.status='blocked';
    else todo.status='pending';
  }

  private slugify(text:string):string{
    return text.toLowerCase().replace(/\s+/g,'-').replace(/[^\w-]/g,'').replace(/--+/g,'-').replace(/^-+|-+$/g,'');
  }

  private generatePlanMarkdown(todo:TodoStructure):string{
    const lines=[`# Task Plan: ${todo.title}`, `\n${todo.description}\n`, '## Steps'];
    for(const step of todo.steps){
      lines.push(`- [${step.status==='completed'?'x':' '}] Step ${step.number}: ${step.title}`);
      if(step.objective) lines.push(`  - Objective: ${step.objective}`);
      if(step.requirements?.length) lines.push(`  - Requirements: ${step.requirements.join(', ')}`);
      if(step.outputs?.length) lines.push(`  - Outputs: ${step.outputs.join(', ')}`);
      if(step.notes) lines.push(`  - Notes: ${step.notes}`);
    }
    return lines.join('\n');
  }
}
