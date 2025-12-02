// src/tools/project-tool.ts - Session-Agnostic Project Management

import { Workspace } from '../workspace/workspace';
import type { D1Manager } from '../storage/d1-manager';
import type { ProjectMetadata, TodoDocument, ProjectFilters, WorkflowPlan } from '../types';

export class ProjectTool {
  private d1: D1Manager;
  private projectsBasePath = 'projects';

  constructor(d1: D1Manager) {
    this.d1 = d1;
  }

  // =============================================================
  // Discovery & Search
  // =============================================================

  async listProjects(filters: ProjectFilters = {}): Promise<ProjectMetadata[]> {
    return await this.d1.listProjects(filters);
  }

  async getProject(projectId: string): Promise<ProjectMetadata> {
    const meta = await this.d1.getProject(projectId);
    if (!meta) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return meta;
  }

  async getRecentProjects(userId: string, limit = 5): Promise<ProjectMetadata[]> {
    return await this.d1.listProjects({ limit });
  }

  async getUnfinishedProjects(userId: string): Promise<ProjectMetadata[]> {
    return await this.d1.listProjects({
      status: 'active',
    });
  }

  async searchProjects(query: string, userId: string, limit = 10): Promise<ProjectMetadata[]> {
    // Use D1 text search (basic implementation)
    return await this.d1.searchProjects(query, limit);
  }

  // =============================================================
  // Project Lifecycle
  // =============================================================

  async createProject(spec: {
    objective: string;
    workflowPlan: WorkflowPlan;
    createdBy: string;
  }): Promise<string> {
    if (!Workspace.isInitialized()) {
      throw new Error('Workspace not initialized');
    }

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const projectPath = `${this.projectsBasePath}/${projectId}`;

    try {
      console.log(`[ProjectTool] Creating project: ${projectId}`);

      // 1. Create directory structure in B2
      await Workspace.createDirectoryStructure(projectPath, [
        'data',
        'results',
        'artifacts',
      ]);

      // 2. Create metadata
      const metadata: ProjectMetadata = {
        projectId,
        createdBy: spec.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        
        title: spec.workflowPlan.workflowTitle,
        objective: spec.objective,
        domain: this.extractDomain(spec.workflowPlan),
        tags: this.extractTags(spec.objective),
        
        status: 'active',
        currentStep: 1,
        totalSteps: spec.workflowPlan.adaptedSteps.length,
        
        workflowId: spec.workflowPlan.workflowId,
        
        sessions: [],
      };

      // 3. Save metadata to D1
      await this.d1.createProject(metadata);

      // 4. Create todo.md
      const todo = this.createTodoFromPlan(projectId, spec.objective, spec.workflowPlan);
      await this.saveTodoDocument(projectId, todo);

      // 5. Create README
      await Workspace.writeFile(
        `${projectPath}/README.md`,
        this.generateReadme(metadata, spec.workflowPlan)
      );

      // 6. Save metadata.json
      await Workspace.writeFile(
        `${projectPath}/.meta.json`,
        JSON.stringify(metadata, null, 2)
      );

      console.log(`[ProjectTool] ✅ Project created: ${projectId}`);
      return projectId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Project creation failed: ${msg}`);
    }
  }

  async loadProject(projectId: string): Promise<{
    metadata: ProjectMetadata;
    todo: TodoDocument;
    files: string[];
  }> {
    // Load metadata from D1
    const metadata = await this.getProject(projectId);

    // Load todo from B2
    const todo = await this.loadTodoDocument(projectId);
    if (!todo) {
      throw new Error(`Todo document not found for project: ${projectId}`);
    }

    // List files
    const projectPath = this.getProjectPath(projectId);
    const listing = await Workspace.readdir(projectPath);
    const files = listing.files.map(f => f.name);

    return { metadata, todo, files };
  }

  // =============================================================
  // Project State Management
  // =============================================================

  async updateProjectStatus(
    projectId: string,
    status: ProjectMetadata['status'],
    updates?: Partial<ProjectMetadata>
  ): Promise<void> {
    const current = await this.getProject(projectId);
    
    await this.d1.updateProject(projectId, {
      status,
      version: current.version + 1,
      updatedAt: Date.now(),
      ...updates,
    });

    // Update metadata file in B2
    const projectPath = this.getProjectPath(projectId);
    const metadata = await this.getProject(projectId);
    await Workspace.writeFile(
      `${projectPath}/.meta.json`,
      JSON.stringify(metadata, null, 2)
    );
  }

  async saveCheckpoint(projectId: string, data: {
    stepNumber: number;
    result: any;
    timestamp: number;
  }): Promise<void> {
    await this.d1.updateProject(projectId, {
      lastCheckpoint: data.stepNumber,
      checkpointData: data,
      updatedAt: Date.now(),
    });

    // Save checkpoint data to B2
    const projectPath = this.getProjectPath(projectId);
    await Workspace.writeFile(
      `${projectPath}/.checkpoint.json`,
      JSON.stringify(data, null, 2)
    );
  }

  async recordSession(
    projectId: string,
    sessionId: string,
    action: 'created' | 'resumed' | 'continued' | 'completed' | 'failed'
  ): Promise<void> {
    await this.d1.recordProjectSession(projectId, sessionId, action);
  }

  async incrementStep(projectId: string): Promise<void> {
    const current = await this.getProject(projectId);
    await this.d1.updateProject(projectId, {
      currentStep: current.currentStep + 1,
      version: current.version + 1,
      updatedAt: Date.now(),
    });
  }

  // =============================================================
  // File Operations
  // =============================================================

  async readProjectFile(projectId: string, path: string): Promise<string> {
    const projectPath = this.getProjectPath(projectId);
    return await Workspace.readFileText(`${projectPath}/${path}`);
  }

  async writeProjectFile(projectId: string, path: string, content: string): Promise<void> {
    const projectPath = this.getProjectPath(projectId);
    await Workspace.writeFile(`${projectPath}/${path}`, content);
    
    // Update timestamp
    await this.d1.updateProject(projectId, {
      updatedAt: Date.now(),
    });
  }

  async appendProjectFile(projectId: string, path: string, content: string): Promise<void> {
    const projectPath = this.getProjectPath(projectId);
    await Workspace.appendFile(`${projectPath}/${path}`, content);
    
    // Update timestamp
    await this.d1.updateProject(projectId, {
      updatedAt: Date.now(),
    });
  }

  async listProjectFiles(projectId: string, dir = ''): Promise<string[]> {
    const projectPath = this.getProjectPath(projectId);
    const fullPath = dir ? `${projectPath}/${dir}` : projectPath;
    const listing = await Workspace.readdir(fullPath);
    return listing.files.map(f => f.name);
  }

  // =============================================================
  // Todo Document Management
  // =============================================================

  async loadTodoDocument(projectId: string): Promise<TodoDocument | null> {
    try {
      const projectPath = this.getProjectPath(projectId);
      const content = await Workspace.readFileText(`${projectPath}/todo.md`);
      return this.parseTodoMarkdown(content);
    } catch (e) {
      console.error(`[ProjectTool] Failed to load todo for ${projectId}:`, e);
      return null;
    }
  }

  async saveTodoDocument(projectId: string, todo: TodoDocument): Promise<void> {
    const projectPath = this.getProjectPath(projectId);
    const markdown = this.generateTodoMarkdown(todo);
    await Workspace.writeFile(`${projectPath}/todo.md`, markdown);
    
    // Update D1 with current step
    const currentStep = todo.steps.find(s => s.status === 'in_progress' || s.status === 'pending');
    if (currentStep) {
      await this.d1.updateProject(projectId, {
        currentStep: currentStep.number,
        updatedAt: Date.now(),
      });
    }
  }

  async updateStepStatus(
    projectId: string,
    stepNumber: number,
    status: 'pending' | 'in_progress' | 'completed' | 'skipped',
    notes?: string
  ): Promise<void> {
    const todo = await this.loadTodoDocument(projectId);
    if (!todo) throw new Error('Todo document not found');

    const step = todo.steps.find(s => s.number === stepNumber);
    if (!step) throw new Error(`Step ${stepNumber} not found`);

    step.status = status;
    if (notes) step.notes = notes;

    if (status === 'in_progress' && !step.startedAt) {
      step.startedAt = Date.now();
    }
    if (status === 'completed' && !step.completedAt) {
      step.completedAt = Date.now();
    }

    todo.updatedAt = Date.now();
    await this.saveTodoDocument(projectId, todo);
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private getProjectPath(projectId: string): string {
    return `${this.projectsBasePath}/${projectId}`;
  }

  private extractDomain(plan: WorkflowPlan): string {
    // Simple domain extraction from workflow ID or title
    const id = plan.workflowId.toLowerCase();
    if (id.includes('marketing')) return 'Marketing';
    if (id.includes('research')) return 'Research';
    if (id.includes('content')) return 'Content Creation';
    if (id.includes('development')) return 'Development';
    return 'General';
  }

  private extractTags(objective: string): string[] {
    const tags: string[] = [];
    const lower = objective.toLowerCase();
    
    if (lower.includes('campaign')) tags.push('campaign');
    if (lower.includes('research')) tags.push('research');
    if (lower.includes('analysis')) tags.push('analysis');
    if (lower.includes('content')) tags.push('content');
    if (lower.includes('strategy')) tags.push('strategy');
    
    return tags;
  }

  private createTodoFromPlan(
    projectId: string,
    objective: string,
    plan: WorkflowPlan
  ): TodoDocument {
    return {
      objective,
      projectId,
      workflowId: plan.workflowId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: plan.adaptedSteps.map(step => ({
        number: step.number,
        title: step.title,
        description: step.objective,
        status: 'pending' as const,
        checkpoint: step.checkpoint,
        outputs: step.outputs,
        agentId: step.agentId,
        agentConfig: {
          objective: step.objective,
          requirements: step.requirements,
          outputFormat: 'markdown',
        },
        dependencies: step.dependencies,
      })),
    };
  }

  private generateTodoMarkdown(todo: TodoDocument): string {
    const lines: string[] = [];

    lines.push(`# ${todo.objective}`);
    lines.push('');
    lines.push(`**Project ID**: \`${todo.projectId}\``);
    if (todo.workflowId) lines.push(`**Workflow**: ${todo.workflowId}`);
    lines.push(`**Created**: ${new Date(todo.createdAt).toISOString()}`);
    lines.push(`**Updated**: ${new Date(todo.updatedAt).toISOString()}`);
    lines.push('');

    const completed = todo.steps.filter(s => s.status === 'completed').length;
    const total = todo.steps.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    lines.push('## Progress');
    lines.push('');
    lines.push(`- ✅ Completed: ${completed}/${total}`);
    lines.push(`- 📊 Overall: ${percentage}%`);
    lines.push('');

    lines.push('## Steps');
    lines.push('');

    for (const step of todo.steps) {
      const icon = step.status === 'completed' ? '✅'
                 : step.status === 'in_progress' ? '🔄'
                 : step.status === 'skipped' ? '⏭️'
                 : '⏸️';

      const checkpoint = step.checkpoint ? ' 🚦 **CHECKPOINT**' : '';
      const agent = step.agentId ? ` 🤖 Agent: \`${step.agentId}\`` : '';

      lines.push(`### ${icon} Step ${step.number}: ${step.title}${checkpoint}${agent}`);
      lines.push('');
      lines.push(step.description);
      lines.push('');
      lines.push(`**Status**: ${step.status}`);
      lines.push('');

      if (step.outputs.length > 0) {
        lines.push(`**Expected Outputs**: ${step.outputs.join(', ')}`);
        lines.push('');
      }

      if (step.notes) {
        lines.push(`**Notes**: ${step.notes}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private parseTodoMarkdown(markdown: string): TodoDocument | null {
    try {
      const titleMatch = markdown.match(/^# (.+)/m);
      const objective = titleMatch ? titleMatch[1].trim() : 'Unknown';

      const projectIdMatch = markdown.match(/\*\*Project ID\*\*:\s*`([^`]+)`/);
      const projectId = projectIdMatch ? projectIdMatch[1].trim() : '';

      const workflowIdMatch = markdown.match(/\*\*Workflow\*\*:\s*(.+)/);
      const workflowId = workflowIdMatch ? workflowIdMatch[1].trim() : undefined;

      const createdMatch = markdown.match(/\*\*Created\*\*:\s*(.+)/);
      const updatedMatch = markdown.match(/\*\*Updated\*\*:\s*(.+)/);
      const createdAt = createdMatch ? new Date(createdMatch[1].trim()).getTime() : Date.now();
      const updatedAt = updatedMatch ? new Date(updatedMatch[1].trim()).getTime() : Date.now();

      const steps: TodoDocument['steps'] = [];
      const stepRegex = /### [^\s]+ Step (\d+):\s*([^\n🚦🤖]+)(?:🚦\s*\*\*CHECKPOINT\*\*)?(?:🤖\s*Agent:\s*`([^`]+)`)?[\s\S]*?\n\*\*Status\*\*:\s*(\w+)/g;
      let match;

      while ((match = stepRegex.exec(markdown)) !== null) {
        const number = parseInt(match[1], 10);
        const title = match[2].trim();
        const agentId = match[3]?.trim();
        const status = match[4] as TodoDocument['steps'][0]['status'];

        const stepStart = match.index;
        const nextMatch = /### [^\s]+ Step \d+:/.exec(markdown.slice(stepStart + 1));
        const stepEnd = nextMatch ? stepStart + 1 + nextMatch.index : markdown.length;
        const stepContent = markdown.slice(stepStart, stepEnd);

        const descMatch = stepContent.match(/###[^\n]+\n\n([^\n]+)/);
        const description = descMatch ? descMatch[1].trim() : title;

        const outputsMatch = stepContent.match(/\*\*Expected Outputs\*\*:\s*([^\n]+)/);
        const outputs = outputsMatch
          ? outputsMatch[1].split(',').map(o => o.trim())
          : [];

        const notesMatch = stepContent.match(/\*\*Notes\*\*:\s*([^\n]+)/);
        const notes = notesMatch ? notesMatch[1].trim() : undefined;

        const checkpoint = stepContent.includes('🚦');

        steps.push({
          number,
          title,
          description,
          status,
          checkpoint,
          outputs,
          notes,
          agentId,
        });
      }

      return {
        objective,
        projectId,
        workflowId,
        createdAt,
        updatedAt,
        steps,
      };
    } catch (e) {
      console.error('[ProjectTool] Failed to parse todo:', e);
      return null;
    }
  }

  private generateReadme(metadata: ProjectMetadata, plan: WorkflowPlan): string {
    return `# ${metadata.title}

**Project ID**: \`${metadata.projectId}\`
**Workflow**: ${plan.workflowTitle}
**Status**: ${metadata.status}

## Objective
${metadata.objective}

## Project Structure

- \`todo.md\` - Execution plan with steps and checkpoints
- \`.meta.json\` - Project metadata
- \`data/\` - Raw data, research, intermediate files
- \`results/\` - Final deliverables
- \`artifacts/\` - Code, visualizations, analysis

## Steps Overview

${plan.adaptedSteps.map((s, i) => `${i + 1}. ${s.title} ${s.checkpoint ? '🚦' : ''}`).join('\n')}

## Progress

Current: Step ${metadata.currentStep}/${metadata.totalSteps}

See \`todo.md\` for detailed progress.

---
*Generated by ORION Multi-Agent System*
*Created: ${new Date(metadata.createdAt).toISOString()}*
`;
  }
}

export default ProjectTool;
