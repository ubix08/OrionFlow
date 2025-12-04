// src/workers/worker-executor.ts - Abstract Worker Executor

import type { GeminiClient, GenerateOptions } from '../gemini';
import type { Artifact } from '../types';
import type { WorkerContext, WorkerResult, WorkerType, WorkerConfig } from './worker-types';

/**
 * Abstract base class for all worker executors
 * Workers are STATELESS - they receive context and return results
 * Workers use ONLY native tools (search, code execution, url context)
 * NO function calling in workers - that's for Admin only
 */
export abstract class WorkerExecutor {
  protected gemini: GeminiClient;
  protected workerType: WorkerType;

  constructor(gemini: GeminiClient, type: WorkerType) {
    this.gemini = gemini;
    this.workerType = type;
  }

  /**
   * Execute worker task with context
   * Returns structured result
   */
  async execute(context: WorkerContext): Promise<WorkerResult> {
    console.log(`[Worker:${this.workerType}] Starting execution for: ${context.objective}`);
    
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(context);
    const toolConfig = this.getToolConfig();
    
    let turn = 0;
    const maxTurns = context.maxTurns || 5;
    const artifacts: Artifact[] = [];
    const observations: string[] = [];
    const toolsUsed = new Set<string>();
    let totalTokens = 0;
    let thinkingTokens = 0;
    
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    
    while (turn < maxTurns) {
      turn++;
      console.log(`[Worker:${this.workerType}] Turn ${turn}/${maxTurns}`);
      
      try {
        const response = await this.gemini.generateWithNativeTools(
          messages,
          {
            ...toolConfig,
            stream: false,
            thinkingConfig: { thinkingBudget: 4096, includeThoughts: false }
          }
        );
        
        if (response.usageMetadata) {
          totalTokens += response.usageMetadata.totalTokens || 0;
          thinkingTokens += response.usageMetadata.totalTokens || 0;
        }
        
        if (response.searchResults) {
          toolsUsed.add('google_search');
          observations.push(`Searched and found ${response.searchResults.length} results`);
        }
        
        if (response.codeExecutionResults) {
          toolsUsed.add('code_execution');
          observations.push(`Executed code with ${response.codeExecutionResults.length} results`);
        }
        
        messages.push({ role: 'assistant', content: response.text });
        
        // Extract artifacts
        const turnArtifacts = this.extractArtifacts(response.text, context);
        artifacts.push(...turnArtifacts);
        
        // Check if worker signals completion
        if (this.isComplete(response.text)) {
          console.log(`[Worker:${this.workerType}] Task complete at turn ${turn}`);
          break;
        }
        
        // Continue iteration with reflection prompt
        if (turn < maxTurns) {
          messages.push({
            role: 'user',
            content: 'Continue with next step or provide final deliverable.'
          });
        }
        
      } catch (error) {
        console.error(`[Worker:${this.workerType}] Error at turn ${turn}:`, error);
        return {
          success: false,
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          artifacts: [],
          observations,
          metadata: {
            turnsUsed: turn,
            toolsUsed: Array.from(toolsUsed),
            tokensConsumed: totalTokens,
            thinkingTokens
          }
        };
      }
    }
    
    // Extract final output
    const finalOutput = this.extractFinalOutput(messages);
    
    return {
      success: true,
      output: finalOutput,
      artifacts,
      observations,
      metadata: {
        turnsUsed: turn,
        toolsUsed: Array.from(toolsUsed),
        tokensConsumed: totalTokens,
        thinkingTokens
      }
    };
  }
  
  /**
   * Build system prompt - must be implemented by subclasses
   */
  protected abstract buildSystemPrompt(context: WorkerContext): string;
  
  /**
   * Build user prompt with context
   */
  protected buildUserPrompt(context: WorkerContext): string {
    const parts: string[] = [];
    
    parts.push(`<objective>${context.objective}</objective>`);
    
    if (context.stepDescription) {
      parts.push(`<step_description>${context.stepDescription}</step_description>`);
    }
    
    if (context.constraints.length > 0) {
      parts.push(`<constraints>`);
      context.constraints.forEach(c => parts.push(`- ${c}`));
      parts.push(`</constraints>`);
    }
    
    if (context.previousStepOutputs && context.previousStepOutputs.length > 0) {
      parts.push(`<previous_outputs>`);
      context.previousStepOutputs.forEach((o, i) => {
        parts.push(`Step ${i + 1} output: ${o}`);
      });
      parts.push(`</previous_outputs>`);
    }
    
    parts.push(`\n<instructions>`);
    parts.push(`You have ${context.maxTurns} turns to complete this task.`);
    parts.push(`Provide clear, actionable deliverables.`);
    parts.push(`When complete, end your response with: [TASK_COMPLETE]`);
    parts.push(`</instructions>`);
    
    return parts.join('\n');
  }
  
  /**
   * Get tool configuration - must be implemented by subclasses
   */
  protected abstract getToolConfig(): WorkerConfig;
  
  /**
   * Check if worker signals completion
   */
  protected isComplete(text: string): boolean {
    return text.includes('[TASK_COMPLETE]') || 
           text.toLowerCase().includes('task complete') ||
           text.toLowerCase().includes('deliverable ready');
  }
  
  /**
   * Extract artifacts from worker output
   */
  protected extractArtifacts(text: string, context: WorkerContext): Artifact[] {
    const artifacts: Artifact[] = [];
    
    // Look for code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    let codeBlockCount = 0;
    
    while ((match = codeBlockRegex.exec(text)) !== null) {
      codeBlockCount++;
      const language = match[1] || 'text';
      const content = match[2];
      
      artifacts.push({
        id: `artifact_${Date.now()}_${codeBlockCount}`,
        type: 'code',
        title: `${this.workerType} code output ${codeBlockCount}`,
        content,
        createdAt: Date.now(),
        metadata: {
          language,
          workerType: this.workerType
        }
      });
    }
    
    return artifacts;
  }
  
  /**
   * Extract final output from conversation
   */
  protected extractFinalOutput(messages: Array<{ role: string; content: string }>): string {
    const assistantMessages = messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content);
    
    if (assistantMessages.length === 0) {
      return 'No output generated';
    }
    
    // Return the last assistant message (final deliverable)
    return assistantMessages[assistantMessages.length - 1]
      .replace('[TASK_COMPLETE]', '')
      .trim();
  }
}
