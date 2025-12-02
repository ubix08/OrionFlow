// src/tools/planning-tool.ts - Centralized Planning Interface

import type { GeminiClient } from '../gemini';
import type { TaskPlannerAgent } from '../agents/task-planner';
import type { TaskAnalysis, WorkflowTemplate, WorkflowPlan } from '../types';

export class PlanningTool {
  private taskPlanner: TaskPlannerAgent;
  private gemini: GeminiClient;

  constructor(taskPlanner: TaskPlannerAgent, gemini: GeminiClient) {
    this.taskPlanner = taskPlanner;
    this.gemini = gemini;
  }

  // =============================================================
  // Main Planning Interface
  // =============================================================

  async createPlan(spec: {
    objective: string;
    constraints?: string[];
    userPreferences?: Record<string, any>;
  }): Promise<{
    analysis: TaskAnalysis;
    recommendedWorkflows: WorkflowTemplate[];
    plan?: WorkflowPlan;
  }> {
    console.log('[PlanningTool] Creating plan for:', spec.objective);

    try {
      // Delegate to TaskPlannerAgent
      const result = await this.taskPlanner.createWorkflowPlan(
        spec.objective,
        spec.userPreferences
      );

      return {
        analysis: result.analysis,
        recommendedWorkflows: result.recommendedWorkflows,
        plan: result.plan,
      };
    } catch (error) {
      console.error('[PlanningTool] Planning failed:', error);
      throw error;
    }
  }

  // =============================================================
  // Replanning (Error Recovery)
  // =============================================================

  async replan(spec: {
    projectId: string;
    issue: string;
    fromStep: number;
    currentPlan: WorkflowPlan;
  }): Promise<WorkflowPlan> {
    console.log(`[PlanningTool] Replanning project ${spec.projectId} from step ${spec.fromStep}`);

    const prompt = `Replan the workflow to address this issue:

**Issue**: ${spec.issue}

**Current Plan**: ${spec.currentPlan.workflowTitle}
**Failed at Step**: ${spec.fromStep}

**Current Steps**:
${spec.currentPlan.adaptedSteps.map(s => `${s.number}. ${s.title} (Agent: ${s.agentId})`).join('\n')}

Generate a revised plan starting from step ${spec.fromStep}. Keep successful steps (1-${spec.fromStep - 1}) unchanged.

Return JSON:
{
  "workflowId": "${spec.currentPlan.workflowId}",
  "workflowTitle": "revised title",
  "adaptedSteps": [
    // Keep steps 1 to ${spec.fromStep - 1} as-is
    // Revise step ${spec.fromStep} onwards
  ],
  "estimatedTime": "estimated time",
  "rationale": "why this replanning fixes the issue"
}`;

    try {
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: prompt }],
        {
          model: 'gemini-2.5-flash',
          temperature: 0.7,
          responseMimeType: 'application/json',
        }
      );

      const revisedPlan = JSON.parse(response.text);
      
      // Merge: keep successful steps, replace from failure point
      const mergedSteps = [
        ...spec.currentPlan.adaptedSteps.slice(0, spec.fromStep - 1),
        ...revisedPlan.adaptedSteps.filter((s: any) => s.number >= spec.fromStep),
      ];

      return {
        workflowId: revisedPlan.workflowId,
        workflowTitle: revisedPlan.workflowTitle,
        adaptedSteps: mergedSteps,
        estimatedTime: revisedPlan.estimatedTime,
        rationale: `Replanned from step ${spec.fromStep}: ${revisedPlan.rationale}`,
      };
    } catch (error) {
      console.error('[PlanningTool] Replanning failed:', error);
      throw new Error('Failed to generate revised plan');
    }
  }

  // =============================================================
  // Plan Adaptation (User Feedback)
  // =============================================================

  async adaptPlan(spec: {
    currentPlan: WorkflowPlan;
    feedback: string;
  }): Promise<WorkflowPlan> {
    console.log('[PlanningTool] Adapting plan based on feedback');

    const prompt = `Adapt this workflow plan based on user feedback:

**Current Plan**: ${spec.currentPlan.workflowTitle}

**Steps**:
${spec.currentPlan.adaptedSteps.map(s => `${s.number}. ${s.title}`).join('\n')}

**User Feedback**: ${spec.feedback}

Generate an adapted plan addressing the feedback. Maintain the same workflow structure but adjust steps as needed.

Return JSON matching this structure:
{
  "workflowId": "${spec.currentPlan.workflowId}",
  "workflowTitle": "adapted title",
  "adaptedSteps": [...],
  "estimatedTime": "time",
  "rationale": "how feedback was incorporated"
}`;

    try {
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: prompt }],
        {
          model: 'gemini-2.5-flash',
          temperature: 0.7,
          responseMimeType: 'application/json',
        }
      );

      return JSON.parse(response.text);
    } catch (error) {
      console.error('[PlanningTool] Adaptation failed:', error);
      throw new Error('Failed to adapt plan');
    }
  }

  // =============================================================
  // Plan Formatting for User
  // =============================================================

  async formatPlanForUser(plan: WorkflowPlan): Promise<string> {
    return await this.taskPlanner.formatPlanForUser(plan);
  }

  async formatSimpleRecommendation(
    analysis: TaskAnalysis,
    workflows: WorkflowTemplate[]
  ): Promise<string> {
    return await this.taskPlanner.formatSimpleRecommendation(analysis, workflows);
  }
}

export default PlanningTool;
