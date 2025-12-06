// src/types.ts - Enhanced Type Definitions (Fixed Environment)

import type { DurableObjectNamespace, D1Database, VectorizeIndex } from '@cloudflare/workers-types';

// =============================================================
// Environment (✅ FIXED)
// =============================================================

export interface Env {
  // Durable Object Namespace
  AGENT: DurableObjectNamespace;
  
  // Databases
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  
  // API Keys
  GEMINI_API_KEY: string;
  JWT_SECRET?: string;
  
  // B2 Workspace Configuration
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_S3_ENDPOINT?: string;
  B2_BUCKET?: string;
  B2_BASE_PATH?: string;
}

// =============================================================
// User & Session
// =============================================================

export interface UserContext {
  userId: string;
  recentProjects: ProjectMetadata[];
  unfinishedProjects: ProjectMetadata[];
  conversationHistory: Message[];
  preferences: Record<string, any>;
}

export interface Session {
  sessionId: string;
  userId?: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}

// =============================================================
// Project System
// =============================================================

export interface ProjectMetadata {
  projectId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  
  title: string;
  objective: string;
  domain: string;
  tags: string[];
  
  status: 'planning' | 'active' | 'paused' | 'completed' | 'failed';
  currentStep: number;
  totalSteps: number;
  
  workflowId?: string;
  lastCheckpoint?: number;
  checkpointData?: any;
  
  sessions: ProjectSession[];
}

export interface ProjectSession {
  sessionId: string;
  timestamp: number;
  action: 'created' | 'resumed' | 'continued' | 'completed' | 'failed';
}

export interface ProjectInfo {
  projectId: string;
  objective: string;
  workflowId?: string;
  status: ProjectMetadata['status'];
  createdAt: number;
  updatedAt: number;
  stepsTotal: number;
  stepsCompleted: number;
  currentStep?: number;
  workspacePath: string;
}

// =============================================================
// Intent Classification
// =============================================================

export interface Intent {
  type: 'simple' | 'complex' | 'project_continuation' | 'project_query';
  projectId?: string;
  reasoning: string;
  complexity: number;
  confidence: number;
}

// =============================================================
// Workflow & Planning
// =============================================================

export interface WorkflowTemplate {
  id: string;
  title: string;
  domain: string;
  complexity: 'Simple' | 'Medium' | 'Complex';
  estimatedTime: string;
  description: string;
  tools: string[];
  steps: WorkflowStep[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowStep {
  number: number;
  title: string;
  description: string;
  tools: string[];
  outputs: string[];
  checkpoint?: boolean;
  estimatedTurns: number;
}

export interface WorkflowPlan {
  workflowId: string;
  workflowTitle: string;
  adaptedSteps: AdaptedStep[];
  estimatedTime: string;
  rationale: string;
}

export interface AdaptedStep {
  number: number;
  title: string;
  agentId: string;
  agentName: string;
  objective: string;
  requirements: string[];
  dependencies: Array<{ stepNumber: number; outputPath: string }>;
  outputs: string[];
  checkpoint: boolean;
}

export interface TaskAnalysis {
  objective: string;
  domain: string;
  complexity: 'Simple' | 'Medium' | 'Complex';
  estimatedSteps: number;
  requiredCapabilities: string[];
  suggestedApproach: string;
}

// =============================================================
// Todo Document
// =============================================================

export interface TodoDocument {
  objective: string;
  projectId: string;
  workflowId?: string;
  createdAt: number;
  updatedAt: number;
  steps: TodoStep[];
}

export interface TodoStep {
  number: number;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  checkpoint: boolean;
  outputs: string[];
  agentId?: string;
  agentConfig?: AgentStepConfig;
  dependencies?: Array<{ stepNumber: number; outputPath: string }>;
  startedAt?: number;
  completedAt?: number;
  notes?: string;
}

export interface AgentStepConfig {
  objective: string;
  requirements: string[];
  outputFormat: string;
  constraints?: string[];
  userContext?: Record<string, string>;
}

// =============================================================
// Messages
// =============================================================

export interface Message {
  id?: string;
  role: 'user' | 'model' | 'system';
  content?: string;
  parts?: MessagePart[];
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface MessagePart {
  text?: string;
  thought?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
}

// =============================================================
// RPC Interface
// =============================================================

export interface OrionRPC {
  chat(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<ChatResponse>;
  
  listProjects(filters?: ProjectFilters): Promise<{ projects: ProjectMetadata[] }>;
  getProject(projectId: string): Promise<{ project: ProjectMetadata }>;
  continueProject(projectId: string): Promise<ChatResponse>;
  
  getHistory(): Promise<{ messages: Message[] }>;
  clear(): Promise<{ ok: boolean }>;
  
  getStatus(): Promise<StatusResponse>;
  
  uploadFile(base64: string, mimeType: string, name: string): Promise<{ success: boolean; file: FileMetadata }>;
  listFiles(): Promise<{ files: FileMetadata[] }>;
  deleteFile(fileUri: string): Promise<{ ok: boolean }>;
}

export interface ProjectFilters {
  status?: ProjectMetadata['status'];
  domain?: string;
  tags?: string[];
  limit?: number;
}

export interface ChatResponse {
  response: string;
  artifacts: Artifact[];
  conversationPhase: 'discovery' | 'planning' | 'execution' | 'review' | 'delivery';
  suggestedWorkflows?: WorkflowTemplate[];
  activeProject?: ActiveProject;
  metadata?: {
    turnsUsed: number;
    toolsUsed: string[];
    thinkingTokens?: number;
  };
}

export interface ActiveProject {
  projectId: string;
  projectPath: string;
  workflowId?: string;
  currentStep?: number;
  totalSteps: number;
  createdAt: number;
  updatedAt: number;
}

export interface StatusResponse {
  sessionId?: string;
  userId?: string;
  messageCount: number;
  artifactCount: number;
  conversationPhase: 'discovery' | 'planning' | 'execution' | 'review' | 'delivery';
  activeProject?: ActiveProject;
  protocol: string;
  metrics: AgentMetrics;
  nativeTools: {
    googleSearch: boolean;
    codeExecution: boolean;
    fileSearch: boolean;
    thinking: boolean;
  };
  memory: any;
  workspace: WorkspaceStatus;
  availableWorkflows: number;
  recentProjects?: ProjectMetadata[];
  unfinishedProjects?: ProjectMetadata[];
}

export interface WorkspaceStatus {
  enabled: boolean;
  initialized: boolean;
  projectCount?: number;
}

export interface AgentMetrics {
  totalRequests: number;
  simpleRequests?: number;
  complexRequests?: number;
  projectsCreated?: number;
  projectsResumed?: number;
  stepsCompleted?: number;
  checkpointsReached?: number;
  planRegenerations?: number;
  adminTurns?: number;
  workerDelegations?: number;
  toolCalls?: number;
  totalTokens?: number;
  phaseTransitions?: number;
}

// =============================================================
// Artifacts & Files
// =============================================================

export interface Artifact {
  id: string;
  type: 'code' | 'research' | 'analysis' | 'content' | 'report' | 'data';
  title: string;
  content: string;
  projectId?: string;
  stepNumber?: number;
  createdAt: number;
  workerType?: string;
  metadata?: {
    format?: string;
    language?: string;
    toolsUsed?: string[];
  };
}

export interface FileMetadata {
  fileUri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  uploadedAt: number;
  state?: 'PROCESSING' | 'ACTIVE' | 'FAILED';
  expiresAt?: number;
}

// =============================================================
// Agent State
// =============================================================

export interface AgentState {
  sessionId: string;
  conversationHistory: Message[];
  context: {
    files: FileMetadata[];
    searchResults: any[];
  };
  lastActivityAt: number;
}

// =============================================================
// Memory Types
// =============================================================

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'conversation' | 'fact' | 'procedure' | 'observation';
  importance: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

// =============================================================
// WebSocket Messages
// =============================================================

export type WSIncomingMessage =
  | { type: 'user_message'; content: string; images?: Array<{ data: string; mimeType: string }> }
  | { type: 'continue_project'; projectId: string }
  | { type: 'ping' };

export type WSOutgoingMessage =
  | { type: 'status'; message: string }
  | { type: 'thought'; content: string }
  | { type: 'chunk'; content: string }
  | { type: 'step_started'; stepNumber: number; stepTitle: string }
  | { type: 'step_complete'; stepNumber: number; stepTitle: string; outputs: string[]; nextStepReady: boolean }
  | { type: 'project_created'; projectId: string; projectPath: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'tool_use'; tool: string; params: any }
  | { type: 'complete'; response: string; artifacts: Artifact[]; metadata?: any }
  | { type: 'error'; error: string }
  | { type: 'pong' };
