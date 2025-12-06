// src/tools-v2/tool-registry.ts - Fixed with Workspace Availability

import type { GeminiClient } from '../gemini';
import type { MemoryManager } from '../memory/memory-manager';
import type { WorkerFactory } from '../workers/specialized-workers';
import type { AdminTool, ToolResult } from './tool-types';

// Import all admin tools
import { WebSearchTool } from './web-search-tool';
import { RAGSearchTool } from './rag-search-tool';
import { AskUserTool } from './ask-user-tool';
import { DelegateToWorkerTool } from './delegate-worker-tool';
import { PlannedTasksTool } from './planned-tasks-tool';
import { ArtifactTool } from './artifact-tool';

/**
 * Registry for Admin Agent Tools
 * 
 * Manages function declarations and execution of admin-level tools.
 * Now properly handles workspace availability.
 */
export class AdminToolRegistry {
  private tools: Map<string, AdminTool>;
  private gemini: GeminiClient;
  private memory: MemoryManager | null;
  private workerFactory: WorkerFactory;
  private workspaceEnabled: boolean;

  constructor(
    gemini: GeminiClient,
    memory: MemoryManager | null,
    workerFactory: WorkerFactory,
    workspaceEnabled: boolean = false  // NEW: Pass workspace availability
  ) {
    this.gemini = gemini;
    this.memory = memory;
    this.workerFactory = workerFactory;
    this.workspaceEnabled = workspaceEnabled;
    this.tools = new Map();
    
    this.registerTools();
    
    console.log('[AdminToolRegistry] Initialized with tools:', {
      toolCount: this.tools.size,
      workspaceEnabled: this.workspaceEnabled,
      tools: Array.from(this.tools.keys())
    });
  }

  private registerTools(): void {
    // Core coordination tools (always available)
    this.tools.set('web_search', new WebSearchTool(this.gemini));
    this.tools.set('ask_user', new AskUserTool());
    this.tools.set('delegate_to_worker', new DelegateToWorkerTool(
      this.workerFactory,
      this.workspaceEnabled  // Pass flag to delegate tool too
    ));
    
    // Memory-dependent tools
    if (this.memory) {
      this.tools.set('rag_search', new RAGSearchTool(this.memory));
    }
    
    // Workspace-dependent tools (pass availability flag)
    this.tools.set('planned_tasks', new PlannedTasksTool(this.workspaceEnabled));
    this.tools.set('artifact_tool', new ArtifactTool(this.workspaceEnabled));
    
    console.log('[AdminToolRegistry] Registered tools:', {
      workspace: this.workspaceEnabled ? 'enabled' : 'disabled',
      memory: this.memory ? 'enabled' : 'disabled'
    });
  }

  /**
   * Get function declarations for Gemini function calling
   */
  getFunctionDeclarations(): any[] {
    const declarations: any[] = [];
    
    for (const [name, tool] of this.tools) {
      // Skip workspace tools if workspace is disabled (optional: can keep them with degraded mode)
      // Keeping them allows graceful error messages
      declarations.push({
        name: tool.name,
        description: this.enhanceDescription(tool),
        parameters: tool.parameters
      });
    }
    
    return declarations;
  }

  /**
   * Enhance tool descriptions with availability info
   */
  private enhanceDescription(tool: AdminTool): string {
    let description = tool.description;
    
    // Add workspace availability notice
    if ((tool.name === 'planned_tasks' || tool.name === 'artifact_tool') && !this.workspaceEnabled) {
      description += '\n⚠️ Note: This tool requires workspace configuration (B2 storage). Currently unavailable.';
    }
    
    // Add memory availability notice
    if (tool.name === 'rag_search' && !this.memory) {
      description += '\n⚠️ Note: This tool requires memory/vectorize configuration. Currently unavailable.';
    }
    
    return description;
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, args: any): Promise<ToolResult> {
    const tool = this.tools.get(name);
    
    if (!tool) {
      return {
        success: false,
        summary: `Unknown tool: ${name}`,
        data: null,
        metadata: { errorCode: 'UNKNOWN_TOOL' }
      };
    }
    
    try {
      console.log(`[AdminToolRegistry] Executing tool: ${name}`, {
        args,
        workspaceEnabled: this.workspaceEnabled
      });
      
      const result = await tool.execute(args);
      
      console.log(`[AdminToolRegistry] Tool ${name} completed:`, {
        success: result.success,
        summary: result.summary?.substring(0, 100)
      });
      
      return result;
      
    } catch (error) {
      console.error(`[AdminToolRegistry] Tool ${name} error:`, error);
      
      return {
        success: false,
        summary: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        data: null,
        metadata: { 
          errorCode: 'TOOL_EXECUTION_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  /**
   * Check if a tool requires user input (for flow control)
   */
  isUserInputRequired(toolName: string, result: ToolResult): boolean {
    return toolName === 'ask_user' && result.success;
  }

  /**
   * Get available tools info (for debugging/status)
   */
  getAvailableTools(): Array<{ name: string; available: boolean; reason?: string }> {
    const tools: Array<{ name: string; available: boolean; reason?: string }> = [];
    
    for (const [name, tool] of this.tools) {
      let available = true;
      let reason: string | undefined;
      
      // Check workspace dependencies
      if ((name === 'planned_tasks' || name === 'artifact_tool') && !this.workspaceEnabled) {
        available = false;
        reason = 'Workspace not configured (B2 storage required)';
      }
      
      // Check memory dependencies
      if (name === 'rag_search' && !this.memory) {
        available = false;
        reason = 'Memory/Vectorize not configured';
      }
      
      tools.push({ name, available, reason });
    }
    
    return tools;
  }

  /**
   * Check if workspace-dependent features are available
   */
  isWorkspaceAvailable(): boolean {
    return this.workspaceEnabled;
  }

  /**
   * Check if memory-dependent features are available
   */
  isMemoryAvailable(): boolean {
    return this.memory !== null;
  }
}

export default AdminToolRegistry;
