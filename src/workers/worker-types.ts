// src/workers/worker-types.ts - Enhanced Worker Type Definitions

import type { Artifact } from '../types';

/**
 * Worker Types - Each specialized for different domains
 */
export type WorkerType = 'research' | 'code' | 'analysis' | 'content';

/**
 * Worker capabilities definition
 */
export interface WorkerCapabilities {
  nativeTools: {
    googleSearch: boolean;
    codeExecution: boolean;
    urlContext: boolean;
    fileSearch: boolean;
  };
  outputFormats: ('text' | 'json' | 'code' | 'markdown')[];
  maxComplexity: 'simple' | 'medium' | 'complex';
  estimatedTurnsRange: [number, number]; // [min, max]
}

/**
 * Input context provided to workers
 */
export interface WorkerContext {
  type: WorkerType;
  objective: string;
  stepDescription: string;
  constraints: string[];
  previousStepOutputs?: string[];
  maxTurns: number;
  files?: Array<{ fileUri: string; mimeType: string }>;
  
  // Task context
  taskId?: string;
  stepNumber?: number;
}

/**
 * Structured result returned by workers
 */
export interface WorkerResult {
  success: boolean;
  output: string;
  artifacts: Artifact[];
  observations: string[];
  metadata: {
    turnsUsed: number;
    toolsUsed: string[];
    tokensConsumed: number;
    thinkingTokens: number;
    executionTime?: number;
  };
}

/**
 * Worker execution configuration
 */
export interface WorkerConfig {
  useSearch: boolean;
  useCodeExecution: boolean;
  useUrlContext: boolean;
  temperature: number;
  maxOutputTokens: number;
}

/**
 * Worker registry for capability-based selection
 */
export const WORKER_CAPABILITIES: Record<WorkerType, WorkerCapabilities> = {
  research: {
    nativeTools: {
      googleSearch: true,
      urlContext: true,
      codeExecution: false,
      fileSearch: false
    },
    outputFormats: ['markdown', 'json'],
    maxComplexity: 'medium',
    estimatedTurnsRange: [3, 7]
  },
  
  code: {
    nativeTools: {
      googleSearch: true, // For documentation lookup
      urlContext: false,
      codeExecution: true,
      fileSearch: false
    },
    outputFormats: ['code', 'json', 'text'],
    maxComplexity: 'complex',
    estimatedTurnsRange: [2, 10]
  },
  
  analysis: {
    nativeTools: {
      googleSearch: false,
      urlContext: false,
      codeExecution: true,
      fileSearch: false
    },
    outputFormats: ['json', 'markdown', 'text'],
    maxComplexity: 'medium',
    estimatedTurnsRange: [2, 5]
  },
  
  content: {
    nativeTools: {
      googleSearch: true,
      urlContext: true,
      codeExecution: false,
      fileSearch: false
    },
    outputFormats: ['markdown', 'text'],
    maxComplexity: 'simple',
    estimatedTurnsRange: [2, 5]
  }
};
