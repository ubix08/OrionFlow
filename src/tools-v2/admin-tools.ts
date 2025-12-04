// src/tools-v2/admin-tools.ts - Complete Admin Tool Implementations

import type { GeminiClient } from '../gemini';
import type { MemoryManager } from '../memory/memory-manager';
import type { WorkerFactory } from '../workers/specialized-workers';
import type { WorkerContext, WorkerResult } from '../workers/worker-types';
import type { 
  AdminTool, 
  ToolResult, 
  FunctionDeclaration,
  SearchResult,
  MemoryResult
} from './tool-types';

/**
 * Web Search Tool - Wrapper around Gemini's native search
 */
export class WebSearchTool implements AdminTool<{ query: string }, SearchResult[]> {
  constructor(private gemini: GeminiClient) {}
  
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'web_search',
      description: 'Search the web for current information. Use for facts, news, trends, or any information that may have changed recently.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (2-6 words recommended for best results)'
          }
        },
        required: ['query']
      }
    };
  }
  
  async execute(args: { query: string }): Promise<ToolResult<SearchResult[]>> {
    try {
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: `Search: ${args.query}` }],
        {
          useSearch: true,
          temperature: 0.3,
          maxOutputTokens: 2048
        }
      );
      
      const results: SearchResult[] = [];
      
      if (response.searchResults && response.searchResults.length > 0) {
        // Extract grounding metadata
        for (const result of response.searchResults) {
          if (result.searchEntryPoint) {
            results.push({
              title: 'Search Results',
              url: result.searchEntryPoint.renderedContent || '',
              snippet: response.text.substring(0, 200),
              relevance: 0.8
            });
          }
        }
      }
      
      const summary = response.text || 'No results found';
      
      return {
        success: results.length > 0,
        data: results,
        summary: `Found ${results.length} results. ${summary.substring(0, 150)}...`,
        metadata: {
          query: args.query,
          resultCount: results.length
        }
      };
    } catch (error) {
      return {
        success: false,
        data: [],
        summary: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { query: args.query }
      };
    }
  }
}

/**
 * Memory Search Tool - RAG over conversation history
 */
export class MemorySearchTool implements AdminTool<{ query: string; limit?: number }, MemoryResult[]> {
  constructor(private memory: MemoryManager) {}
  
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'search_memory',
      description: 'Search conversation history and past context using semantic search. Use to recall previous discussions, decisions, or information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memory'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default 5)'
          }
        },
        required: ['query']
      }
    };
  }
  
  async execute(args: { query: string; limit?: number }): Promise<ToolResult<MemoryResult[]>> {
    try {
      const results = await this.memory.searchMemory(args.query, {
        topK: args.limit || 5,
        threshold: 0.65
      });
      
      const memoryResults: MemoryResult[] = results.map(r => ({
        content: r.content,
        score: r.score,
        timestamp: r.metadata?.timestamp as number | undefined,
        type: r.metadata?.type as string | undefined
      }));
      
      const summary = memoryResults.length > 0
        ? `Found ${memoryResults.length} relevant memories. Top match: ${memoryResults[0].content.substring(0, 100)}...`
        : 'No relevant memories found';
      
      return {
        success: memoryResults.length > 0,
        data: memoryResults,
        summary,
        metadata: {
          query: args.query,
          resultCount: memoryResults.length
        }
      };
    } catch (error) {
      return {
        success: false,
        data: [],
        summary: `Memory search failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

/**
 * Knowledge Search Tool - File search via Gemini
 */
export class KnowledgeSearchTool implements AdminTool<{ query: string }, string> {
  constructor(private gemini: GeminiClient) {}
  
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'search_knowledge',
      description: 'Search through uploaded files and documents. Use when user references uploaded PDFs, documents, or other files.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in uploaded files'
          }
        },
        required: ['query']
      }
    };
  }
  
  async execute(args: { query: string }): Promise<ToolResult<string>> {
    try {
      const files = await this.gemini.listFiles();
      
      if (files.length === 0) {
        return {
          success: false,
          data: '',
          summary: 'No files uploaded. User needs to upload documents first.'
        };
      }
      
      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: args.query, files }],
        {
          useFileSearch: true,
          temperature: 0.3,
          maxOutputTokens: 2048
        }
      );
      
      return {
        success: true,
        data: response.text,
        summary: `Searched ${files.length} files. ${response.text.substring(0, 150)}...`,
        metadata: {
          fileCount: files.length,
          query: args.query
        }
      };
    } catch (error) {
      return {
        success: false,
        data: '',
        summary: `Knowledge search failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

/**
 * Delegate Tool - Worker invocation
 */
export class DelegateTool implements AdminTool<{
  worker_type: 'research' | 'code' | 'analysis' | 'content';
  objective: string;
  step_description?: string;
  constraints?: string[];
  max_turns?: number;
}, WorkerResult> {
  constructor(private workerFactory: WorkerFactory) {}
  
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'delegate_to_worker',
      description: 'Delegate a specific task to a specialized worker. Use when you need to execute a focused task that requires native tools (search, code execution).',
      parameters: {
        type: 'object',
        properties: {
          worker_type: {
            type: 'string',
            enum: ['research', 'code', 'analysis', 'content'],
            description: 'Type of worker: research (web search), code (execution), analysis (data), content (writing)'
          },
          objective: {
            type: 'string',
            description: 'Clear, specific objective for the worker'
          },
          step_description: {
            type: 'string',
            description: 'Detailed description of what the worker should do'
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Constraints or requirements the worker must follow'
          },
          max_turns: {
            type: 'number',
            description: 'Maximum conversation turns for worker (default 5)'
          }
        },
        required: ['worker_type', 'objective']
      }
    };
  }
  
  async execute(args: {
    worker_type: 'research' | 'code' | 'analysis' | 'content';
    objective: string;
    step_description?: string;
    constraints?: string[];
    max_turns?: number;
  }): Promise<ToolResult<WorkerResult>> {
    try {
      const worker = this.workerFactory.createWorker(args.worker_type);
      
      const context: WorkerContext = {
        type: args.worker_type,
        objective: args.objective,
        stepDescription: args.step_description || args.objective,
        constraints: args.constraints || [],
        maxTurns: args.max_turns || 5
      };
      
      const result = await worker.execute(context);
      
      const summary = result.success
        ? `Worker completed in ${result.metadata.turnsUsed} turns. ${result.output.substring(0, 150)}...`
        : `Worker failed: ${result.output}`;
      
      return {
        success: result.success,
        data: result,
        summary,
        metadata: {
          workerType: args.worker_type,
          turnsUsed: result.metadata.turnsUsed,
          toolsUsed: result.metadata.toolsUsed,
          artifactCount: result.artifacts.length
        }
      };
    } catch (error) {
      return {
        success: false,
        data: {
          success: false,
          output: error instanceof Error ? error.message : String(error),
          artifacts: [],
          observations: [],
          metadata: { turnsUsed: 0, toolsUsed: [], tokensConsumed: 0, thinkingTokens: 0 }
        },
        summary: `Delegation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

/**
 * Ask User Tool - Request clarification
 */
export class AskUserTool implements AdminTool<{ question: string; context?: string }, null> {
  getDeclaration(): FunctionDeclaration {
    return {
      name: 'ask_user',
      description: 'Ask the user a clarifying question. Use when you need more information to proceed effectively.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user'
          },
          context: {
            type: 'string',
            description: 'Why you are asking (helps user provide better answer)'
          }
        },
        required: ['question']
      }
    };
  }
  
  async execute(args: { question: string; context?: string }): Promise<ToolResult<null>> {
    const summary = args.context 
      ? `${args.context}\n\n${args.question}`
      : args.question;
    
    return {
      success: true,
      data: null,
      summary,
      metadata: { requiresUserInput: true }
    };
  }
}
