// src/tools-v2/tool-types.ts - Enhanced Tool Type Definitions

/**
 * Generic tool result with structured data and summary
 */
export interface ToolResult<T = any> {
  success: boolean;
  data: T;
  summary: string;
  metadata?: {
    sources?: string[];
    confidence?: number;
    cacheHit?: boolean;
    tokensUsed?: number;
    requiresUserInput?: boolean;
    [key: string]: any;
  };
}

/**
 * Function declaration for Gemini function calling
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/**
 * Base interface for all admin tools
 */
export interface AdminTool<TArgs = any, TResult = any> {
  getDeclaration(): FunctionDeclaration;
  execute(args: TArgs): Promise<ToolResult<TResult>>;
}

/**
 * Search result structure
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance?: number;
}

/**
 * Memory search result
 */
export interface MemoryResult {
  content: string;
  score: number;
  timestamp?: number;
  type?: string;
}

/**
 * RAG search result structure
 */
export interface RAGResult {
  memory: MemoryResult[];
  files: FileSearchResult[];
  artifacts: ArtifactSearchResult[];
  tasks: TaskSearchResult[];
}

export interface FileSearchResult {
  fileName: string;
  fileUri: string;
  snippet: string;
  relevance: number;
}

export interface ArtifactSearchResult {
  artifactId: string;
  taskId: string;
  title: string;
  type: string;
  snippet: string;
  relevance: number;
}

export interface TaskSearchResult {
  taskId: string;
  title: string;
  description: string;
  status: string;
  relevance: number;
  createdAt: number;
}

/**
 * Task management structures
 */
export interface TodoStructure {
  taskId: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  steps: TodoStep[];
  metadata: {
    createdAt: number;
    updatedAt: number;
    createdBy?: string;
    tags?: string[];
  };
}

export interface TodoStep {
  number: number;
  title: string;
  description: string;
  workerType: 'research' | 'code' | 'analysis' | 'content';
  objective: string;
  requirements: string[];
  dependencies?: Array<{ stepNumber: number; outputPath: string }>;
  outputs: string[];
  checkpoint: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  startedAt?: number;
  completedAt?: number;
  turnsUsed?: number;
  notes?: string;
}

/**
 * Artifact management types
 */
export interface ArtifactReference {
  artifactId: string;
  taskId: string;
  stepNumber: number;
  path: string;
  type: string;
  title: string;
  createdAt: number;
}
