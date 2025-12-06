// src/durable-agent-v2.ts - Complete Final Version with Workspace Fix

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  Env,
  Message,
  Artifact,
  WSOutgoingMessage,
  WSIncomingMessage,
  OrionRPC,
  ChatResponse,
  StatusResponse,
  FileMetadata,
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { buildAdminSystemPrompt } from './prompts/admin-system-prompt';
import { WorkerFactory } from './workers/specialized-workers';
import { AdminToolRegistry } from './tools-v2/tool-registry';
import { PhaseManager, type ConversationPhase } from './core/phase-manager';
import { Workspace } from './workspace/workspace';
import type { ToolResult } from './tools-v2/tool-types';

/**
 * ORION Agent - Complete Final Version with Admin-Worker Architecture
 * 
 * Architecture:
 * - Admin Agent: Orchestration via function calling
 * - Worker Agents: Execution via native tools
 * - Phase Manager: Explicit conversation state machine
 * - B2 Workspace: Persistent file storage (properly initialized)
 * - Clear separation of concerns
 * 
 * Key Fix: Workspace is now initialized BEFORE tool registry creation
 */
export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private initialized = false;
  private workspaceEnabled = false;
  
  private workerFactory!: WorkerFactory;
  private toolRegistry!: AdminToolRegistry;
  private phaseManager!: PhaseManager;
  private adminSystemPrompt: string;
  
  private metrics = {
    totalRequests: 0,
    adminTurns: 0,
    workerDelegations: 0,
    toolCalls: 0,
    totalTokens: 0,
    phaseTransitions: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.adminSystemPrompt = buildAdminSystemPrompt();
    
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
    
    console.log('[AgentV2] Starting initialization...');
    
    // Initialize D1
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
      console.log('[AgentV2] ✅ D1 initialized');
    }
    
    // Initialize Memory (Vectorize)
    if (this.sessionId) {
      if (this.env.VECTORIZE) {
        this.memory = new MemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId,
          this.storage.getDurableObjectState().storage,
          {}
        );
        console.log('[AgentV2] ✅ Memory/Vectorize initialized');
      }
      
      // Hydrate from D1
      if (this.d1 && this.storage.getMessages().length === 0) {
        await this.hydrateFromD1();
      }

      // Schedule periodic D1 sync
      await this.storage.setAlarm(Date.now() + 300000);
    }
    
    // ===== CRITICAL: Initialize B2 Workspace BEFORE creating tools =====
    const workspaceConfigured = this.isWorkspaceConfigured();
    
    if (workspaceConfigured) {
      try {
        console.log('[AgentV2] Initializing B2 Workspace...');
        console.log('[AgentV2] B2 Config:', {
          hasKeyId: !!this.env.B2_KEY_ID,
          hasAppKey: !!this.env.B2_APPLICATION_KEY,
          endpoint: this.env.B2_S3_ENDPOINT,
          bucket: this.env.B2_BUCKET,
          basePath: this.env.B2_BASE_PATH || '(none)'
        });
        
        Workspace.initialize(this.env);
        
        // Verify initialization succeeded
        if (Workspace.isInitialized()) {
          this.workspaceEnabled = true;
          console.log('[AgentV2] ✅ B2 Workspace initialized successfully');
          
          // Test workspace by ensuring tasks directory exists
          try {
            const config = Workspace.getConfig();
            console.log('[AgentV2] Workspace config:', {
              endpoint: config.endpoint,
              bucket: config.bucket,
              basePath: config.basePath
            });
            
            // Create tasks directory if it doesn't exist
            const tasksExists = await Workspace.exists('tasks');
            if (!tasksExists) {
              await Workspace.mkdir('tasks');
              console.log('[AgentV2] Created tasks directory');
            }
          } catch (testError) {
            console.error('[AgentV2] ⚠️  Workspace test failed:', testError);
            // Don't throw - allow system to continue with workspace disabled
            this.workspaceEnabled = false;
          }
        } else {
          console.error('[AgentV2] ❌ Workspace.isInitialized() returned false after initialize()');
          this.workspaceEnabled = false;
        }
      } catch (error) {
        console.error('[AgentV2] ❌ B2 Workspace initialization failed:', error);
        console.error('[AgentV2] Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        this.workspaceEnabled = false;
      }
    } else {
      console.warn('[AgentV2] ⚠️  B2 Workspace not configured');
      console.warn('[AgentV2] Missing environment variables. Required:');
      console.warn('  - B2_KEY_ID:', this.env.B2_KEY_ID ? 'SET' : 'MISSING');
      console.warn('  - B2_APPLICATION_KEY:', this.env.B2_APPLICATION_KEY ? 'SET' : 'MISSING');
      console.warn('  - B2_S3_ENDPOINT:', this.env.B2_S3_ENDPOINT ? 'SET' : 'MISSING');
      console.warn('  - B2_BUCKET:', this.env.B2_BUCKET ? 'SET' : 'MISSING');
      this.workspaceEnabled = false;
    }
    
    // Initialize core components (AFTER workspace initialization)
    this.workerFactory = new WorkerFactory(this.gemini);
    this.toolRegistry = new AdminToolRegistry(
      this.gemini,
      this.memory || null,
      this.workerFactory
    );
    this.phaseManager = new PhaseManager('discovery');
    
    this.initialized = true;
    console.log('[AgentV2] ✅ Initialization complete:', {
      workspace: this.workspaceEnabled ? 'enabled' : 'disabled',
      memory: this.memory ? 'enabled' : 'disabled',
      d1: this.d1 ? 'enabled' : 'disabled',
      tools: this.toolRegistry.getToolNames().length
    });
  }

  /**
   * Check if B2 workspace environment variables are configured
   */
  private isWorkspaceConfigured(): boolean {
    return !!(
      this.env.B2_KEY_ID &&
      this.env.B2_APPLICATION_KEY &&
      this.env.B2_S3_ENDPOINT &&
      this.env.B2_BUCKET
    );
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
      console.log(`[AgentV2] Hydrated ${messages.length} messages from D1`);
    } catch (e) {
      console.warn('[AgentV2] Hydration failed:', e);
    }
  }

  // =============================================================
  // Alarm Handler (D1 Sync)
  // =============================================================

  async alarm(): Promise<void> {
    console.log('[AgentV2] ⏰ Alarm triggered - syncing to D1');
    
    try {
      await this.syncToD1();
    } catch (err) {
      console.error('[AgentV2] Alarm sync failed:', err);
    }
    
    await this.storage.setAlarm(Date.now() + 300000);
  }

  // =============================================================
  // RPC Interface Implementation
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
    
    const result = await this.executeAdminLoop(message, images);
    
    // Sync to D1 in background
    if (this.d1 && this.sessionId) {
      this.state.waitUntil(
        this.syncToD1().catch(err => {
          console.error('[AgentV2] Background D1 sync failed:', err);
        })
      );
    }
    
    return result;
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: Artifact[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    this.phaseManager = new PhaseManager('discovery');
    return { ok: true };
  }

  async uploadFile(
    base64: string,
    mimeType: string,
    name: string
  ): Promise<{ success: boolean; file: FileMetadata }> {
    await this.init();
    const metadata = await this.gemini.uploadFile(base64, mimeType, name);
    return { success: true, file: metadata };
  }

  async listFiles(): Promise<{ files: FileMetadata[] }> {
    await this.init();
    const files = await this.gemini.listFiles();
    return { files };
  }

  async deleteFile(fileUri: string): Promise<{ ok: boolean }> {
    await this.init();
    await this.gemini.deleteFile(fileUri);
    return { ok: true };
  }

  async getStatus(): Promise<StatusResponse> {
    await this.init();
    
    const phaseContext = this.phaseManager.getContext();
    
    return {
      sessionId: this.sessionId,
      messageCount: this.storage.getMessages().length,
      artifactCount: this.storage.getArtifacts().length,
      conversationPhase: phaseContext.currentPhase,
      protocol: 'Admin-Worker Architecture v2.1',
      metrics: {
        ...this.metrics,
        phaseTransitions: phaseContext.history.length
      } as any,
      nativeTools: {
        googleSearch: false,
        codeExecution: false,
        fileSearch: false,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
      workspace: { 
        enabled: this.workspaceEnabled,
        initialized: Workspace.isInitialized(),
        configured: this.isWorkspaceConfigured()
      },
      availableWorkflows: 0,
      activeProject: phaseContext.activeTaskId ? {
        projectId: phaseContext.activeTaskId,
        projectPath: `tasks/${phaseContext.activeTaskId}`,
        currentStep: phaseContext.currentStepNumber || 0,
        totalSteps: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      } : undefined
    } as StatusResponse;
  }

  // Placeholder implementations for v1 compatibility
  async executeStep(): Promise<any> {
    throw new Error('executeStep not implemented in v2 architecture');
  }
  async getProjects(): Promise<any> {
    return { projects: [] };
  }
  async listWorkflows(): Promise<any> {
    return { workflows: [] };
  }
  async searchWorkflows(): Promise<any> {
    return { workflows: [] };
  }
  async createProjectFromWorkflow(): Promise<any> {
    throw new Error('createProjectFromWorkflow not implemented in v2');
  }

  // =============================================================
  // WebSocket Support
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
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
    // @ts-ignore
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    
    try {
      const msg: WSIncomingMessage = JSON.parse(message);
      
      if (msg.type === 'user_message') {
        await this.handleWebSocketChat(ws, msg.content, msg.images);
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' } as WSOutgoingMessage));
      }
    } catch (e) {
      console.error('[AgentV2] WebSocket error:', e);
      ws.send(
        JSON.stringify({
          type: 'error',
          error: e instanceof Error ? e.message : String(e),
        } as WSOutgoingMessage)
      );
    }
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  private async handleWebSocketChat(
    ws: WebSocket,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    await this.init();
    
    const callbacks = {
      onStatus: (msg: string) =>
        ws.send(JSON.stringify({ type: 'status', message: msg } as WSOutgoingMessage)),
      onThought: (thought: string) =>
        ws.send(JSON.stringify({ type: 'thought', content: thought } as WSOutgoingMessage)),
      onChunk: (chunk: string) =>
        ws.send(JSON.stringify({ type: 'chunk', content: chunk } as WSOutgoingMessage)),
      onToolUse: (tool: string, params: any) =>
        ws.send(JSON.stringify({ type: 'tool_use', tool, params } as WSOutgoingMessage)),
      onArtifact: (artifact: Artifact) =>
        ws.send(JSON.stringify({ type: 'artifact', artifact } as WSOutgoingMessage)),
    };
    
    try {
      const result = await this.executeAdminLoop(message, images, callbacks);
      
      ws.send(
        JSON.stringify({
          type: 'complete',
          response: result.response,
          artifacts: result.artifacts,
          metadata: result.metadata,
        } as WSOutgoingMessage)
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        } as WSOutgoingMessage)
      );
    }
  }

  // =============================================================
  // Core Admin Loop with Phase Management
  // =============================================================

  private async executeAdminLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onStatus?: (msg: string) => void;
      onThought?: (thought: string) => void;
      onChunk?: (chunk: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<ChatResponse> {
    let turn = 0;
    const maxTurns = 10;
    const artifacts: Artifact[] = [];
    const toolsUsed = new Set<string>();
    
    try {
      // Save user message
      await this.saveMessage('user', userMessage);
      
      // Get current phase context
      const currentPhase = this.phaseManager.getCurrentPhase();
      callbacks?.onStatus?.(`Phase: ${currentPhase}`);
      
      // Build conversation context with phase awareness
      const systemPrompt = this.buildPhaseAwareSystemPrompt(currentPhase);
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...this.formatContextForGemini(this.storage.getMessages().slice(-10)),
        { role: 'user', content: userMessage }
      ];
      
      // Admin loop with function calling
      while (turn < maxTurns) {
        turn++;
        this.metrics.adminTurns++;
        
        callbacks?.onStatus?.(`Admin coordinating (turn ${turn}/${maxTurns})...`);
        
        const response = await this.gemini.generateWithNativeTools(
          messages,
          {
            tools: this.toolRegistry.getFunctionDeclarations(),
            stream: true,
            temperature: 0.8,
            thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
            useSearch: false,
            useCodeExecution: false,
            maxOutputTokens: 8192,
          },
          callbacks?.onChunk,
          callbacks?.onThought
        );
        
        if (response.usageMetadata) {
          this.metrics.totalTokens += response.usageMetadata.totalTokens || 0;
        }
        
        messages.push({ role: 'assistant', content: response.text });
        await this.saveMessage('model', response.text);
        
        // Process function calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolResults: Array<{ name: string; result: ToolResult }> = [];
          let userInputRequired = false;
          
          for (const toolCall of response.toolCalls) {
            this.metrics.toolCalls++;
            toolsUsed.add(toolCall.name);
            callbacks?.onToolUse?.(toolCall.name, toolCall.args);
            
            const result = await this.toolRegistry.executeTool(
              toolCall.name,
              toolCall.args
            );
            
            toolResults.push({ name: toolCall.name, result });
            
            // Handle phase transitions based on tool results
            this.handlePhaseTransitions(toolCall.name, result);
            
            // Collect artifacts from worker results
            if (toolCall.name === 'delegate_to_worker' && result.success) {
              this.metrics.workerDelegations++;
              const workerResult = result.data;
              if (workerResult?.artifacts) {
                artifacts.push(...workerResult.artifacts);
                workerResult.artifacts.forEach(a => callbacks?.onArtifact?.(a));
              }
            }
            
            // Check if user input required
            if (this.toolRegistry.isUserInputRequired(toolCall.name, result)) {
              userInputRequired = true;
            }
          }
          
          // If ask_user was called, return immediately
          if (userInputRequired) {
            const askResult = toolResults.find(r => r.name === 'ask_user');
            return {
              response: askResult?.result.summary || 'Please provide more information.',
              artifacts,
              conversationPhase: this.phaseManager.getCurrentPhase(),
              metadata: {
                turnsUsed: turn,
                toolsUsed: Array.from(toolsUsed),
              }
            };
          }
          
          // Feed results back to admin (proper FunctionResponse format)
          const feedbackMessage = this.formatToolResults(toolResults);
          messages.push({ role: 'function', content: feedbackMessage });
          await this.saveMessage('user', feedbackMessage);
          
        } else {
          // Admin provided final response (no more tool calls)
          return {
            response: response.text,
            artifacts,
            conversationPhase: this.phaseManager.getCurrentPhase(),
            metadata: {
              turnsUsed: turn,
              toolsUsed: Array.from(toolsUsed),
              thinkingTokens: response.usageMetadata?.totalTokens,
            }
          };
        }
      }
      
      // Max turns reached
      const finalMessage = messages[messages.length - 1].content;
      return {
        response: finalMessage || 'Processing complete.',
        artifacts,
        conversationPhase: this.phaseManager.getCurrentPhase(),
        metadata: {
          turnsUsed: turn,
          toolsUsed: Array.from(toolsUsed),
        }
      };
      
    } catch (error) {
      console.error('[AgentV2] Admin loop error:', error);
      return {
        response: `Error: ${error instanceof Error ? error.message : String(error)}`,
        artifacts,
        conversationPhase: this.phaseManager.getCurrentPhase(),
        metadata: {
          turnsUsed: turn,
          toolsUsed: Array.from(toolsUsed),
        }
      };
    }
  }

  // =============================================================
  // Phase Management
  // =============================================================

  private buildPhaseAwareSystemPrompt(phase: ConversationPhase): string {
    const basePrompt = this.adminSystemPrompt;
    
    const workspaceStatus = this.workspaceEnabled 
      ? 'WORKSPACE: ✅ Available - Use planned_tasks and artifact_tool for persistent storage'
      : 'WORKSPACE: ❌ Not available - Task management disabled (B2 not configured)';
    
    const phaseGuidance: Record<ConversationPhase, string> = {
      discovery: `
CURRENT PHASE: DISCOVERY
${workspaceStatus}
Focus on understanding user intent and gathering context.
- Use web_search for quick lookups
- Use rag_search to find similar past tasks
- Use ask_user to clarify requirements
- For simple tasks: delegate directly
- For complex tasks: ${this.workspaceEnabled ? 'transition to planning with planned_tasks(new_task)' : 'break down into steps and execute'}
`,
      planning: `
CURRENT PHASE: PLANNING
${workspaceStatus}
Create structured task plans with clear steps.
${this.workspaceEnabled ? `
- Use rag_search(sources=['tasks']) to find similar task templates
- Create todo.json with planned_tasks(new_task)
- Break down into clear, delegatable steps
- Assign appropriate worker types to each step
- Once plan is ready: transition to execution
` : 'Note: Workspace unavailable - provide planning guidance to user'}
`,
      execution: `
CURRENT PHASE: EXECUTION
${workspaceStatus}
Execute task steps systematically via workers.
${this.workspaceEnabled ? `
- Load active task with planned_tasks(load_task)
- Delegate current step with delegate_to_worker
- Save artifacts with artifact_tool(write)
- Update progress with planned_tasks(update_task)
- After each step: transition to review if checkpoint
- When all steps complete: transition to delivery
` : 'Execute tasks in conversation without persistent storage'}
`,
      review: `
CURRENT PHASE: REVIEW
${workspaceStatus}
Validate step outputs and gather user feedback.
- Present step results clearly
- Use ask_user for validation if needed
- If approved: transition back to execution for next step
- If complete: transition to delivery
`,
      delivery: `
CURRENT PHASE: DELIVERY
${workspaceStatus}
Present final results and prepare for next task.
- Summarize all outputs and artifacts
- Highlight key achievements
- Offer next steps
- After delivery: transition to discovery for new tasks
`
    };
    
    return basePrompt + '\n\n' + phaseGuidance[phase];
  }

  private handlePhaseTransitions(toolName: string, result: ToolResult): void {
    // Auto-transition based on tool usage
    const currentPhase = this.phaseManager.getCurrentPhase();
    
    if (toolName === 'planned_tasks' && result.success) {
      const action = result.metadata?.action || result.data?.action;
      
      if (action === 'new_task' && currentPhase === 'planning') {
        this.phaseManager.transitionTo('execution', 'Task plan created');
        this.phaseManager.setActiveTask(result.data.taskId, 1);
        this.metrics.phaseTransitions++;
      }
      
      if (action === 'update_task') {
        const taskStatus = result.metadata?.taskStatus;
        if (taskStatus === 'completed' && currentPhase === 'execution') {
          this.phaseManager.transitionTo('delivery', 'All steps completed');
          this.metrics.phaseTransitions++;
        }
      }
    }
    
    if (toolName === 'delegate_to_worker' && result.success) {
      // After worker delegation, move to review if checkpoint
      // This would need step context to determine
    }
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private formatToolResults(
    toolResults: Array<{ name: string; result: ToolResult }>
  ): string {
    // Format as proper FunctionResponse
    const responses = toolResults.map(({ name, result }) => ({
      name,
      response: {
        success: result.success,
        data: result.data,
        summary: result.summary,
        metadata: result.metadata
      }
    }));
    
    return JSON.stringify({ functionResponses: responses }, null, 2);
  }

  private formatContextForGemini(
    messages: Message[]
  ): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: this.extractMessageContent(msg),
    }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) {
      return (msg as any).parts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');
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
        console.log(`[AgentV2] ✅ Synced ${newMessages.length} messages to D1`);
      }
      
      const artifacts = this.storage.getArtifacts();
      for (const artifact of artifacts) {
        await this.d1.saveArtifact(this.sessionId, artifact);
      }
    } catch (err) {
      console.error('[AgentV2] D1 sync failed:', err);
      throw err;
    }
  }
}

export default OrionAgent;
