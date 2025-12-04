//  - Admin Tool Type Definitions

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
 * Task document structure
 */
export interface TaskDocument {
  id: string;
  objective: string;
  status: 'planning' | 'in_progress' | 'completed' | 'failed';
  workflowId?: string;
  conversationSummary: string;
  createdAt: number;
  updatedAt: number;
  steps: TaskStep[];
}

/**
 * Individual task step
 */
export interface TaskStep {
  stepNumber: number;
  workerType: 'research' | 'code' | 'analysis' | 'content';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  input: {
    objective: string;
    constraints: string[];
  };
  output?: {
    success: boolean;
    result: string;
    artifacts: string[];
    turnsUsed: number;
  };
  startedAt?: number;
  completedAt?: number;
}
