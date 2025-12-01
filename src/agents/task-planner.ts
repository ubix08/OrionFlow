// src/agents/task-planner.ts - Enhanced Task Planning Agent

import type { GeminiClient } from '../gemini';
import type { AgentRegistry } from './agent-wrapper';
import type { EnhancedWorkflowManager } from '../workflow/workflow-manager-enhanced';
import type { WorkflowTemplate } from '../types';

// =============================================================
// Task Planner Types
// =============================================================

export interface TaskAnalysis {
  objective: string;
  domain: string;
  complexity: 'Simple' | 'Medium' | 'Complex';
  estimatedSteps: number;
  requiredCapabilities: string[];
  suggestedApproach: string;
}

export interface WorkflowPlan {
  workflowId: string;
  workflowTitle: string;
  adaptedSteps: AdaptedStep[];
  estimatedTime: string;
  rationale: string;
}

export interface AdaptedStep {
  number: number;
  title: string;
  agentId: string;
  agentName: string;
  objective: string;
  requirements: string[];
  dependencies: Array<{ stepNumber: number; outputPath: string }>;
  outputs: string[];
  checkpoint: boolean;
}

// =============================================================
// Task Planner Agent
// =============================================================

export class TaskPlannerAgent {
  private gemini: GeminiClient;
  private agentRegistry: AgentRegistry;
  private workflowManager: EnhancedWorkflowManager;

  constructor(
    gemini: GeminiClient,
    agentRegistry: AgentRegistry,
    workflowManager: EnhancedWorkflowManager
  ) {
    this.gemini = gemini;
    this.agentRegistry = agentRegistry;
    this.workflowManager = workflowManager;
  }

  // -----------------------------------------------------------
  // Main Planning Flow
  // -----------------------------------------------------------

  async createWorkflowPlan(
    userObjective: string,
    userContext?: Record<string, string>
  ): Promise<{
    analysis: TaskAnalysis;
    recommendedWorkflows: WorkflowTemplate[];
    plan?: WorkflowPlan;
  }> {
    console.log('[TaskPlanner] Analyzing objective:', userObjective);

    // Step 1: Analyze the objective
    const analysis = await this.analyzeObjective(userObjective);
    console.log('[TaskPlanner] Analysis:', analysis);

    // Step 2: Search for relevant workflow templates
    const workflows = await this.workflowManager.searchTemplates(
      `${analysis.domain} ${userObjective}`,
      3
    );
    console.log(`[TaskPlanner] Found ${workflows.length} matching workflows`);

    // If no workflows found or task is simple, suggest direct execution
    if (workflows.length === 0 || analysis.complexity === 'Simple') {
      return {
        analysis,
        recommendedWorkflows: workflows,
      };
    }

    // Step 3: Select best workflow
    const selectedWorkflow = workflows[0]; // Use top match for now

    // Step 4: Adapt workflow with agent assignments
    const plan = await this.adaptWorkflowWithAgents(
      selectedWorkflow,
      userObjective,
      analysis,
      userContext
    );
    console.log('[TaskPlanner] Created plan with', plan.adaptedSteps.length, 'steps');

    return {
      analysis,
      recommendedWorkflows: workflows,
      plan,
    };
  }

  // -----------------------------------------------------------
  // Objective Analysis
  // -----------------------------------------------------------

  private async analyzeObjective(objective: string): Promise<TaskAnalysis> {
    const prompt = `Analyze this task objective and extract key information:

<objective>
${objective}
</objective>

Provide analysis in JSON format:
{
  "objective": "clear restatement of the objective",
  "domain": "primary domain (e.g., marketing, development, research, analysis)",
  "complexity": "Simple|Medium|Complex",
  "estimatedSteps": number,
  "requiredCapabilities": ["capability1", "capability2", ...],
  "suggestedApproach": "brief description of recommended approach"
}

Complexity Guidelines:
- Simple: 1-2 steps, single capability needed
- Medium: 3-6 steps, multiple capabilities, standard workflow
- Complex: 7+ steps, many capabilities, custom coordination needed

Required Capabilities examples:
- web_search, data_collection, content_writing, seo_optimization, code_generation, etc.`;

    const response = await this.gemini.generateWithNativeTools(
      [{ role: 'user', content: prompt }],
      {
        model: 'gemini-2.5-flash',
        temperature: 0.6,
        responseMimeType: 'application/json',
      }
    );

    try {
      const analysis = JSON.parse(response.text);
      return {
        objective: analysis.objective || objective,
        domain: analysis.domain || 'General',
        complexity: analysis.complexity || 'Medium',
        estimatedSteps: analysis.estimatedSteps || 3,
        requiredCapabilities: analysis.requiredCapabilities || [],
        suggestedApproach: analysis.suggestedApproach || '',
      };
    } catch (e) {
      console.error('[TaskPlanner] Failed to parse analysis:', e);
      // Return default analysis
      return {
        objective,
        domain: 'General',
        complexity: 'Medium',
        estimatedSteps: 3,
        requiredCapabilities: [],
        suggestedApproach: 'Standard workflow approach',
      };
    }
  }

  // -----------------------------------------------------------
  // Workflow Adaptation with Agent Assignment
  // -----------------------------------------------------------

  private async adaptWorkflowWithAgents(
    workflow: WorkflowTemplate,
    userObjective: string,
    analysis: TaskAnalysis,
    userContext?: Record<string, string>
  ): Promise<WorkflowPlan> {
    const adaptedSteps: AdaptedStep[] = [];

    for (const step of workflow.steps) {
      // Find best agent for this step
      const agent = await this.findBestAgent(step, analysis);

      if (!agent) {
        console.warn(`[TaskPlanner] No agent found for step ${step.number}: ${step.title}`);
        continue;
      }

      // Build dependencies
      const dependencies: Array<{ stepNumber: number; outputPath: string }> = [];
      if (step.number > 1) {
        const prevStep = workflow.steps[step.number - 2];
        if (prevStep.outputs && prevStep.outputs.length > 0) {
          dependencies.push({
            stepNumber: prevStep.number,
            outputPath: prevStep.outputs[0],
          });
        }
      }

      // Adapt step objective to user context
      const adaptedObjective = this.adaptStepObjective(
        step.description,
        userObjective,
        userContext
      );

      adaptedSteps.push({
        number: step.number,
        title: step.title,
        agentId: agent.id,
        agentName: agent.name,
        objective: adaptedObjective,
        requirements: this.extractRequirements(step.description),
        dependencies,
        outputs: step.outputs,
        checkpoint: step.checkpoint,
      });
    }

    return {
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      adaptedSteps,
      estimatedTime: workflow.estimatedTime,
      rationale: this.generateRationale(workflow, adaptedSteps, analysis),
    };
  }

  // -----------------------------------------------------------
  // Agent Selection
  // -----------------------------------------------------------

  private async findBestAgent(
    step: import('../types').WorkflowStep,
    analysis: TaskAnalysis
  ): Promise<{ id: string; name: string } | null> {
    // Build search query
    const query = `${step.title} ${step.description} ${step.tools.join(' ')}`;
    
    // Get required capabilities
    const requiredCaps = step.tools.length > 0 ? step.tools : undefined;

    // Search for agents
    const agents = await this.agentRegistry.searchAgents(
      query,
      requiredCaps,
      undefined,
      3
    );

    if (agents.length === 0) {
      console.warn(`[TaskPlanner] No agents found for step: ${step.title}`);
      return null;
    }

    // Validate agent capabilities
    for (const agent of agents) {
      const validation = this.agentRegistry.validateAgentForStep(
        agent,
        requiredCaps || []
      );

      if (validation.valid || validation.coverage >= 80) {
        return { id: agent.id, name: agent.name };
      }
    }

    // Return best match even if not perfect
    return { id: agents[0].id, name: agents[0].name };
  }

  // -----------------------------------------------------------
  // Helper Methods
  // -----------------------------------------------------------

  private adaptStepObjective(
    stepDescription: string,
    userObjective: string,
    userContext?: Record<string, string>
  ): string {
    let adapted = stepDescription;

    // Replace generic terms with user-specific details
    if (userContext) {
      for (const [key, value] of Object.entries(userContext)) {
        adapted = adapted.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
    }

    // Add user objective context
    adapted = `For the project "${userObjective}": ${adapted}`;

    return adapted;
  }

  private extractRequirements(description: string): string[] {
    const lines = description.split('\n');
    return lines
      .filter(line => line.trim().match(/^[-*•]\s+/))
      .map(line => line.trim().replace(/^[-*•]\s+/, ''));
  }

  private generateRationale(
    workflow: WorkflowTemplate,
    steps: AdaptedStep[],
    analysis: TaskAnalysis
  ): string {
    const agentCounts = new Map<string, number>();
    for (const step of steps) {
      agentCounts.set(step.agentId, (agentCounts.get(step.agentId) || 0) + 1);
    }

    const agentSummary = Array.from(agentCounts.entries())
      .map(([id, count]) => {
        const step = steps.find(s => s.agentId === id);
        return `${step?.agentName || id} (${count} step${count > 1 ? 's' : ''})`;
      })
      .join(', ');

    return `Selected "${workflow.title}" workflow for this ${analysis.complexity.toLowerCase()}-complexity ${analysis.domain} task. The workflow uses ${steps.length} steps executed by specialized agents: ${agentSummary}. Each agent is optimized for its specific role, ensuring high-quality results at each stage.`;
  }

  // -----------------------------------------------------------
  // User Presentation
  // -----------------------------------------------------------

  async formatPlanForUser(plan: WorkflowPlan): Promise<string> {
    const lines: string[] = [];

    lines.push(`# 📋 Workflow Plan: ${plan.workflowTitle}`);
    lines.push('');
    lines.push(`**Estimated Time**: ${plan.estimatedTime}`);
    lines.push('');
    lines.push(`## Rationale`);
    lines.push(plan.rationale);
    lines.push('');
    lines.push(`## Steps Overview`);
    lines.push('');

    for (const step of plan.adaptedSteps) {
      const checkpoint = step.checkpoint ? ' 🚦 **CHECKPOINT**' : '';
      lines.push(`### Step ${step.number}: ${step.title}${checkpoint}`);
      lines.push(`**Agent**: ${step.agentName} (\`${step.agentId}\`)`);
      lines.push('');
      lines.push(step.objective);
      lines.push('');

      if (step.requirements.length > 0) {
        lines.push(`**Requirements**:`);
        for (const req of step.requirements) {
          lines.push(`- ${req}`);
        }
        lines.push('');
      }

      if (step.outputs.length > 0) {
        lines.push(`**Outputs**: ${step.outputs.join(', ')}`);
        lines.push('');
      }

      if (step.checkpoint) {
        lines.push('> ⏸️ This is a checkpoint step. Execution will pause for your review and approval before continuing.');
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  async formatSimpleRecommendation(
    analysis: TaskAnalysis,
    workflows: WorkflowTemplate[]
  ): Promise<string> {
    const lines: string[] = [];

    lines.push(`# 🤔 Task Analysis`);
    lines.push('');
    lines.push(`**Objective**: ${analysis.objective}`);
    lines.push(`**Domain**: ${analysis.domain}`);
    lines.push(`**Complexity**: ${analysis.complexity}`);
    lines.push('');

    if (analysis.complexity === 'Simple') {
      lines.push(`## Recommendation: Direct Execution`);
      lines.push('');
      lines.push(`This is a simple task that doesn't require a structured workflow. I can handle it directly in our conversation.`);
      lines.push('');
      lines.push(`**Suggested Approach**: ${analysis.suggestedApproach}`);
    } else if (workflows.length === 0) {
      lines.push(`## No Matching Workflows Found`);
      lines.push('');
      lines.push(`I couldn't find a pre-built workflow template for this task. I can either:`);
      lines.push('');
      lines.push(`1. **Execute ad-hoc**: Work through this conversationally without a structured plan`);
      lines.push(`2. **Create custom workflow**: Design a custom workflow specifically for this task`);
      lines.push('');
      lines.push(`Which would you prefer?`);
    } else {
      lines.push(`## Available Workflow Templates`);
      lines.push('');

      for (let i = 0; i < Math.min(workflows.length, 3); i++) {
        const wf = workflows[i];
        lines.push(`### ${i + 1}. ${wf.title}`);
        lines.push(`**Domain**: ${wf.domain} | **Complexity**: ${wf.complexity} | **Time**: ${wf.estimatedTime}`);
        lines.push('');
        lines.push(wf.description);
        lines.push('');
        lines.push(`**Steps**: ${wf.steps.map(s => s.title).join(' → ')}`);
        lines.push('');
        lines.push('---');
        lines.push('');
      }

      lines.push(`Would you like me to create a detailed plan using one of these workflows?`);
    }

    return lines.join('\n');
  }
}

export default TaskPlannerAgent;
