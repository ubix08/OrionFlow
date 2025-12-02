// src/admin-agent-refactored.ts - Session-Agnostic Admin Agent

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { 
  Env, 
  Message, 
  OrionRPC, 
  ChatResponse,
  StatusResponse,
  FileMetadata,
  ProjectMetadata,
  ProjectFilters,
  Intent,
  AdminState,
  UserContext,
  WSIncomingMessage,
  WSOutgoingMessage,
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager-enhanced';
import { Workspace } from './workspace/workspace';
import { EnhancedWorkflowManager } from './workflow/workflow-manager-enhanced';
import { TaskPlannerAgent } from './agents/task-planner';
import { MemoryManager } from './memory/memory-manager';
import { ProjectTool } from './tools/project-tool';
import { PlanningTool } from './tools/planning-tool';
import { MemoryTool } from './tools/memory-tool';

// =============================================================
// Refactored Admin Agent
// =============================================================

export class AdminAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private workflow?: EnhancedWorkflowManager;
  private memoryManager?: MemoryManager;
  private sessionId?: string;
  private userId: string;
  private initialized = false;
  private wsConnections = new Set<WebSocket>();
  
  // Tools
  private projectTool?: ProjectTool;
  private planningTool?: PlanningTool;
  private memoryTool?: MemoryTool;
  
  // State
  private adminState: AdminState = {
    mode: 'conversational',
  };
  
  // Metrics
  private metrics = {
    totalRequests: 0,
    simpleRequests: 0,
    complexRequests: 0,
    projectsCreated: 0,
    projectsResumed: 0,
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
    
    // Extract userId from sessionId or use default
    this.userId = this.extractUserId(this.sessionId);
  }

  // =============================================================
  // Initialization
  // =============================================================

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      console.log('[Admin] Initializing...');

      // Initialize Workspace
      if (!Workspace.isInitialized() && this.env.B2_KEY_ID && this.env.B2_APPLICATION_KEY) {
        Workspace.initialize(this.env);
        console.log('[Admin] ✅ Workspace initialized');
      }
      
      // Initialize D1
      if (this.env.DB) {
        this.d1 = new D1Manager(this.env.DB);
        
        // Initialize ProjectTool
        this.projectTool = new ProjectTool(this.d1);
        
        // Ensure session exists
        if (this.sessionId) {
          const existing = await this.d1.getSession(this.sessionId);
          if (!existing) {
            await this.d1.createSession(this.sessionId, this.userId, 'New Session');
          }
        }
      }
      
      // Initialize Memory & Workflow (lazy)
      if (this.sessionId && Workspace.isInitialized()) {
        this.workflow = new EnhancedWorkflowManager(
          this.env.VECTORIZE || null,
          this.gemini,
          this.sessionId
        );
        
        if (this.env.VECTORIZE) {
          this.memoryManager = new MemoryManager(
            this.env.VECTORIZE,
            this.gemini,
            this.sessionId,
            this.state.storage,
            { cacheSize: 200, cacheTTL: 3600000 }
          );
        }
        
        // Initialize Tools
        if (this.projectTool) {
          this.memoryTool = new MemoryTool(
            this.memoryManager || null,
            this.projectTool,
            this.userId
          );
        }
        
        const agentRegistry = this.workflow.getAgentRegistry();
        const taskPlanner = new TaskPlannerAgent(
          this.gemini,
          agentRegistry,
          this.workflow
        );
        
        this.planningTool = new PlanningTool(taskPlanner, this.gemini);
        
        // Load admin state
        await this.loadAdminState();
        
        // Hydrate from D1 if needed
        if (this.d1 && this.storage.getMessages().length === 0) {
          await this.hydrateFromD1();
        }

        await this.storage.setAlarm(Date.now() + 300000);
      }
      
      this.initialized = true;
      console.log('[Admin] ✅ Initialization complete');
    } catch (error) {
      console.error('[Admin] Initialization error:', error);
      throw error;
    }
  }

  private extractUserId(sessionId?: string): string {
    // Simple extraction: use sessionId as userId
    // In production: extract from JWT or authentication system
    return sessionId || 'anonymous';
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
      // Route based on current mode
      switch (this.adminState.mode) {
        case 'awaiting_plan_approval':
          return await this.handlePlanApproval(message);
        
        case 'executing':
          return await this.handleExecutionCommands(message);
        
        case 'checkpoint_review':
          return await this.handleCheckpointReview(message);
        
        case 'conversational':
        default:
          return await this.handleConversational(message, images);
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
  // Conversational Mode (Intent Classification)
  // =============================================================

  private async handleConversational(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.saveMessage('user', message);
    
    // 1. Load rich context
    const userContext = await this.loadUserContext();
    
    // 2. Classify intent
    const intent = await this.classifyIntent(message, userContext);
    console.log('[Admin] Intent:', intent);
    
    // 3. Route based on intent
    switch (intent.type) {
      case 'simple':
        this.metrics.simpleRequests++;
        return await this.handleSimpleRequest(message, images, userContext);
      
      case 'complex':
        this.metrics.complexRequests++;
        return await this.handleComplexRequest(message, userContext);
      
      case 'project_continuation':
        this.metrics.projectsResumed++;
        if (!intent.projectId) {
          return await this.handleProjectSelectionForContinuation(userContext);
        }
        return await this.continueProject(intent.projectId);
      
      case 'project_query':
        if (!intent.projectId) {
          return await this.handleProjectQuery(message, userContext);
        }
        return await this.querySpecificProject(intent.projectId, message);
      
      default:
        return await this.handleSimpleRequest(message, images, userContext);
    }
  }

  // =============================================================
  // Context Loading
  // =============================================================

  private async loadUserContext(): Promise<UserContext> {
    if (!this.memoryTool || !this.projectTool) {
      return {
        userId: this.userId,
        recentProjects: [],
        unfinishedProjects: [],
        conversationHistory: this.storage.getMessages().slice(-10),
        preferences: {},
      };
    }

    const context = await this.memoryTool.getUserContext();
    context.conversationHistory = this.storage.getMessages().slice(-10);
    
    return context;
  }

  // =============================================================
  // Intent Classification
  // =============================================================

  private async classifyIntent(message: string, context: UserContext): Promise<Intent> {
    const prompt = `Analyze this user request with full context:

**REQUEST**: "${message}"

**CONTEXT**:
- User ID: ${context.userId}
- Recent Projects: ${context.recentProjects.map(p => `"${p.title}" (${p.status})`).join(', ') || 'None'}
- Unfinished Projects: ${context.unfinishedProjects.map(p => `"${p.title}" at step ${p.currentStep}/${p.totalSteps}`).join(', ') || 'None'}
- Recent Conversation: ${context.conversationHistory.slice(-3).map(m => `${m.role}: ${this.extractMessageContent(m).substring(0, 100)}`).join('\n')}

**CLASSIFICATION RULES**:

1. **SIMPLE** (complexity 1-3):
   - Quick questions, definitions, facts
   - Single-turn answers
   - "What is...", "How to...", "Explain..."
   - Tasks requiring 1-2 steps max

2. **COMPLEX** (complexity 4-10):
   - Multi-step projects
   - Keywords: "create campaign", "build system", "research and analyze"
   - Requires planning, deliverables, checkpoints
   - 3+ distinct steps

3. **PROJECT_CONTINUATION** (if unfinished projects exist):
   - "Continue", "resume", "keep working on", "finish"
   - References to previous work
   - "What's next" when context implies active project

4. **PROJECT_QUERY**:
   - Questions about existing projects
   - "How did X go?", "Show me Y project", "What was the result of..."

Return JSON:
{
  "type": "simple|complex|project_continuation|project_query",
  "projectId": "if specific project mentioned or implied",
  "reasoning": "brief explanation",
  "complexity": 1-10,
  "confidence": 0.0-1.0
}`;

    try {
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: prompt }],
        {
          model: 'gemini-2.5-flash',
          temperature: 0.3,
          responseMimeType: 'application/json',
          maxOutputTokens: 512,
        }
      );

      const intent = JSON.parse(response.text);
      return {
        type: intent.type || 'simple',
        projectId: intent.projectId,
        reasoning: intent.reasoning || '',
        complexity: intent.complexity || 1,
        confidence: intent.confidence || 0.5,
      };
    } catch (e) {
      console.error('[Admin] Intent classification failed:', e);
      return {
        type: 'simple',
        reasoning: 'Classification error, defaulting to simple',
        complexity: 1,
        confidence: 0.3,
      };
    }
  }

  // =============================================================
  // Simple Request Handling
  // =============================================================

  private async handleSimpleRequest(
    message: string,
    images: Array<{ data: string; mimeType: string }> | undefined,
    context: UserContext
  ): Promise<ChatResponse> {
    console.log('[Admin] Handling simple request');
    
    const history = this.formatContextForGemini(context.conversationHistory);
    
    // Add context awareness
    let systemPrompt = `You are ORION, a helpful AI assistant. Be concise and accurate.`;
    
    if (context.recentProjects.length > 0) {
      systemPrompt += `\n\nUser Context: Recent projects include ${context.recentProjects.map(p => p.title).join(', ')}.`;
    }
    
    if (context.unfinishedProjects.length > 0) {
      systemPrompt += `\nUnfinished work: ${context.unfinishedProjects.map(p => `"${p.title}" (step ${p.currentStep}/${p.totalSteps})`).join(', ')}.`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    const response = await this.gemini.generateWithNativeTools(
      messages,
      {
        temperature: 0.7,
        useSearch: true,
        useCodeExecution: false,
        thinkingConfig: { thinkingBudget: 4096 },
        maxOutputTokens: 4096,
        images,
      }
    );

    await this.saveMessage('model', response.text);
    
    // Save to memory
    if (this.memoryTool) {
      await this.memoryTool.saveConversationMemory(
        `User: ${message}\nAssistant: ${response.text.substring(0, 500)}`,
        0.5
      );
    }
    
    this.state.waitUntil(this.syncToD1());

    return {
      response: response.text,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: {
        turnsUsed: 1,
        toolsUsed: [
          response.searchResults ? 'google_search' : null,
        ].filter(Boolean) as string[],
      },
    };
  }

  // =============================================================
  // Complex Request Handling (Planning)
  // =============================================================

  private async handleComplexRequest(
    message: string,
    context: UserContext
  ): Promise<ChatResponse> {
    if (!this.planningTool || !Workspace.isInitialized()) {
      const fallbackResponse = `This looks like a complex task requiring structured planning.

However, the workflow system isn't available right now. I can still help you:
1. Break down the task into steps conversationally
2. Provide guidance on each component
3. Help with individual parts

Would you like me to help this way instead?`;
      
      await this.saveMessage('model', fallbackResponse);
      return {
        response: fallbackResponse,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }

    console.log('[Admin] Planning complex task');
    
    try {
      // Call planning tool
      const planningResult = await this.planningTool.createPlan({
        objective: message,
        userPreferences: context.preferences,
      });
      
      if (!planningResult.plan) {
        // No plan needed - task is simpler than expected
        const recommendation = await this.planningTool.formatSimpleRecommendation(
          planningResult.analysis,
          planningResult.recommendedWorkflows
        );
        
        await this.saveMessage('model', recommendation);
        
        return {
          response: recommendation,
          artifacts: [],
          conversationPhase: 'discovery',
          suggestedWorkflows: planningResult.recommendedWorkflows,
          metadata: { turnsUsed: 1, toolsUsed: ['planning_tool'] },
        };
      }
      
      // Present plan for approval
      const planId = `plan_${Date.now()}`;
      const presentation = await this.planningTool.formatPlanForUser(planningResult.plan);
      const fullResponse = `${presentation}\n\n---\n\n✅ **Ready to proceed?** Reply "yes" to start, or provide feedback to adjust the plan.`;
      
      await this.saveMessage('model', fullResponse);
      
      // Enter approval mode
      this.adminState.mode = 'awaiting_plan_approval';
      this.adminState.pendingPlan = planningResult.plan;
      this.adminState.pendingPlanId = planId;
      await this.saveAdminState();
      
      return {
        response: fullResponse,
        artifacts: [],
        conversationPhase: 'discovery',
        suggestedWorkflows: planningResult.recommendedWorkflows,
        metadata: { turnsUsed: 1, toolsUsed: ['planning_tool'] },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const response = `Planning failed: ${errorMsg}

Would you like me to help you with this conversationally instead?`;
      
      await this.saveMessage('model', response);
      
      this.adminState.mode = 'conversational';
      await this.saveAdminState();
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  // Continued in next artifact due to length...
  // src/admin-agent-refactored.ts - Part 2: Execution & Project Management

  // =============================================================
  // Plan Approval Handling
  // =============================================================

  private async handlePlanApproval(message: string): Promise<ChatResponse> {
    console.log('[Admin] Handling plan approval');
    await this.saveMessage('user', message);
    
    const approved = this.detectApproval(message);
    
    if (approved) {
      return await this.executePendingPlan();
    }
    
    // Check for regeneration request
    const needsRevision = message.toLowerCase().includes('change') ||
                          message.toLowerCase().includes('modify') ||
                          message.toLowerCase().includes('different') ||
                          message.toLowerCase().includes('adjust');
    
    if (needsRevision && this.planningTool && this.adminState.pendingPlan) {
      this.metrics.planRegenerations++;
      
      try {
        const adaptedPlan = await this.planningTool.adaptPlan({
          currentPlan: this.adminState.pendingPlan,
          feedback: message,
        });
        
        this.adminState.pendingPlan = adaptedPlan;
        await this.saveAdminState();
        
        const presentation = await this.planningTool.formatPlanForUser(adaptedPlan);
        const response = `${presentation}\n\n---\n\n✅ **How about this revised plan?** Reply "yes" to proceed.`;
        
        await this.saveMessage('model', response);
        
        return {
          response,
          artifacts: [],
          conversationPhase: 'discovery',
          metadata: { turnsUsed: 1, toolsUsed: ['planning_tool'] },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const response = `Failed to revise plan: ${errorMsg}\n\nOptions:\n1. Approve current plan\n2. Provide more specific feedback\n3. Cancel and start over`;
        
        await this.saveMessage('model', response);
        
        return {
          response,
          artifacts: [],
          conversationPhase: 'discovery',
          metadata: { turnsUsed: 1, toolsUsed: [] },
        };
      }
    }
    
    // User is providing feedback or asking questions
    const response = `I understand. To proceed:\n\n✅ **Approve**: Say "yes" or "proceed"\n📝 **Revise**: Tell me what to change\n❌ **Cancel**: Say "cancel" or "start over"\n\nWhat would you like to do?`;
    
    await this.saveMessage('model', response);
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: { turnsUsed: 1, toolsUsed: [] },
    };
  }

  private detectApproval(message: string): boolean {
    const lower = message.toLowerCase().trim();
    return ['yes', 'approve', 'proceed', 'go ahead', 'start', 'begin', 'ok', 'okay', '👍', 'continue', 'let\'s go', 'sounds good']
      .some(kw => lower.includes(kw));
  }

  // =============================================================
  // Execute Pending Plan (Create Project)
  // =============================================================

  private async executePendingPlan(): Promise<ChatResponse> {
    if (!this.adminState.pendingPlan || !this.projectTool) {
      throw new Error('No pending plan or project tool not available');
    }

    console.log('[Admin] Executing approved plan');
    const plan = this.adminState.pendingPlan;
    
    try {
      // Create project (session-agnostic)
      const projectId = await this.projectTool.createProject({
        objective: plan.workflowTitle,
        workflowPlan: plan,
        createdBy: this.userId,
      });
      
      // Record this session
      await this.projectTool.recordSession(projectId, this.sessionId!, 'created');
      
      console.log(`[Admin] ✅ Project created: ${projectId}`);
      this.metrics.projectsCreated++;
      
      // Transition to execution
      this.adminState.mode = 'executing';
      this.adminState.activeProjectId = projectId;
      this.adminState.pendingPlan = undefined;
      this.adminState.pendingPlanId = undefined;
      await this.saveAdminState();
      
      this.broadcastWS({
        type: 'project_created',
        projectId,
        projectPath: `projects/${projectId}`,
      });
      
      const response = `✅ **Project Created!**\n\n**Project ID**: \`${projectId}\`\n\nStarting execution of Step 1...`;
      await this.saveMessage('model', response);
      
      // Start execution
      return await this.executeCurrentStep();
    } catch (error) {
      this.adminState.mode = 'conversational';
      await this.saveAdminState();
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      const response = `Failed to create project: ${errorMsg}\n\nWould you like to try again or modify the plan?`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  // =============================================================
  // Step Execution
  // =============================================================

  private async executeCurrentStep(): Promise<ChatResponse> {
    if (!this.adminState.activeProjectId || !this.projectTool || !this.workflow) {
      throw new Error('No active project or tools not initialized');
    }

    const projectId = this.adminState.activeProjectId;
    const project = await this.projectTool.loadProject(projectId);
    const todo = project.todo;
    
    const currentStep = todo.steps.find(s => s.status === 'pending');
    if (!currentStep) {
      return await this.completeProject(projectId);
    }

    console.log(`[Admin] Executing step ${currentStep.number}`);
    
    this.broadcastWS({
      type: 'step_started',
      stepNumber: currentStep.number,
      stepTitle: currentStep.title,
    });
    
    try {
      await this.projectTool.updateStepStatus(projectId, currentStep.number, 'in_progress');
      
      const result = await this.workflow.executeStepWithAgent(
        `projects/${projectId}`,
        currentStep.number,
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
      
      await this.projectTool.updateStepStatus(projectId, currentStep.number, 'completed');
      this.metrics.stepsCompleted++;
      
      // Check if checkpoint
      if (currentStep.checkpoint) {
        this.metrics.checkpointsReached++;
        return await this.handleCheckpoint(projectId, currentStep, result);
      }
      
      // Auto-continue to next step
      this.broadcastWS({
        type: 'step_complete',
        stepNumber: currentStep.number,
        stepTitle: currentStep.title,
        outputs: result.outputs || [],
        nextStepReady: true,
      });
      
      await this.projectTool.incrementStep(projectId);
      
      return await this.executeCurrentStep();
    } catch (error) {
      return await this.handleStepFailure(projectId, currentStep.number, error);
    }
  }

  // =============================================================
  // Checkpoint Handling
  // =============================================================

  private async handleCheckpoint(
    projectId: string,
    step: any,
    result: any
  ): Promise<ChatResponse> {
    if (!this.projectTool) throw new Error('ProjectTool not initialized');

    // Save checkpoint
    await this.projectTool.saveCheckpoint(projectId, {
      stepNumber: step.number,
      result,
      timestamp: Date.now(),
    });
    
    const presentation = this.formatCheckpointResults(step, result);
    await this.saveMessage('model', presentation);
    
    // Enter checkpoint review mode
    this.adminState.mode = 'checkpoint_review';
    this.adminState.checkpointData = {
      projectId,
      stepNumber: step.number,
      results: result,
    };
    await this.saveAdminState();
    
    this.broadcastWS({
      type: 'step_complete',
      stepNumber: step.number,
      stepTitle: step.title,
      outputs: result.outputs || [],
      nextStepReady: false,
    });
    
    return {
      response: presentation,
      artifacts: [],
      conversationPhase: 'execution',
      activeProject: await this.getActiveProjectInfo(projectId),
      metadata: {
        turnsUsed: 1,
        toolsUsed: [`agent:${result.metadata.agentId}`],
      },
    };
  }

  private async handleCheckpointReview(message: string): Promise<ChatResponse> {
    console.log('[Admin] Checkpoint review');
    await this.saveMessage('user', message);
    
    if (!this.adminState.checkpointData || !this.projectTool) {
      throw new Error('No checkpoint data');
    }

    const { projectId, stepNumber } = this.adminState.checkpointData;
    const approved = this.detectApproval(message);
    
    if (approved) {
      // Continue to next step
      const project = await this.projectTool.loadProject(projectId);
      const nextStep = project.todo.steps.find(s => s.status === 'pending');
      
      this.adminState.mode = 'executing';
      this.adminState.checkpointData = undefined;
      await this.saveAdminState();
      
      if (nextStep) {
        await this.projectTool.incrementStep(projectId);
        const response = `✅ Continuing to Step ${nextStep.number}...`;
        await this.saveMessage('model', response);
        return await this.executeCurrentStep();
      } else {
        return await this.completeProject(projectId);
      }
    }
    
    const lower = message.toLowerCase();
    
    if (lower.includes('retry') || lower.includes('redo')) {
      // Retry current step
      await this.projectTool.updateStepStatus(projectId, stepNumber, 'pending');
      
      this.adminState.mode = 'executing';
      this.adminState.checkpointData = undefined;
      await this.saveAdminState();
      
      const response = `♻️ Retrying Step ${stepNumber}...`;
      await this.saveMessage('model', response);
      
      return await this.executeCurrentStep();
    }
    
    if (lower.includes('skip')) {
      // Skip to next step
      await this.projectTool.updateStepStatus(projectId, stepNumber, 'skipped', 'Skipped by user');
      await this.projectTool.incrementStep(projectId);
      
      this.adminState.mode = 'executing';
      this.adminState.checkpointData = undefined;
      await this.saveAdminState();
      
      const response = `⏭️ Skipping Step ${stepNumber}...`;
      await this.saveMessage('model', response);
      
      return await this.executeCurrentStep();
    }
    
    // User asking questions or providing feedback
    const response = `Options:\n✅ **Continue**: Proceed to next step\n♻️ **Retry**: Re-execute current step\n⏭️ **Skip**: Skip and move on\n❌ **Stop**: Pause workflow\n\nWhat would you like?`;
    
    await this.saveMessage('model', response);
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'execution',
      metadata: { turnsUsed: 1, toolsUsed: [] },
    };
  }

  // =============================================================
  // Execution Commands
  // =============================================================

  private async handleExecutionCommands(message: string): Promise<ChatResponse> {
    const lower = message.toLowerCase().trim();
    
    if (lower.includes('stop') || lower.includes('pause') || lower.includes('cancel')) {
      return await this.pauseExecution();
    }
    
    if (lower.includes('status') || lower.includes('progress')) {
      return await this.getExecutionStatus();
    }
    
    // Default: show status
    return await this.getExecutionStatus();
  }

  private async pauseExecution(): Promise<ChatResponse> {
    if (!this.adminState.activeProjectId || !this.projectTool) {
      throw new Error('No active project');
    }

    const projectId = this.adminState.activeProjectId;
    await this.projectTool.updateProjectStatus(projectId, 'paused');
    
    const response = `⏸️ **Execution Paused**\n\n**Project**: \`${projectId}\`\n\nYou can resume anytime by saying "continue project ${projectId}" or simply "continue".`;
    
    await this.saveMessage('model', response);
    
    this.adminState.mode = 'conversational';
    this.adminState.activeProjectId = undefined;
    await this.saveAdminState();
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: { turnsUsed: 1, toolsUsed: [] },
    };
  }

  private async getExecutionStatus(): Promise<ChatResponse> {
    if (!this.adminState.activeProjectId || !this.projectTool) {
      return {
        response: 'No active execution.',
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }

    const projectId = this.adminState.activeProjectId;
    const project = await this.projectTool.loadProject(projectId);
    const todo = project.todo;
    
    const completed = todo.steps.filter(s => s.status === 'completed').length;
    const currentStep = todo.steps.find(s => s.status === 'in_progress' || s.status === 'pending');
    
    const response = `📊 **Execution Status**\n\n**Project**: ${project.metadata.title}\n**Progress**: ${completed}/${todo.steps.length} steps completed\n**Current**: ${currentStep ? `Step ${currentStep.number} - ${currentStep.title}` : 'Completed'}\n\nReply "continue" to proceed, or "pause" to stop.`;
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'execution',
      activeProject: await this.getActiveProjectInfo(projectId),
      metadata: { turnsUsed: 1, toolsUsed: ['project_tool'] },
    };
  }

  // =============================================================
  // Project Continuation
  // =============================================================

  async continueProject(projectId: string): Promise<ChatResponse> {
    if (!this.projectTool || !this.memoryTool) {
      throw new Error('Tools not initialized');
    }

    console.log(`[Admin] Continuing project: ${projectId}`);
    
    try {
      const project = await this.projectTool.loadProject(projectId);
      
      // Record resumption
      await this.projectTool.recordSession(projectId, this.sessionId!, 'resumed');
      
      // Update status if paused
      if (project.metadata.status === 'paused') {
        await this.projectTool.updateProjectStatus(projectId, 'active');
      }
      
      // Get context
      const context = await this.memoryTool.getProjectContext(projectId);
      
      // Update admin state
      this.adminState.mode = 'executing';
      this.adminState.activeProjectId = projectId;
      await this.saveAdminState();
      
      const response = `🔄 **Resuming Project**\n\n${context}\n\nContinuing execution...`;
      await this.saveMessage('model', response);
      
      // Resume execution
      return await this.executeCurrentStep();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const response = `Failed to continue project: ${errorMsg}`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  // =============================================================
  // Project Completion
  // =============================================================

  private async completeProject(projectId: string): Promise<ChatResponse> {
    if (!this.projectTool) throw new Error('ProjectTool not initialized');

    const project = await this.projectTool.loadProject(projectId);
    const completed = project.todo.steps.filter(s => s.status === 'completed').length;
    
    await this.projectTool.updateProjectStatus(projectId, 'completed');
    await this.projectTool.recordSession(projectId, this.sessionId!, 'completed');
    
    // Index artifacts for future reference
    if (this.memoryTool) {
      await this.memoryTool.indexProjectArtifacts(projectId);
    }
    
    this.adminState.mode = 'conversational';
    this.adminState.activeProjectId = undefined;
    await this.saveAdminState();
    
    const response = `🎉 **Project Complete!**\n\n**${project.metadata.title}**\n\n**Completed**: ${completed}/${project.todo.steps.length} steps\n**Project ID**: \`${projectId}\`\n\nAll deliverables saved to \`projects/${projectId}/results/\`.\n\nWhat's next?`;
    
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
      metadata: { turnsUsed: 1, toolsUsed: ['project_tool'] },
    };
  }

  // =============================================================
  // Error Handling
  // =============================================================

  private async handleStepFailure(
    projectId: string,
    stepNumber: number,
    error: unknown
  ): Promise<ChatResponse> {
    if (!this.projectTool) throw new Error('ProjectTool not initialized');

    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Admin] Step ${stepNumber} failed:`, errorMsg);
    
    await this.projectTool.updateStepStatus(
      projectId,
      stepNumber,
      'pending',
      `Failed: ${errorMsg}`
    );
    
    this.metrics.planRegenerations++;
    
    const response = `⚠️ **Step ${stepNumber} Failed**\n\nError: ${errorMsg}\n\nOptions:\n♻️ **Retry**: Try step again\n📝 **Replan**: Regenerate workflow from this point\n⏭️ **Skip**: Skip and continue\n❌ **Stop**: Pause workflow\n\nWhat would you like?`;
    
    await this.saveMessage('model', response);
    
    this.broadcastWS({
      type: 'error',
      error: errorMsg,
    });
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'execution',
      metadata: { turnsUsed: 1, toolsUsed: [] },
    };
  }

  // Continued in next artifact...
  // src/admin-agent-refactored.ts - Part 3: RPC Methods & Helpers

  // =============================================================
  // Project Management RPC Methods
  // =============================================================

  async listProjects(filters?: ProjectFilters): Promise<{ projects: ProjectMetadata[] }> {
    await this.init();
    
    if (!this.projectTool) {
      return { projects: [] };
    }

    try {
      const projects = await this.projectTool.listProjects(filters || {});
      return { projects };
    } catch (error) {
      console.error('[Admin] List projects failed:', error);
      return { projects: [] };
    }
  }

  async getProject(projectId: string): Promise<{ project: ProjectMetadata }> {
    await this.init();
    
    if (!this.projectTool) {
      throw new Error('ProjectTool not initialized');
    }

    const project = await this.projectTool.getProject(projectId);
    return { project };
  }

  // =============================================================
  // Session Management RPC Methods
  // =============================================================

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    
    try {
      await this.storage.clearAll();
      this.adminState = { mode: 'conversational' };
      await this.saveAdminState();
      
      console.log('[Admin] Cleared session data');
      return { ok: true };
    } catch (error) {
      console.error('[Admin] Clear failed:', error);
      throw error;
    }
  }

  // =============================================================
  // File Management RPC Methods
  // =============================================================

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

  // =============================================================
  // Status RPC Method
  // =============================================================

  async getStatus(): Promise<StatusResponse> {
    await this.init();
    
    try {
      const agentCount = this.workflow 
        ? (await this.workflow.getAgentRegistry().listAllAgents()).length
        : 0;
      
      const workflowCount = this.workflow 
        ? (await this.workflow.listAllTemplates()).length
        : 0;
      
      // Get project lists
      let recentProjects: ProjectMetadata[] = [];
      let unfinishedProjects: ProjectMetadata[] = [];
      let activeProject: any = undefined;
      
      if (this.projectTool) {
        recentProjects = await this.projectTool.getRecentProjects(this.userId, 5);
        unfinishedProjects = await this.projectTool.getUnfinishedProjects(this.userId);
        
        if (this.adminState.activeProjectId) {
          activeProject = await this.getActiveProjectInfo(this.adminState.activeProjectId);
        }
      }
      
      return {
        sessionId: this.sessionId,
        userId: this.userId,
        messageCount: this.storage.getMessages().length,
        conversationPhase: this.adminState.mode === 'conversational' ? 'discovery' :
                           this.adminState.mode === 'executing' ? 'execution' : 'delivery',
        activeProject,
        protocol: 'Session-Agnostic Multi-Agent System',
        metrics: { 
          ...this.metrics, 
          availableAgents: agentCount, 
          availableWorkflows: workflowCount 
        } as any,
        workspace: { 
          enabled: Workspace.isInitialized(), 
          initialized: Workspace.isInitialized(),
          projectCount: recentProjects.length,
        },
        availableWorkflows: workflowCount,
        recentProjects,
        unfinishedProjects,
      };
    } catch (error) {
      console.error('[Admin] Get status failed:', error);
      throw error;
    }
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private async handleProjectSelectionForContinuation(
    context: UserContext
  ): Promise<ChatResponse> {
    if (context.unfinishedProjects.length === 0) {
      const response = `You don't have any unfinished projects. Would you like to:\n\n1. Start a new project\n2. Review completed projects\n3. Ask me something else`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }

    const projectsList = context.unfinishedProjects
      .map((p, i) => `${i + 1}. **${p.title}** (Step ${p.currentStep}/${p.totalSteps}) - ID: \`${p.projectId}\``)
      .join('\n');

    const response = `You have ${context.unfinishedProjects.length} unfinished project(s):\n\n${projectsList}\n\nWhich one would you like to continue? Reply with the project number or ID.`;
    
    await this.saveMessage('model', response);
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: { turnsUsed: 1, toolsUsed: ['project_tool'] },
    };
  }

  private async handleProjectQuery(
    message: string,
    context: UserContext
  ): Promise<ChatResponse> {
    if (!this.projectTool || !this.memoryTool) {
      throw new Error('Tools not initialized');
    }

    // Search across projects
    const results = await this.memoryTool.searchAcrossProjects(message, 5);
    
    if (results.length === 0) {
      const response = `I couldn't find any projects matching "${message}". Your recent projects:\n\n${context.recentProjects.map(p => `- ${p.title} (${p.status})`).join('\n')}`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: ['memory_tool'] },
      };
    }

    const projectsList = results
      .map(r => `**${r.title}**\nID: \`${r.projectId}\`\nRelevance: ${r.relevance}`)
      .join('\n\n');

    const response = `Found ${results.length} relevant project(s):\n\n${projectsList}\n\nWould you like details on any of these?`;
    
    await this.saveMessage('model', response);
    
    return {
      response,
      artifacts: [],
      conversationPhase: 'discovery',
      metadata: { turnsUsed: 1, toolsUsed: ['memory_tool', 'project_tool'] },
    };
  }

  private async querySpecificProject(
    projectId: string,
    message: string
  ): Promise<ChatResponse> {
    if (!this.projectTool || !this.memoryTool) {
      throw new Error('Tools not initialized');
    }

    try {
      const project = await this.projectTool.loadProject(projectId);
      const context = await this.memoryTool.getProjectContext(projectId);
      
      // Use Gemini to answer the question with project context
      const prompt = `Answer this question about the project:

**Project**: ${project.metadata.title}
**Question**: ${message}

**Project Context**:
${context}

**Todo**:
${project.todo.steps.map(s => `Step ${s.number}: ${s.title} (${s.status})`).join('\n')}

Provide a helpful answer based on the project information.`;

      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.5,
          maxOutputTokens: 2048,
        }
      );

      await this.saveMessage('model', response.text);
      
      return {
        response: response.text,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: ['project_tool', 'gemini'] },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const response = `Failed to query project: ${errorMsg}`;
      
      await this.saveMessage('model', response);
      
      return {
        response,
        artifacts: [],
        conversationPhase: 'discovery',
        metadata: { turnsUsed: 1, toolsUsed: [] },
      };
    }
  }

  private async getActiveProjectInfo(projectId: string): Promise<any> {
    if (!this.projectTool) return undefined;

    try {
      const project = await this.projectTool.loadProject(projectId);
      return {
        projectId,
        projectPath: `projects/${projectId}`,
        workflowId: project.metadata.workflowId,
        currentStep: project.metadata.currentStep,
        totalSteps: project.metadata.totalSteps,
        createdAt: project.metadata.createdAt,
        updatedAt: project.metadata.updatedAt,
      };
    } catch {
      return undefined;
    }
  }

  private formatCheckpointResults(step: any, result: any): string {
    return `🚦 **Checkpoint: Step ${step.number}**\n\n**${step.title}**\n\nAgent: \`${result.metadata.agentId}\`\nTokens: ${result.metadata.tokensUsed}\nLatency: ${result.metadata.latency}ms\n\n**Results**:\n${this.formatOutputs(result.outputs)}\n\n---\n\n✅ Reply "continue" to proceed, or provide feedback.`;
  }

  private formatOutputs(outputs: any): string {
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

        case 'continue_project':
          if (msg.projectId) {
            const result = await this.continueProject(msg.projectId);
            this.sendWS(ws, { type: 'complete', response: result.response, artifacts: result.artifacts });
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
