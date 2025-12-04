// src/workers/worker-types.ts - Core Worker Type Definitions

import type { Artifact } from '../types';

/**
 * Worker Types - Each specialized for different domains
 */
export type WorkerType = 'research' | 'code' | 'analysis' | 'content';

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
