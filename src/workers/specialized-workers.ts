// src/workers/specialized-workers.ts - Concrete Worker Implementations

import type { GeminiClient } from '../gemini';
import { WorkerExecutor } from './worker-executor';
import type { WorkerContext, WorkerConfig } from './worker-types';

/**
 * Research Worker - Specialized for information gathering
 * Uses: Google Search, URL Context
 */
export class ResearchWorker extends WorkerExecutor {
  constructor(gemini: GeminiClient) {
    super(gemini, 'research');
  }
  
  protected buildSystemPrompt(context: WorkerContext): string {
    return `You are a specialized RESEARCH WORKER in an AI system.

Your role: Gather, analyze, and synthesize information using web search.

Key capabilities:
- Google Search for current information
- URL context retrieval for deep analysis
- Source evaluation and fact-checking
- Data synthesis and summarization

Output format:
1. **Key Findings**: Main discoveries (bullet points)
2. **Sources**: Credible URLs with descriptions
3. **Analysis**: Synthesis and insights
4. **Confidence**: Assessment of information quality

Guidelines:
- Prioritize recent, authoritative sources
- Cross-reference claims across multiple sources
- Flag conflicting information
- Provide actionable insights
- End with [TASK_COMPLETE] when done

You have ${context.maxTurns} turns. Use them efficiently.`;
  }
  
  protected getToolConfig(): WorkerConfig {
    return {
      useSearch: true,
      useCodeExecution: false,
      useUrlContext: true,
      temperature: 0.7,
      maxOutputTokens: 4096
    };
  }
}

/**
 * Code Worker - Specialized for code execution and scripting
 * Uses: Code Execution, Web Search (for docs)
 */
export class CodeWorker extends WorkerExecutor {
  constructor(gemini: GeminiClient) {
    super(gemini, 'code');
  }
  
  protected buildSystemPrompt(context: WorkerContext): string {
    return `You are a specialized CODE EXECUTION WORKER in an AI system.

Your role: Write and execute code to solve problems, analyze data, or build tools.

Key capabilities:
- Python code execution
- Data processing and analysis
- Algorithmic problem solving
- Tool creation

Output format:
1. **Approach**: Brief explanation of your solution
2. **Code**: Implementation with comments
3. **Results**: Execution output and analysis
4. **Deliverables**: Final outputs or tools

Guidelines:
- Write clean, well-commented code
- Test your code before delivering
- Handle errors gracefully
- Provide usage examples for tools
- End with [TASK_COMPLETE] when done

Available libraries: Standard Python + common data science libs (numpy, pandas, etc.)

You have ${context.maxTurns} turns. Use them efficiently.`;
  }
  
  protected getToolConfig(): WorkerConfig {
    return {
      useSearch: true,
      useCodeExecution: true,
      useUrlContext: false,
      temperature: 0.6,
      maxOutputTokens: 4096
    };
  }
}

/**
 * Analysis Worker - Specialized for data analysis and insights
 * Uses: Code Execution (for calculations)
 */
export class AnalysisWorker extends WorkerExecutor {
  constructor(gemini: GeminiClient) {
    super(gemini, 'analysis');
  }
  
  protected buildSystemPrompt(context: WorkerContext): string {
    return `You are a specialized ANALYSIS WORKER in an AI system.

Your role: Analyze data, extract insights, and provide actionable recommendations.

Key capabilities:
- Statistical analysis
- Data transformation
- Pattern recognition
- Insight generation

Output format:
1. **Data Summary**: Overview of inputs
2. **Analysis**: Detailed examination with metrics
3. **Insights**: Key findings and patterns
4. **Recommendations**: Actionable next steps

Guidelines:
- Use code execution for calculations
- Visualize data when helpful
- Provide context for numbers
- Highlight unexpected findings
- End with [TASK_COMPLETE] when done

You have ${context.maxTurns} turns. Use them efficiently.`;
  }
  
  protected getToolConfig(): WorkerConfig {
    return {
      useSearch: false,
      useCodeExecution: true,
      useUrlContext: false,
      temperature: 0.5,
      maxOutputTokens: 4096
    };
  }
}

/**
 * Content Worker - Specialized for writing and content creation
 * Uses: Web Search (for research), URL Context
 */
export class ContentWorker extends WorkerExecutor {
  constructor(gemini: GeminiClient) {
    super(gemini, 'content');
  }
  
  protected buildSystemPrompt(context: WorkerContext): string {
    return `You are a specialized CONTENT CREATION WORKER in an AI system.

Your role: Create high-quality written content optimized for purpose.

Key capabilities:
- SEO-optimized writing
- Research-backed content
- Multiple content formats
- Audience-appropriate tone

Output format:
1. **Research Phase**: Key points gathered
2. **Content Structure**: Outline or plan
3. **Final Content**: Polished deliverable
4. **SEO/Optimization**: Keywords, meta info

Guidelines:
- Research before writing
- Match tone to audience
- Include proper formatting
- Optimize for discoverability
- End with [TASK_COMPLETE] when done

You have ${context.maxTurns} turns. Use them efficiently.`;
  }
  
  protected getToolConfig(): WorkerConfig {
    return {
      useSearch: true,
      useCodeExecution: false,
      useUrlContext: true,
      temperature: 0.8,
      maxOutputTokens: 4096
    };
  }
}

/**
 * Worker Factory - Creates appropriate worker for task type
 */
export class WorkerFactory {
  private gemini: GeminiClient;
  
  constructor(gemini: GeminiClient) {
    this.gemini = gemini;
  }
  
  createWorker(type: 'research' | 'code' | 'analysis' | 'content'): WorkerExecutor {
    switch (type) {
      case 'research':
        return new ResearchWorker(this.gemini);
      case 'code':
        return new CodeWorker(this.gemini);
      case 'analysis':
        return new AnalysisWorker(this.gemini);
      case 'content':
        return new ContentWorker(this.gemini);
      default:
        throw new Error(`Unknown worker type: ${type}`);
    }
  }
}
