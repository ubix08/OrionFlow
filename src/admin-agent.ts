// src/admin-agent.ts - Complete Hub-and-Spoke Orchestrator (UNIFIED)

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { 
  Env, 
  Message, 
  OrionRPC, 
  ChatResponse, 
  StepExecutionResult,
  StatusResponse,
  FileMetadata,
  ProjectInfo,
  WorkflowTemplate,
  WSIncomingMessage,
  WSOutgoingMessage,
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { Workspace } from './workspace/workspace';
import { EnhancedWorkflowManager } from './workflow/workflow-manager-enhanced';
import { TaskPlannerAgent } from './agents/task-planner';
import type { WorkflowPlan } from './agents/task-planner';

// =============================================================
// Admin State Interface
// =============================================================

interface AdminState {
  mode: 'conversational' | 'planning' | 'executing' | 'checkpoint';
  pendingPlan?: WorkflowPlan;
  pendingPlanId?: string;
  activeProject?: {
    projectPath: string;
    currentStep: number;
    totalSteps: number;
  };
  checkpointData?: {
    stepNumber: number;
    results: any;
  };
}

// =============================================================
// Admin Agent (Hub-and-Spoke Orchestrator)
// =============================================================

export class AdminAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private workflow?: EnhancedWorkflowManager;
  private taskPlanner?: TaskPlannerAgent;
  private sessionId?: string;
  private initialized = false;
  private wsConnections = new Set<WebSocket>();
  
  private adminState: AdminState = {
    mode: 'conversational',
  };
  
  private metrics = {
    totalRequests: 0,
    simpleRequests: 0,
    complexRequests: 0,
    projectsCreated: 0,
    stepsCompleted: 0,
    checkpointsReached: 0,
    planRegenerations: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    
    const name = state.id.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  // =============================================================
  // Initialization
  // =============================================================

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      if (this.env.DB) {
        this.d1 = new D1Manager(this.env.DB);
      }
      
      if (this.sessionId && Workspace.isInitialized()) {
        this.workflow = new EnhancedWorkflowManager(
          this.env.VECTORIZE || null,
          this.gemini,
          this.sessionId
        );
        
        if (this.workflow) {
          const agentRegistry = this.workflow.getAgentRegistry();
          this.taskPlanner = new TaskPlannerAgent(
            this.gemini,
            agentRegistry,
            this.workflow
          );
        }
        
        await this.loadAdminState();
        
        if (this.d1 && this.storage.getMessages().length === 0) {
          await this.hydrateFromD1();
        }

        await this.storage.setAlarm(Date.now() + 300000);
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('[Admin] Initialization error:', error);
      throw error;
    }
  }

  private async loadAdminState(): Promise<void> {
    try {
      const stored = await this.state.storage.get<AdminState>('admin_state');
      if (stored) {
        this.adminState = stored;
        console.log('[Admin] Loaded state:', this.adminState.mode);
      }
    } catch (e) {
      console.warn('[Admin] Failed to load state:', e);
    }
  }

  private async saveAdminState(): Promise<void> {
    try {
      await this.state.storage.put('admin_state', this.adminState);
    } catch (e) {
      console.warn('[Admin] Failed to save state:', e);
    }
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(
          msg.role as 'user' | 'model',
          msg.parts || [],
          msg.timestamp
        );
      }
      console.log(`[Admin] Hydrated ${messages.length} messages from D1`);
    } catch (e) {
      console.warn('[Admin] Hydration failed:', e);
    }
  }

  // =============================================================
  // Main Chat Entry Point
  // =============================================================

  async chat(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.init();
    
    if (!message?.trim()) {
      throw new Error('Message cannot be empty');
    }

    this.metrics.totalRequests++;
    console.log(`[Admin] Mode: ${this.adminState.mode}, Message: ${message.substring(0, 50)}`);
    
    try {
      switch (this.adminState.mode) {
        case 'planning':
          return await this.handlePlanningPhase(message);
        case 'executing':
          return await this.handleExecutionPhase(message);
        case 'checkpoint':
          return await this.handleCheckpointPhase(message);
        case 'conversational':
        default:
          return await this.handleConversationalPhase(message, images);
      }
    } catch (error) {
      console.error('[Admin] Chat error:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.saveMessage('model', `Error: ${errorMsg}`);
      return {
        response: `I encountered an error: ${errorMsg}`,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 0, toolsUsed: [] },
      };
    }
  }

  // =============================================================
  // Conversational Phase
  // =============================================================

  private async handleConversationalPhase(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    const intent = await this.analyzeIntent(message);
    console.log('[Admin] Intent:', intent);
    
    if (intent.isSimple) {
      this.metrics.simpleRequests++;
      return await this.executeSimpleRequest(message, images);
    } else {
      this.metrics.complexRequests++;
      return await this.initiateComplexPlanning(message);
    }
  }

  private async analyzeIntent(message: string): Promise<{
    isSimple: boolean;
    needsPlanning: boolean;
    estimatedSteps: number;
    reasoning: string;
  }> {
    const prompt = `Analyze this user request:

"${message}"

Determine if it's SIMPLE or COMPLEX.

SIMPLE (respond with isSimple: true):
- Questions, facts, definitions
- Quick searches, calculations
- Code snippets, single-file scripts
- 1-2 step tasks

COMPLEX (respond with isSimple: false):
- Multi-step projects
- Campaigns, strategies, workflows
- Research + analysis + creation
- Multiple deliverables
- Keywords: "create campaign", "build system", "analyze and report"

JSON format:
{"isSimple": true/false, "needsPlanning": true/false, "estimatedSteps": number, "reasoning": "brief"}`;

    try {
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: prompt }],
        {
          model: 'gemini-2.5-flash',
          temperature: 0.5,
          responseMimeType: 'application/json',
          maxOutputTokens: 512,
        }
      );

      const analysis = JSON.parse(response.text);
      return {
        isSimple: analysis.isSimple ?? true,
        needsPlanning: analysis.needsPlanning ?? false,
        estimatedSteps: analysis.estimatedSteps ?? 1,
        reasoning: analysis.reasoning ?? '',
      };
    } catch (e) {
      console.error('[Admin] Intent analysis failed:', e);
      return { isSimple: true, needsPlanning: false, estimatedSteps: 1, reasoning: 'Error, defaulting to simple' };
    }
  }

  private async executeSimpleRequest(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    console.log('[Admin] Executing simple request');
    
    await this.saveMessage('user', message);
    
    const history = this.formatContextForGemini(this.storage.getMessages().slice(-10));
    const messages = [
      { role: 'system', content: 'You are ORION, a helpful AI assistant. Be concise and accurate.' },
      ...history,
      { role: 'user', content: message },
    ];

    const response = await this.gemini.generateWithNativeTools(
      messages,
      {
        temperature: 0.7,
        useSearch: true,
        useCodeExecution: true,
        thinkingConfig: { thinkingBudget: 4096 },
        maxOutputTokens: 4096,
        images,
      }
    );

    await this.saveMessage('model', response.text);
    this.state.waitUntil(this.syncToD1());

    return {
      response: response.text,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: {
        turnsUsed: 1,
        toolsUsed: [
          response.searchResults ? 'google_search' : null,
          response.codeExecutionResults ? 'code_execution' : null,
        ].filter(Boolean) as string[],
      },
    };
  }

  private async initiateComplexPlanning(message: string): Promise<ChatResponse> {
    if (!this.taskPlanner) {
      throw new Error('Task planner not initialized');
    }

    console.log('[Admin] Initiating planning');
    await this.saveMessage('user', message);
    
    const plannerResult = await this.taskPlanner.createWorkflowPlan(message);
    const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    if (plannerResult.plan) {
      this.adminState.mode = 'planning';
      this.adminState.pendingPlan = plannerResult.plan;
      this.adminState.pendingPlanId = planId;
      await this.saveAdminState();
      
      const markdown = await this.taskPlanner.formatPlanForUser(plannerResult.plan);
      const response = `${markdown}\n\n---\n\n✅ **Approve this plan?** Reply "yes" to proceed, or provide feedback.`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        suggestedWorkflows: plannerResult.recommendedWorkflows,
        metadata: {
          turnsUsed: 1,
          toolsUsed: ['task_planner'],
        },
      };
    } else {
      const markdown = await this.taskPlanner.formatSimpleRecommendation(
        plannerResult.analysis,
        plannerResult.recommendedWorkflows
      );
      
      await this.saveMessage('model', markdown);
      
      return {
        response: markdown,
        artifacts: [],
        conversationPhase: 'discovery',
        suggestedWorkflows: plannerResult.recommendedWorkflows,
        metadata: { turnsUsed: 1, toolsUsed: ['task_planner'] },
      };
    }
  }

  // =============================================================
  // Planning Phase
  // =============================================================

  private async handlePlanningPhase(message: string): Promise<ChatResponse> {
    console.log('[Admin] Planning phase, user:', message.substring(0, 50));
    await this.saveMessage('user', message);
    
    const approved = this.detectApproval(message);
    
    if (approved) {
      return await this.executePendingPlan();
    } else {
      const needsRegeneration = message.toLowerCase().includes('regenerate') || 
                               message.toLowerCase().includes('new plan') ||
                               message.toLowerCase().includes('different');
      
      if (needsRegeneration && this.taskPlanner) {
        this.metrics.planRegenerations++;
        const plannerResult = await this.taskPlanner.createWorkflowPlan(
          this.adminState.pendingPlan?.workflowTitle || message,
          { feedback: message }
        );
        
        if (plannerResult.plan) {
          this.adminState.pendingPlan = plannerResult.plan;
          await this.saveAdminState();
          
          const markdown = await this.taskPlanner.formatPlanForUser(plannerResult.plan);
          const response = `${markdown}\n\n---\n\n✅ **Approve this revised plan?** Reply "yes" to proceed.`;
          await this.saveMessage('model', response);
          
          return {
            response,
            artifacts: [],
            conversationPhase: 'discovery',
            suggestedWorkflows: plannerResult.recommendedWorkflows,
            metadata: { turnsUsed: 1, toolsUsed: ['task_planner'] },
          };
        }
      }
      
      const response = `I understand. Options:\n\n1. **Regenerate** - Create a new plan with your feedback\n2. **Proceed** - Continue with current plan\n3. **Cancel** - Return to conversational mode\n\nWhat would you like?`;
      await this.saveMessage('model', response);
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  private detectApproval(message: string): boolean {
    const lower = message.toLowerCase().trim();
    return ['yes', 'approve', 'proceed', 'go ahead', 'start', 'begin', 'ok', 'okay', '👍', 'continue']
      .some(kw => lower.includes(kw));
  }

  private async executePendingPlan(): Promise<ChatResponse> {
    if (!this.adminState.pendingPlan || !this.workflow) {
      throw new Error('No pending plan');
    }

    console.log('[Admin] Executing approved plan');
    const plan = this.adminState.pendingPlan;
    
    try {
      const project = await this.workflow.createProjectFromTemplate(
        plan.workflowId,
        plan.workflowTitle
      );
      
      this.adminState.mode = 'executing';
      this.adminState.activeProject = {
        projectPath: project.projectPath,
        currentStep: 1,
        totalSteps: plan.adaptedSteps.length,
      };
      this.adminState.pendingPlan = undefined;
      this.adminState.pendingPlanId = undefined;
      await this.saveAdminState();
      
      this.metrics.projectsCreated++;
      
      this.broadcastWS({
        type: 'project_created',
        projectId: project.projectId,
        projectPath: project.projectPath,
      });
      
      return await this.executeCurrentStep();
    } catch (error) {
      this.adminState.mode = 'conversational';
      await this.saveAdminState();
      
      const errorMsg = `Failed to create project: ${error instanceof Error ? error.message : String(error)}`;
      await this.saveMessage('model', errorMsg);
      
      return {
        response: errorMsg,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  // =============================================================
  // Execution Phase
  // =============================================================

  private async handleExecutionPhase(message: string): Promise<ChatResponse> {
    const lower = message.toLowerCase().trim();
    
    if (lower.includes('stop') || lower.includes('cancel') || lower.includes('abort')) {
      return await this.abortExecution();
    }
    
    if (lower.includes('continue') || lower.includes('next') || lower.includes('proceed')) {
      return await this.executeCurrentStep();
    }
    
    if (lower.includes('status') || lower.includes('progress')) {
      return await this.getExecutionStatus();
    }
    
    return await this.getExecutionStatus();
  }

  private async executeCurrentStep(): Promise<ChatResponse> {
    if (!this.adminState.activeProject || !this.workflow) {
      throw new Error('No active project');
    }

    const { projectPath, currentStep, totalSteps } = this.adminState.activeProject;
    console.log(`[Admin] Executing step ${currentStep}/${totalSteps}`);
    
    this.broadcastWS({
      type: 'step_started',
      stepNumber: currentStep,
      stepTitle: `Step ${currentStep}`,
    });
    
    try {
      const stepResult = await this.workflow.executeStepWithAgent(
        projectPath, 
        currentStep,
        {
          onStatus: (msg) => {
            console.log(`[Admin] ${msg}`);
            this.broadcastWS({ type: 'status', message: msg });
          },
          onThought: (thought) => {
            console.log(`[Admin] Thought: ${thought}`);
            this.broadcastWS({ type: 'thought', content: thought });
          },
        }
      );
      
      this.metrics.stepsCompleted++;
      
      const todo = await this.workflow.loadTodoDocument(projectPath);
      if (!todo) throw new Error('Todo not found');
      
      const step = todo.steps.find(s => s.number === currentStep);
      const isCheckpoint = step?.checkpoint ?? false;
      
      if (isCheckpoint) {
        this.metrics.checkpointsReached++;
        this.adminState.mode = 'checkpoint';
        this.adminState.checkpointData = { stepNumber: currentStep, results: stepResult };
        await this.saveAdminState();
        
        const response = this.formatCheckpointResults(currentStep, stepResult, step);
        await this.saveMessage('model', response);
        
        this.broadcastWS({
          type: 'step_complete',
          stepNumber: currentStep,
          stepTitle: step?.title || `Step ${currentStep}`,
          outputs: stepResult.outputs || [],
          nextStepReady: false,
        });
        
        return {
          response,
          artifacts: [],
          conversationPhase: 'execution',
          activeProject: {
            projectId: projectPath.split('/').pop() || '',
            projectPath,
            currentStep,
            totalSteps,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          metadata: {
            turnsUsed: 1,
            toolsUsed: [`agent:${stepResult.metadata.agentId}`],
          },
        };
      } else {
        if (currentStep < totalSteps) {
          this.adminState.activeProject.currentStep++;
          await this.saveAdminState();
          
          this.broadcastWS({
            type: 'step_complete',
            stepNumber: currentStep,
            stepTitle: step?.title || `Step ${currentStep}`,
            outputs: stepResult.outputs || [],
            nextStepReady: true,
          });
          
          return await this.executeCurrentStep();
        } else {
          return await this.completeWorkflow();
        }
      }
    } catch (error) {
      return await this.handleStepFailure(error);
    }
  }

  // =============================================================
  // Checkpoint Phase
  // =============================================================

  private async handleCheckpointPhase(message: string): Promise<ChatResponse> {
    console.log('[Admin] Checkpoint phase, feedback:', message.substring(0, 50));
    await this.saveMessage('user', message);
    
    const approved = this.detectApproval(message);
    
    if (approved) {
      if (!this.adminState.activeProject) throw new Error('No active project');
      
      const { currentStep, totalSteps } = this.adminState.activeProject;
      this.adminState.checkpointData = undefined;
      
      if (currentStep < totalSteps) {
        this.adminState.mode = 'executing';
        this.adminState.activeProject.currentStep++;
        await this.saveAdminState();
        
        const response = `✅ Continuing to Step ${currentStep + 1}...`;
        await this.saveMessage('model', response);
        
        return await this.executeCurrentStep();
      } else {
        return await this.completeWorkflow();
      }
    } else {
      const lower = message.toLowerCase();
      
      if (lower.includes('retry') || lower.includes('redo')) {
        this.adminState.mode = 'executing';
        await this.saveAdminState();
        
        const response = `♻️ Retrying current step...`;
        await this.saveMessage('model', response);
        
        return await this.executeCurrentStep();
      } else if (lower.includes('skip')) {
        if (!this.adminState.activeProject) throw new Error('No active project');
        
        const { currentStep, totalSteps } = this.adminState.activeProject;
        
        if (currentStep < totalSteps) {
          this.adminState.mode = 'executing';
          this.adminState.activeProject.currentStep++;
          await this.saveAdminState();
          
          const response = `⏭️ Skipping to Step ${currentStep + 1}...`;
          await this.saveMessage('model', response);
          
          return await this.executeCurrentStep();
        } else {
          return await this.completeWorkflow();
        }
      } else {
        const response = `Options:\n1. **Retry** - Re-execute current step\n2. **Skip** - Skip and continue\n3. **Abort** - Stop workflow\n\nWhat would you like?`;
        await this.saveMessage('model', response);
        return { 
          response, 
          artifacts: [], 
          conversationPhase: 'execution', 
          metadata: { turnsUsed: 1, toolsUsed: [] } 
        };
      }
    }
  }

  // =============================================================
  // Workflow Completion & Error Handling
  // =============================================================

  private async completeWorkflow(): Promise<ChatResponse> {
    if (!this.adminState.activeProject || !this.workflow) throw new Error('No active project');

    const { projectPath } = this.adminState.activeProject;
    const todo = await this.workflow.loadTodoDocument(projectPath);
    const progress = todo ? this.workflow.getProgress(todo) : null;
    
    this.adminState.mode = 'conversational';
    this.adminState.activeProject = undefined;
    this.adminState.checkpointData = undefined;
    await this.saveAdminState();
    
    const response = `🎉 **Workflow Complete!**\n\n**Progress**: ${progress?.completed}/${progress?.total} steps\n**Project**: \`${projectPath}\`\n\nAll deliverables saved. What's next?`;
    await this.saveMessage('model', response);
    
    this.broadcastWS({
      type: 'complete',
      response,
      artifacts: [],
    });
    
    return { 
      response, 
      artifacts: [], 
      conversationPhase: 'delivery', 
      metadata: { turnsUsed: 1, toolsUsed: [] } 
    };
  }

  private async abortExecution(): Promise<ChatResponse> {
    const projectPath = this.adminState.activeProject?.projectPath;
    
    this.adminState.mode = 'conversational';
    this.adminState.activeProject = undefined;
    this.adminState.checkpointData = undefined;
    await this.saveAdminState();
    
    const response = `⏸️ **Workflow Aborted**\n\n${projectPath ? `Project saved at: \`${projectPath}\`` : 'No active project'}\n\nYou can resume later or start something new.`;
    await this.saveMessage('model', response);
    
    return { 
      response, 
      artifacts: [], 
      conversationPhase: 'discovery', 
      metadata: { turnsUsed: 1, toolsUsed: [] } 
    };
  }

  private async handleStepFailure(error: unknown): Promise<ChatResponse> {
    if (!this.adminState.activeProject) throw error;

    const errorMsg = error instanceof Error ? error.message : String(error);
    this.metrics.planRegenerations++;
    
    const response = `⚠️ **Step ${this.adminState.activeProject.currentStep} Failed**\n\nError: ${errorMsg}\n\nOptions:\n1. **Retry** - Try again\n2. **Skip** - Continue to next step\n3. **Abort** - Stop workflow\n\nWhat to do?`;
    await this.saveMessage('model', response);
    
    this.broadcastWS({
      type: 'error',
      error: errorMsg,
    });
    
    return { 
      response, 
      artifacts: [], 
      conversationPhase: 'execution', 
      metadata: { turnsUsed: 1, toolsUsed: [] } 
    };
  }

  private async getExecutionStatus(): Promise<ChatResponse> {
    if (!this.adminState.activeProject || !this.workflow) {
      return { 
        response: 'No active execution.', 
        artifacts: [], 
        conversationPhase: 'discovery', 
        metadata: { turnsUsed: 1, toolsUsed: [] } 
      };
    }

    const { currentStep, totalSteps, projectPath } = this.adminState.activeProject;
    const todo = await this.workflow.loadTodoDocument(projectPath);
    const progress = todo ? this.workflow.getProgress(todo) : null;
    
    const response = `📊 **Execution Status**\n\n**Current Step**: ${currentStep}/${totalSteps}\n**Progress**: ${progress?.completed}/${progress?.total} completed (${progress?.percentage}%)\n**Project**: \`${projectPath}\`\n\nReply "continue" to proceed, or "abort" to stop.`;
    
    return { 
      response, 
      artifacts: [], 
      conversationPhase: 'execution', 
      activeProject: {
        projectId: projectPath.split('/').pop() || '',
        projectPath,
        currentStep,
        totalSteps,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      metadata: { turnsUsed: 1, toolsUsed: [] } 
    };
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private formatCheckpointResults(stepNumber: number, result: any, step?: any): string {
    return `🚦 **Checkpoint: Step ${stepNumber}**\n\n**${step?.title || `Step ${stepNumber}`}**\n\nAgent: \`${result.metadata.agentId}\`\nTokens Used: ${result.metadata.tokensUsed}\nLatency: ${result.metadata.latency}ms\n\n**Outputs**:\n${this.formatOutputsList(result.outputs)}\n\n---\n\n✅ Reply "continue" to proceed, or provide feedback for adjustments.`;
  }

  private formatOutputsList(outputs: any): string {
    if (!outputs) return '(None)';
    if (typeof outputs === 'string') return outputs.substring(0, 500) + (outputs.length > 500 ? '...' : '');
    return JSON.stringify(outputs, null, 2).substring(0, 500);
  }

  private formatContextForGemini(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: this.extractMessageContent(msg),
    }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) {
      return (msg as any).parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    }
    return '';
  }

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
  }

  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    
    try {
      const messages = this.storage.getMessages();
      if (messages.length === 0) return;
      
      const latestInD1 = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const newMessages = messages.filter(m => (m.timestamp || 0) > latestInD1);
      
      if (newMessages.length > 0) {
        await this.d1.saveMessages(this.sessionId, newMessages);
        console.log(`[Admin] Synced ${newMessages.length} messages to D1`);
      }
    } catch (err) {
      console.error('[Admin] D1 sync failed:', err);
    }
  }

  // =============================================================
  // RPC Interface Implementation
  // =============================================================

  async executeStep(projectPath: string, stepNumber: number): Promise<StepExecutionResult> {
    await this.init();
    if (!this.workflow) throw new Error('Workflow not initialized');

    try {
      await this.workflow.updateStepStatus(projectPath, stepNumber, 'in_progress');
      const result = await this.workflow.executeStepWithAgent(projectPath, stepNumber);
      await this.workflow.updateStepStatus(projectPath, stepNumber, 'completed');
      
      this.metrics.stepsCompleted++;
      
      const todo = await this.workflow.loadTodoDocument(projectPath);
      const nextStep = todo?.steps.find(s => s.number === stepNumber + 1 && s.status === 'pending');
      
      return {
        stepNumber,
        stepTitle: `Step ${stepNumber}`,
        status: 'completed',
        response: 'Step completed successfully',
        outputs: result.outputs || [],
        artifacts: [],
        nextStepReady: !!nextStep,
        turnsUsed: 1,
      };
    } catch (error) {
      await this.workflow.updateStepStatus(
        projectPath, 
        stepNumber, 
        'pending',
        `Failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: any[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async getProjects(): Promise<{ projects: ProjectInfo[] }> {
    await this.init();
    
    if (!this.workflow || !this.sessionId || !Workspace.isInitialized()) {
      return { projects: [] };
    }

    try {
      const listing = await Workspace.readdir(this.sessionId);
      const projects: ProjectInfo[] = [];

      for (const item of listing.directories) {
        if (item.startsWith('project_')) {
          const projectPath = `${this.sessionId}/${item}`;
          const todo = await this.workflow.loadTodoDocument(projectPath);
          
          if (todo) {
            const progress = this.workflow.getProgress(todo);
            projects.push({
              projectId: item,
              objective: todo.objective,
              workflowId: todo.workflowId,
              conversationPhase: progress.percentage === 100 ? 'delivery' : 'execution',
              stepsTotal: progress.total,
              stepsCompleted: progress.completed,
              currentStep: this.workflow.getCurrentStep(todo)?.number,
              workspacePath: projectPath,
              createdAt: todo.createdAt,
              updatedAt: todo.updatedAt,
            });
          }
        }
      }

      return { projects };
    } catch (e) {
      console.error('[Admin] List projects failed:', e);
      return { projects: [] };
    }
  }

  async listWorkflows(): Promise<{ workflows: WorkflowTemplate[] }> {
    await this.init();
    if (!this.workflow) return { workflows: [] };
    
    try {
      const workflows = await this.workflow.listAllTemplates();
      return { workflows };
    } catch (error) {
      console.error('[Admin] List workflows failed:', error);
      return { workflows: [] };
    }
  }

  async searchWorkflows(query: string): Promise<{ workflows: WorkflowTemplate[] }> {
    await this.init();
    if (!this.workflow) return { workflows: [] };
    
    try {
      const workflows = await this.workflow.searchTemplates(query, 3);
      return { workflows };
    } catch (error) {
      console.error('[Admin] Search workflows failed:', error);
      return { workflows: [] };
    }
  }

  async createProjectFromWorkflow(
    workflowId: string, 
    objective: string,
    adaptations?: string
  ): Promise<{ projectId: string; projectPath: string }> {
    await this.init();
    if (!this.workflow) throw new Error('Workflow not initialized');
    
    try {
      const result = await this.workflow.createProjectFromTemplate(
        workflowId,
        objective,
        adaptations ? { adaptations } : undefined
      );
      
      this.metrics.projectsCreated++;
      return result;
    } catch (error) {
      console.error('[Admin] Create project failed:', error);
      throw error;
    }
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    
    try {
      await this.storage.clearAll();
      this.adminState = { mode: 'conversational' };
      await this.saveAdminState();
      
      console.log('[Admin] Cleared all data');
      return { ok: true };
    } catch (error) {
      console.error('[Admin] Clear failed:', error);
      throw error;
    }
  }

  async uploadFile(
    base64: string, 
    mimeType: string, 
    name: string
  ): Promise<{ success: boolean; file: FileMetadata }> {
    await this.init();
    
    try {
      const file = await this.gemini.uploadFile(base64, mimeType, name);
      return { success: true, file };
    } catch (error) {
      console.error('[Admin] Upload file failed:', error);
      throw error;
    }
  }

  async listFiles(): Promise<{ files: FileMetadata[] }> {
    await this.init();
    
    try {
      const files = await this.gemini.listFiles();
      return { files };
    } catch (error) {
      console.error('[Admin] List files failed:', error);
      return { files: [] };
    }
  }

  async deleteFile(fileUri: string): Promise<{ ok: boolean }> {
    await this.init();
    
    try {
      await this.gemini.deleteFile(fileUri);
      return { ok: true };
    } catch (error) {
      console.error('[Admin] Delete file failed:', error);
      throw error;
    }
  }

  async getStatus(): Promise<StatusResponse> {
    await this.init();
    
    try {
      const agentCount = this.workflow 
        ? (await this.workflow.getAgentRegistry().listAllAgents()).length
        : 0;
      
      const workflowCount = this.workflow 
        ? (await this.workflow.listAllTemplates()).length
        : 0;
      
      return {
        sessionId: this.sessionId,
        messageCount: this.storage.getMessages().length,
        artifactCount: this.storage.getArtifacts().length,
        conversationPhase: this.adminState.mode === 'conversational' ? 'discovery' : 
                           this.adminState.mode === 'executing' ? 'execution' : 'delivery',
        activeProject: this.adminState.activeProject ? {
          projectId: this.adminState.activeProject.projectPath.split('/').pop() || '',
          projectPath: this.adminState.activeProject.projectPath,
          currentStep: this.adminState.activeProject.currentStep,
          totalSteps: this.adminState.activeProject.totalSteps,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } : undefined,
        protocol: 'Hub-and-Spoke Multi-Agent',
        metrics: { 
          ...this.metrics, 
          availableAgents: agentCount, 
          availableWorkflows: workflowCount 
        } as any,
        nativeTools: { 
          googleSearch: true, 
          codeExecution: true, 
          thinking: true 
        },
        memory: null,
        workspace: { 
          enabled: Workspace.isInitialized(), 
          initialized: Workspace.isInitialized() 
        },
        availableWorkflows: workflowCount,
      };
    } catch (error) {
      console.error('[Admin] Get status failed:', error);
      throw error;
    }
  }

  // =============================================================
  // WebSocket Implementation
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }
    return new Response('Use RPC methods for API calls', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    this.state.acceptWebSocket(server as WebSocket);
    this.wsConnections.add(server as WebSocket);
    
    return new Response(null, { status: 101, webSocket: client as WebSocket });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const msg = JSON.parse(message) as WSIncomingMessage;

      switch (msg.type) {
        case 'user_message':
          const response = await this.chat(msg.content, msg.images);
          this.sendWS(ws, { type: 'complete', response: response.response, artifacts: response.artifacts });
          break;

        case 'execute_step':
          if (msg.projectPath && msg.stepNumber) {
            const result = await this.executeStep(msg.projectPath, msg.stepNumber);
            this.sendWS(ws, { 
              type: 'step_complete', 
              stepNumber: result.stepNumber, 
              stepTitle: result.stepTitle,
              outputs: result.outputs,
              nextStepReady: result.nextStepReady 
            });
          }
          break;

        case 'ping':
          this.sendWS(ws, { type: 'pong' });
          break;

        default:
          console.warn('[Admin] Unknown WebSocket message type:', msg);
      }
    } catch (error) {
      console.error('[Admin] WebSocket message error:', error);
      this.sendWS(ws, { 
        type: 'error', 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.wsConnections.delete(ws);
    console.log(`[Admin] WebSocket closed: ${code}`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Admin] WebSocket error:', error);
    this.wsConnections.delete(ws);
  }

  private sendWS(ws: WebSocket, msg: WSOutgoingMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (error) {
      console.error('[Admin] WebSocket send error:', error);
    }
  }

  private broadcastWS(msg: WSOutgoingMessage): void {
    for (const ws of this.wsConnections) {
      this.sendWS(ws, msg);
    }
  }

  // =============================================================
  // Alarm Handler
  // =============================================================

  async alarm(): Promise<void> {
    console.log('[Admin] Alarm triggered - syncing to D1');
    
    try {
      await this.syncToD1();
    } catch (err) {
      console.error('[Admin] Alarm sync failed:', err);
    }
    
    await this.storage.setAlarm(Date.now() + 300000);
  }
}

// =============================================================
// Export
// =============================================================

export default AdminAgent;
