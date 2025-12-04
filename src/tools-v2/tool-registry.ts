// src/tools-v2/tool-registry.ts - Central Admin Tool Registry

import type { GeminiClient } from '../gemini';
import type { MemoryManager } from '../memory/memory-manager';
import type { WorkerFactory } from '../workers/specialized-workers';
import type { AdminTool, ToolResult, FunctionDeclaration } from './tool-types';
import {
  WebSearchTool,
  MemorySearchTool,
  KnowledgeSearchTool,
  DelegateTool,
  AskUserTool
} from './admin-tools';

/**
 * Central registry for all admin tools
 * Manages function declarations and execution routing
 */
export class AdminToolRegistry {
  private tools = new Map<string, AdminTool>();
  
  constructor(
    gemini: GeminiClient,
    memory: MemoryManager | null,
    workerFactory: WorkerFactory
  ) {
    this.registerTools(gemini, memory, workerFactory);
  }
  
  private registerTools(
    gemini: GeminiClient,
    memory: MemoryManager | null,
    workerFactory: WorkerFactory
  ): void {
    // Core information gathering tools
    this.tools.set('web_search', new WebSearchTool(gemini));
    
    if (memory) {
      this.tools.set('search_memory', new MemorySearchTool(memory));
    }
    
    this.tools.set('search_knowledge', new KnowledgeSearchTool(gemini));
    
    // Worker delegation
    this.tools.set('delegate_to_worker', new DelegateTool(workerFactory));
    
    // User interaction
    this.tools.set('ask_user', new AskUserTool());
    
    console.log(`[ToolRegistry] Registered ${this.tools.size} admin tools`);
  }
  
  /**
   * Get function declarations for Gemini function calling
   */
  getFunctionDeclarations(): FunctionDeclaration[] {
    return Array.from(this.tools.values()).map(tool => tool.getDeclaration());
  }
  
  /**
   * Execute a tool by name with arguments
   */
  async executeTool(name: string, args: any): Promise<ToolResult> {
    const tool = this.tools.get(name);
    
    if (!tool) {
      return {
        success: false,
        data: null,
        summary: `Unknown tool: ${name}`,
        metadata: { error: 'TOOL_NOT_FOUND' }
      };
    }
    
    try {
      console.log(`[ToolRegistry] Executing ${name} with args:`, args);
      const result = await tool.execute(args);
      console.log(`[ToolRegistry] ${name} completed:`, result.success ? 'SUCCESS' : 'FAILED');
      return result;
    } catch (error) {
      console.error(`[ToolRegistry] ${name} error:`, error);
      return {
        success: false,
        data: null,
        summary: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: 'EXECUTION_ERROR' }
      };
    }
  }
  
  /**
   * Check if a tool requires user input (ask_user)
   */
  isUserInputRequired(toolName: string, result: ToolResult): boolean {
    return toolName === 'ask_user' || result.metadata?.requiresUserInput === true;
  }
  
  /**
   * Get tool by name
   */
  getTool(name: string): AdminTool | undefined {
    return this.tools.get(name);
  }
  
  /**
   * List all available tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
