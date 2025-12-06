// src/tools-v2/rag-search-tool.ts - Multi-Source RAG Search

import type { GeminiClient } from '../gemini';
import type { MemoryManager } from '../memory/memory-manager';
import { Workspace } from '../workspace/workspace';
import type {
  AdminTool,
  ToolResult,
  FunctionDeclaration,
  RAGResult,
  MemoryResult,
  FileSearchResult,
  ArtifactSearchResult,
  TaskSearchResult
} from './tool-types';

export class RAGSearchTool implements AdminTool<{
  query: string;
  sources: ('memory' | 'files' | 'artifacts' | 'tasks')[];
  limit?: number;
}, RAGResult> {
  constructor(
    private gemini: GeminiClient,
    private memory: MemoryManager | null
  ) {}

  getDeclaration(): FunctionDeclaration {
    return {
      name: 'rag_search',
      description: 'Search across multiple knowledge sources: conversation memory, uploaded files, task artifacts, and task templates. Use explicit source selection for efficiency.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to find relevant information'
          },
          sources: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['memory', 'files', 'artifacts', 'tasks']
            },
            description: 'Which sources to search: memory (conversation history), files (uploaded docs), artifacts (task outputs), tasks (existing tasks/templates)'
          },
          limit: {
            type: 'number',
            description: 'Maximum results per source (default 5)'
          }
        },
        required: ['query', 'sources']
      }
    };
  }

  async execute(args: {
    query: string;
    sources: ('memory' | 'files' | 'artifacts' | 'tasks')[];
    limit?: number;
  }): Promise<ToolResult<RAGResult>> {
    const limit = args.limit || 5;
    const result: RAGResult = {
      memory: [],
      files: [],
      artifacts: [],
      tasks: []
    };

    try {
      // Search each specified source in parallel
      const searches: Promise<void>[] = [];

      if (args.sources.includes('memory')) {
        searches.push(this.searchMemory(args.query, limit, result));
      }

      if (args.sources.includes('files')) {
        searches.push(this.searchFiles(args.query, limit, result));
      }

      if (args.sources.includes('artifacts')) {
        searches.push(this.searchArtifacts(args.query, limit, result));
      }

      if (args.sources.includes('tasks')) {
        searches.push(this.searchTasks(args.query, limit, result));
      }

      await Promise.all(searches);

      // Calculate total results
      const totalResults = 
        result.memory.length +
        result.files.length +
        result.artifacts.length +
        result.tasks.length;

      return {
        success: totalResults > 0,
        data: result,
        summary: this.formatSummary(result, args.sources),
        metadata: {
          sourcesSearched: args.sources,
          totalResults,
          resultsBySource: {
            memory: result.memory.length,
            files: result.files.length,
            artifacts: result.artifacts.length,
            tasks: result.tasks.length
          }
        }
      };
    } catch (error) {
      console.error('[RAGSearch] Error:', error);
      return {
        success: false,
        data: result,
        summary: `RAG search failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: 'SEARCH_FAILED' }
      };
    }
  }

  // -----------------------------------------------------------
  // Source-Specific Search Methods
  // -----------------------------------------------------------

  private async searchMemory(
    query: string,
    limit: number,
    result: RAGResult
  ): Promise<void> {
    if (!this.memory) return;

    try {
      const memoryResults = await this.memory.searchMemory(query, {
        topK: limit,
        threshold: 0.65
      });

      result.memory = memoryResults.map(r => ({
        content: r.content,
        score: r.score,
        timestamp: r.metadata?.timestamp as number | undefined,
        type: r.metadata?.type as string | undefined
      }));
    } catch (error) {
      console.warn('[RAGSearch] Memory search failed:', error);
    }
  }

  private async searchFiles(
    query: string,
    limit: number,
    result: RAGResult
  ): Promise<void> {
    try {
      const files = await this.gemini.listFiles();
      
      if (files.length === 0) return;

      const response = await this.gemini.generateWithNativeTools(
        [{ role: 'user', content: `Search uploaded files for: ${query}`, files }],
        {
          useFileSearch: true,
          temperature: 0.3,
          maxOutputTokens: 2048
        }
      );

      // Parse file search results from response
      // Note: This is simplified - actual implementation would parse grounding metadata
      if (response.text) {
        result.files.push({
          fileName: 'Combined results',
          fileUri: files[0].fileUri,
          snippet: response.text.substring(0, 200),
          relevance: 0.8
        });
      }
    } catch (error) {
      console.warn('[RAGSearch] File search failed:', error);
    }
  }

  private async searchArtifacts(
    query: string,
    limit: number,
    result: RAGResult
  ): Promise<void> {
    if (!Workspace.isInitialized()) return;

    try {
      // List all task folders
      const tasksDir = await Workspace.readdir('tasks');
      const artifactMatches: ArtifactSearchResult[] = [];

      // Search through artifacts in each task
      for (const taskFolder of tasksDir.directories.slice(0, 20)) { // Limit to 20 tasks
        try {
          const artifactsDir = await Workspace.readdir(`tasks/${taskFolder}/artifacts`);
          
          for (const file of artifactsDir.files) {
            const content = await Workspace.readFileText(`tasks/${taskFolder}/artifacts/${file.name}`);
            
            // Simple relevance scoring based on keyword matching
            const relevance = this.calculateRelevance(query, content);
            
            if (relevance > 0.3) {
              const taskId = taskFolder.split('_')[1]; // Extract task ID
              
              artifactMatches.push({
                artifactId: file.name.replace(/\.\w+$/, ''),
                taskId,
                title: file.name,
                type: this.inferArtifactType(file.name),
                snippet: content.substring(0, 200),
                relevance
              });
            }
          }
        } catch (error) {
          // Skip task if artifacts can't be read
          continue;
        }
      }

      // Sort by relevance and limit
      result.artifacts = artifactMatches
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit);
    } catch (error) {
      console.warn('[RAGSearch] Artifact search failed:', error);
    }
  }

  private async searchTasks(
    query: string,
    limit: number,
    result: RAGResult
  ): Promise<void> {
    if (!Workspace.isInitialized()) return;

    try {
      const tasksDir = await Workspace.readdir('tasks');
      const taskMatches: TaskSearchResult[] = [];

      for (const taskFolder of tasksDir.directories) {
        try {
          // Read task description
          const description = await Workspace.readFileText(`tasks/${taskFolder}/description.md`);
          
          // Read metadata if exists
          let metadata: any = {};
          try {
            const metadataStr = await Workspace.readFileText(`tasks/${taskFolder}/metadata.json`);
            metadata = JSON.parse(metadataStr);
          } catch {
            // Metadata optional
          }

          // Calculate relevance
          const relevance = this.calculateRelevance(query, description);

          if (relevance > 0.3) {
            const parts = taskFolder.split('_');
            const taskId = parts[1];
            const title = parts.slice(2).join(' ');

            taskMatches.push({
              taskId,
              title: title || 'Untitled Task',
              description: description.substring(0, 200),
              status: metadata.status || 'unknown',
              relevance,
              createdAt: metadata.createdAt || 0
            });
          }
        } catch (error) {
          continue;
        }
      }

      // Sort by relevance and limit
      result.tasks = taskMatches
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, limit);
    } catch (error) {
      console.warn('[RAGSearch] Task search failed:', error);
    }
  }

  // -----------------------------------------------------------
  // Helper Methods
  // -----------------------------------------------------------

  private calculateRelevance(query: string, content: string): number {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();

    // Split query into keywords
    const keywords = queryLower.split(/\s+/).filter(k => k.length > 2);
    let matches = 0;

    for (const keyword of keywords) {
      if (contentLower.includes(keyword)) {
        matches++;
      }
    }

    return keywords.length > 0 ? matches / keywords.length : 0;
  }

  private inferArtifactType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const typeMap: Record<string, string> = {
      'md': 'markdown',
      'json': 'data',
      'py': 'code',
      'js': 'code',
      'ts': 'code',
      'txt': 'text',
      'html': 'web'
    };
    return typeMap[ext] || 'unknown';
  }

  private formatSummary(result: RAGResult, sources: string[]): string {
    const parts: string[] = [];

    if (result.memory.length > 0) {
      parts.push(`${result.memory.length} conversation memories`);
    }
    if (result.files.length > 0) {
      parts.push(`${result.files.length} file excerpts`);
    }
    if (result.artifacts.length > 0) {
      parts.push(`${result.artifacts.length} task artifacts`);
    }
    if (result.tasks.length > 0) {
      parts.push(`${result.tasks.length} related tasks`);
    }

    if (parts.length === 0) {
      return `No results found in: ${sources.join(', ')}`;
    }

    return `Found ${parts.join(', ')} across ${sources.length} source(s)`;
  }
}
