// src/agents/agent-wrapper.ts - Multi-Agent System Core

import type { GeminiClient } from '../gemini';
import type { Workspace } from '../workspace/workspace';
import type { VectorizeIndex } from '@cloudflare/workers-types';

// =============================================================
// Agent Type Definitions
// =============================================================

export interface AgentWrapper {
  id: string;
  name: string;
  domain: string;
  description: string;
  capabilities: string[];
  version: string;
  
  systemPrompt: string;
  userPromptTemplate: string;
  
  defaultTools: {
    googleSearch?: boolean;
    codeExecution?: boolean;
    fileSearch?: boolean;
    thinking?: boolean;
  };
  
  modelConfig: {
    model: string;
    temperature: number;
    maxOutputTokens: number;
    thinkingBudget: number;
  };
  
  outputSchema: OutputSchema;
  
  metadata: {
    author: string;
    createdAt: string;
    tags: string[];
    useCases: string[];
  };
}

export interface OutputSchema {
  type: 'structured' | 'text' | 'code';
  format?: any; // JSON schema for structured output
  metadata?: string[]; // Required metadata fields
}

export interface AgentInvocation {
  agentId: string;
  objective: string;
  requirements?: string[];
  inputSources?: Record<string, any>;
  userContext?: Record<string, any>;
  outputFormat?: string;
  constraints?: string[];
}

export interface AgentResult {
  success: boolean;
  output: any;
  metadata: {
    agentId: string;
    tokensUsed: number;
    latency: number;
    thinkingTokens?: number;
  };
  error?: string;
}

export interface AgentMetrics {
  agentId: string;
  taskType: string;
  successCount: number;
  failureCount: number;
  avgTokens: number;
  avgLatency: number;
  lastUsed: number;
}

// =============================================================
// Agent Registry
// =============================================================

export class AgentRegistry {
  private workspace: typeof Workspace;
  private gemini: GeminiClient;
  private vectorize: VectorizeIndex | null;
  private agentCache = new Map<string, AgentWrapper>();
  private metricsCache = new Map<string, AgentMetrics>();
  
  private readonly agentsPath = 'agents';

  constructor(
    workspace: typeof Workspace,
    gemini: GeminiClient,
    vectorize: VectorizeIndex | null
  ) {
    this.workspace = workspace;
    this.gemini = gemini;
    this.vectorize = vectorize;
  }

  // -----------------------------------------------------------
  // Agent Loading
  // -----------------------------------------------------------

  async loadAgent(agentId: string): Promise<AgentWrapper | null> {
    // Check cache
    if (this.agentCache.has(agentId)) {
      return this.agentCache.get(agentId)!;
    }

    if (!this.workspace.isInitialized()) {
      console.warn('[AgentRegistry] Workspace not initialized');
      return null;
    }

    try {
      const path = `${this.agentsPath}/${agentId}.json`;
      const content = await this.workspace.readFileText(path);
      const agent: AgentWrapper = JSON.parse(content);
      
      // Validate agent structure
      if (!this.validateAgent(agent)) {
        throw new Error('Invalid agent structure');
      }
      
      // Cache it
      this.agentCache.set(agentId, agent);
      
      return agent;
    } catch (e) {
      console.error(`[AgentRegistry] Failed to load agent ${agentId}:`, e);
      return null;
    }
  }

  async listAllAgents(): Promise<AgentWrapper[]> {
    if (!this.workspace.isInitialized()) return [];

    try {
      const listing = await this.workspace.readdir(this.agentsPath);
      const agents: AgentWrapper[] = [];

      for (const file of listing.files) {
        if (file.name.endsWith('.json')) {
          const agentId = file.name.replace('.json', '');
          const agent = await this.loadAgent(agentId);
          if (agent) agents.push(agent);
        }
      }

      return agents;
    } catch (e) {
      console.warn('[AgentRegistry] Failed to list agents:', e);
      return [];
    }
  }

  // -----------------------------------------------------------
  // Agent Search (RAG)
  // -----------------------------------------------------------

  async searchAgents(
    query: string,
    requiredCapabilities?: string[],
    domain?: string,
    limit = 5
  ): Promise<AgentWrapper[]> {
    if (!this.vectorize) {
      console.warn('[AgentRegistry] Vectorize not available - returning all agents');
      const all = await this.listAllAgents();
      return this.filterAgents(all, requiredCapabilities, domain).slice(0, limit);
    }

    try {
      // Generate query embedding
      const queryEmbedding = await this.gemini.embedText(query, { normalize: true });

      // Search Vectorize
      const results = await this.vectorize.query(queryEmbedding, {
        topK: limit * 2, // Over-fetch for filtering
        filter: { type: 'agent', ...(domain && { domain }) },
        returnMetadata: true,
      });

      const agents: AgentWrapper[] = [];

      for (const match of results.matches || []) {
        if (match.score >= 0.6) {
          const agentId = match.metadata?.agent_id as string;
          if (agentId) {
            const agent = await this.loadAgent(agentId);
            if (agent) agents.push(agent);
          }
        }
      }

      // Filter by required capabilities
      const filtered = this.filterAgents(agents, requiredCapabilities, domain);
      
      return filtered.slice(0, limit);
    } catch (e) {
      console.error('[AgentRegistry] Search failed:', e);
      return [];
    }
  }

  private filterAgents(
    agents: AgentWrapper[],
    requiredCapabilities?: string[],
    domain?: string
  ): AgentWrapper[] {
    let filtered = agents;

    if (requiredCapabilities && requiredCapabilities.length > 0) {
      filtered = filtered.filter(agent =>
        requiredCapabilities.every(cap => agent.capabilities.includes(cap))
      );
    }

    if (domain) {
      filtered = filtered.filter(agent => agent.domain === domain);
    }

    return filtered;
  }

  // -----------------------------------------------------------
  // Agent Indexing
  // -----------------------------------------------------------

  async indexAgent(agentId: string): Promise<boolean> {
    if (!this.vectorize) {
      console.warn('[AgentRegistry] Vectorize not available - skipping indexing');
      return false;
    }

    try {
      const agent = await this.loadAgent(agentId);
      if (!agent) return false;

      // Create searchable text
      const searchableText = `
${agent.name}
${agent.description}
Domain: ${agent.domain}
Capabilities: ${agent.capabilities.join(', ')}
Use cases: ${agent.metadata.useCases.join(', ')}
      `.trim();

      // Generate embedding
      const embedding = await this.gemini.embedText(searchableText, { normalize: true });

      // Upsert to Vectorize
      await this.vectorize.upsert([{
        id: `agent_${agentId}`,
        values: embedding,
        metadata: {
          type: 'agent',
          agent_id: agentId,
          domain: agent.domain,
          capabilities: agent.capabilities,
        },
      }]);

      console.log(`[AgentRegistry] Indexed agent: ${agentId}`);
      return true;
    } catch (e) {
      console.error(`[AgentRegistry] Failed to index agent ${agentId}:`, e);
      return false;
    }
  }

  async indexAllAgents(): Promise<number> {
    const agents = await this.listAllAgents();
    let indexed = 0;

    for (const agent of agents) {
      const success = await this.indexAgent(agent.id);
      if (success) indexed++;
    }

    console.log(`[AgentRegistry] Indexed ${indexed}/${agents.length} agents`);
    return indexed;
  }

  // -----------------------------------------------------------
  // Agent Validation
  // -----------------------------------------------------------

  validateAgent(agent: any): agent is AgentWrapper {
    return !!(
      agent.id &&
      agent.name &&
      agent.systemPrompt &&
      agent.userPromptTemplate &&
      agent.capabilities &&
      Array.isArray(agent.capabilities) &&
      agent.modelConfig &&
      agent.outputSchema
    );
  }

  validateAgentForStep(
    agent: AgentWrapper,
    requiredCapabilities: string[]
  ): { valid: boolean; coverage: number; missing: string[] } {
    const provided = agent.capabilities;
    const missing = requiredCapabilities.filter(cap => !provided.includes(cap));
    const covered = requiredCapabilities.filter(cap => provided.includes(cap));
    
    const coverage = requiredCapabilities.length > 0
      ? (covered.length / requiredCapabilities.length) * 100
      : 100;

    return {
      valid: missing.length === 0,
      coverage,
      missing,
    };
  }

  // -----------------------------------------------------------
  // Agent Metrics
  // -----------------------------------------------------------

  async getAgentMetrics(agentId: string): Promise<AgentMetrics | null> {
    // Check cache
    if (this.metricsCache.has(agentId)) {
      return this.metricsCache.get(agentId)!;
    }

    try {
      const path = `${this.agentsPath}/metrics/${agentId}.json`;
      const content = await this.workspace.readFileText(path);
      const metrics: AgentMetrics = JSON.parse(content);
      
      this.metricsCache.set(agentId, metrics);
      return metrics;
    } catch {
      // Return default metrics if not found
      return {
        agentId,
        taskType: 'unknown',
        successCount: 0,
        failureCount: 0,
        avgTokens: 0,
        avgLatency: 0,
        lastUsed: 0,
      };
    }
  }

  async updateAgentMetrics(
    agentId: string,
    result: { success: boolean; tokensUsed: number; latency: number }
  ): Promise<void> {
    const metrics = await this.getAgentMetrics(agentId) || {
      agentId,
      taskType: 'unknown',
      successCount: 0,
      failureCount: 0,
      avgTokens: 0,
      avgLatency: 0,
      lastUsed: 0,
    };

    if (result.success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }

    const totalCalls = metrics.successCount + metrics.failureCount;
    metrics.avgTokens = Math.round(
      (metrics.avgTokens * (totalCalls - 1) + result.tokensUsed) / totalCalls
    );
    metrics.avgLatency = Math.round(
      (metrics.avgLatency * (totalCalls - 1) + result.latency) / totalCalls
    );
    metrics.lastUsed = Date.now();

    try {
      const path = `${this.agentsPath}/metrics/${agentId}.json`;
      await this.workspace.writeFile(path, JSON.stringify(metrics, null, 2));
      this.metricsCache.set(agentId, metrics);
    } catch (e) {
      console.warn('[AgentRegistry] Failed to update metrics:', e);
    }
  }
}

// =============================================================
// Agent Invoker
// =============================================================

export class AgentInvoker {
  private gemini: GeminiClient;
  private registry: AgentRegistry;

  constructor(gemini: GeminiClient, registry: AgentRegistry) {
    this.gemini = gemini;
    this.registry = registry;
  }

  // -----------------------------------------------------------
  // Agent Invocation
  // -----------------------------------------------------------

  async invoke(invocation: AgentInvocation): Promise<AgentResult> {
    const startTime = Date.now();

    try {
      // Load agent
      const agent = await this.registry.loadAgent(invocation.agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${invocation.agentId}`);
      }

      // Build prompt
      const prompt = this.buildPrompt(agent, invocation);

      // Invoke Gemini
      const response = await this.gemini.generateWithNativeTools(
        [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: prompt },
        ],
        {
          model: agent.modelConfig.model,
          temperature: agent.modelConfig.temperature,
          maxOutputTokens: agent.modelConfig.maxOutputTokens,
          thinkingConfig: {
            thinkingBudget: agent.modelConfig.thinkingBudget,
            includeThoughts: true,
          },
          useSearch: agent.defaultTools.googleSearch,
          useCodeExecution: agent.defaultTools.codeExecution,
          useFileSearch: agent.defaultTools.fileSearch,
        }
      );

      // Validate output
      const validated = await this.validateOutput(response.text, agent.outputSchema);

      const latency = Date.now() - startTime;

      // Update metrics
      await this.registry.updateAgentMetrics(agent.id, {
        success: true,
        tokensUsed: response.usageMetadata?.totalTokens || 0,
        latency,
      });

      return {
        success: true,
        output: validated,
        metadata: {
          agentId: agent.id,
          tokensUsed: response.usageMetadata?.totalTokens || 0,
          latency,
          thinkingTokens: response.usageMetadata?.totalTokens,
        },
      };
    } catch (error) {
      const latency = Date.now() - startTime;

      await this.registry.updateAgentMetrics(invocation.agentId, {
        success: false,
        tokensUsed: 0,
        latency,
      });

      return {
        success: false,
        output: null,
        metadata: {
          agentId: invocation.agentId,
          tokensUsed: 0,
          latency,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // -----------------------------------------------------------
  // Prompt Building
  // -----------------------------------------------------------

  private buildPrompt(agent: AgentWrapper, invocation: AgentInvocation): string {
    let prompt = agent.userPromptTemplate;

    // Replace {objective}
    prompt = prompt.replace(/\{objective\}/g, invocation.objective);

    // Replace {requirements}
    if (invocation.requirements) {
      const reqList = invocation.requirements.map(r => `- ${r}`).join('\n');
      prompt = prompt.replace(/\{requirements\}/g, reqList);
    }

    // Replace {output_format}
    if (invocation.outputFormat) {
      prompt = prompt.replace(/\{output_format\}/g, invocation.outputFormat);
    }

    // Replace {input_sources}
    if (invocation.inputSources) {
      const sources = this.formatInputSources(invocation.inputSources);
      prompt = prompt.replace(/\{input_sources\}/g, sources);
    }

    // Replace {constraints}
    if (invocation.constraints) {
      const constList = invocation.constraints.map(c => `- ${c}`).join('\n');
      prompt = prompt.replace(/\{constraints\}/g, constList);
    }

    // Replace user context variables
    if (invocation.userContext) {
      for (const [key, value] of Object.entries(invocation.userContext)) {
        const pattern = new RegExp(`\\{${key}\\}`, 'g');
        prompt = prompt.replace(pattern, String(value));
      }
    }

    return prompt;
  }

  private formatInputSources(sources: Record<string, any>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(sources)) {
      if (typeof value === 'string') {
        parts.push(`**${key}**:\n${value}\n`);
      } else {
        parts.push(`**${key}**:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
      }
    }

    return parts.join('\n');
  }

  // -----------------------------------------------------------
  // Output Validation
  // -----------------------------------------------------------

  private async validateOutput(output: string, schema: OutputSchema): Promise<any> {
    if (schema.type === 'text') {
      return output;
    }

    if (schema.type === 'code') {
      // Extract code blocks
      const codeMatch = output.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
      return codeMatch ? codeMatch[1] : output;
    }

    if (schema.type === 'structured') {
      // Try to parse as JSON
      try {
        // Look for JSON in the response
        const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/) ||
                          output.match(/\{[\s\S]*\}/) ||
                          output.match(/\[[\s\S]*\]/);
        
        if (!jsonMatch) {
          throw new Error('No JSON found in output');
        }

        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);

        // Basic schema validation
        if (schema.format) {
          this.validateSchema(parsed, schema.format);
        }

        return parsed;
      } catch (e) {
        console.warn('[AgentInvoker] Failed to parse structured output:', e);
        // Return raw output if parsing fails
        return output;
      }
    }

    return output;
  }

  private validateSchema(data: any, schema: any): void {
    // Basic schema validation (simplified)
    if (schema.type === 'object' && typeof data !== 'object') {
      throw new Error('Expected object output');
    }
    if (schema.type === 'array' && !Array.isArray(data)) {
      throw new Error('Expected array output');
    }
    // Add more sophisticated validation as needed
  }
}

export default { AgentRegistry, AgentInvoker };
