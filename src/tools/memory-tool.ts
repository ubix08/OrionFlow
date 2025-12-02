// src/tools/memory-tool.ts - Enhanced Memory with Project Context

import type { MemoryManager } from '../memory/memory-manager';
import type { ProjectTool } from './project-tool';
import type { ProjectMetadata, UserContext } from '../types';

export class MemoryTool {
  private memoryManager: MemoryManager | null;
  private projectTool: ProjectTool;
  private userId: string;

  constructor(memoryManager: MemoryManager | null, projectTool: ProjectTool, userId: string) {
    this.memoryManager = memoryManager;
    this.projectTool = projectTool;
    this.userId = userId;
  }

  // =============================================================
  // User Context Building
  // =============================================================

  async getUserContext(): Promise<UserContext> {
    console.log(`[MemoryTool] Building context for user: ${this.userId}`);

    const [recentProjects, unfinishedProjects, preferences] = await Promise.all([
      this.projectTool.getRecentProjects(this.userId, 5),
      this.projectTool.getUnfinishedProjects(this.userId),
      this.getUserPreferences(),
    ]);

    return {
      userId: this.userId,
      recentProjects,
      unfinishedProjects,
      conversationHistory: [], // Filled by caller
      preferences,
    };
  }

  // =============================================================
  // Project-Specific Context
  // =============================================================

  async getProjectContext(projectId: string): Promise<string> {
    console.log(`[MemoryTool] Getting context for project: ${projectId}`);

    try {
      const project = await this.projectTool.getProject(projectId);
      const todo = await this.projectTool.loadTodoDocument(projectId);

      if (!todo) {
        return `Project "${project.title}" found but no execution plan available.`;
      }

      const completed = todo.steps.filter(s => s.status === 'completed').length;
      const inProgress = todo.steps.find(s => s.status === 'in_progress');
      const lastCheckpoint = project.lastCheckpoint;

      const contextParts: string[] = [];

      contextParts.push(`📂 **Project**: ${project.title}`);
      contextParts.push(`**Status**: ${project.status}`);
      contextParts.push(`**Progress**: ${completed}/${todo.steps.length} steps completed`);
      
      if (inProgress) {
        contextParts.push(`**Current Step**: ${inProgress.number}. ${inProgress.title}`);
      }

      if (lastCheckpoint) {
        contextParts.push(`**Last Checkpoint**: Step ${lastCheckpoint}`);
      }

      // Recent activity
      if (project.sessions.length > 0) {
        const lastSession = project.sessions[project.sessions.length - 1];
        const timeAgo = this.formatTimeAgo(Date.now() - lastSession.timestamp);
        contextParts.push(`**Last Activity**: ${lastSession.action} ${timeAgo}`);
      }

      // Memory search for project-specific insights
      if (this.memoryManager) {
        const memories = await this.memoryManager.searchMemory(
          `project ${projectId} insights progress`,
          { topK: 3, threshold: 0.7 }
        );

        if (memories.length > 0) {
          contextParts.push(`\n**Previous Insights**:`);
          for (const mem of memories) {
            contextParts.push(`- ${mem.content.substring(0, 150)}...`);
          }
        }
      }

      return contextParts.join('\n');
    } catch (error) {
      console.error('[MemoryTool] Failed to get project context:', error);
      return `Project ${projectId} not found or inaccessible.`;
    }
  }

  // =============================================================
  // Project Artifact Indexing
  // =============================================================

  async indexProjectArtifacts(projectId: string): Promise<void> {
    if (!this.memoryManager) {
      console.warn('[MemoryTool] Memory manager not available for indexing');
      return;
    }

    console.log(`[MemoryTool] Indexing artifacts for project: ${projectId}`);

    try {
      const files = await this.projectTool.listProjectFiles(projectId, 'results');

      for (const file of files) {
        try {
          const content = await this.projectTool.readProjectFile(projectId, `results/${file}`);
          
          // Create memory entry
          await this.memoryManager.saveMemory({
            content: `Project ${projectId} artifact: ${file}\n\n${content.substring(0, 1000)}`,
            type: 'fact',
            importance: 0.8,
            timestamp: Date.now(),
            metadata: {
              projectId,
              artifactType: 'result',
              filename: file,
            },
          });
        } catch (e) {
          console.warn(`[MemoryTool] Failed to index artifact: ${file}`, e);
        }
      }

      console.log(`[MemoryTool] Indexed ${files.length} artifacts`);
    } catch (error) {
      console.error('[MemoryTool] Indexing failed:', error);
    }
  }

  // =============================================================
  // Cross-Project Search
  // =============================================================

  async searchAcrossProjects(query: string, limit = 5): Promise<Array<{
    projectId: string;
    title: string;
    relevance: string;
  }>> {
    if (!this.memoryManager) return [];

    console.log(`[MemoryTool] Searching across projects: ${query}`);

    const memories = await this.memoryManager.searchAcrossSessions(query, { topK: limit });

    const projectResults: Array<{ projectId: string; title: string; relevance: string }> = [];

    for (const mem of memories) {
      const projectId = mem.metadata?.projectId as string | undefined;
      if (projectId) {
        try {
          const project = await this.projectTool.getProject(projectId);
          projectResults.push({
            projectId,
            title: project.title,
            relevance: mem.content.substring(0, 200),
          });
        } catch {
          // Project might have been deleted
        }
      }
    }

    return projectResults;
  }

  // =============================================================
  // Conversation Memory
  // =============================================================

  async saveConversationMemory(content: string, importance = 0.5): Promise<void> {
    if (!this.memoryManager) return;

    await this.memoryManager.saveMemory({
      content,
      type: 'conversation',
      importance,
      timestamp: Date.now(),
      metadata: { userId: this.userId },
    });
  }

  async getConversationContext(query: string, maxResults = 5): Promise<string> {
    if (!this.memoryManager) return '';

    return await this.memoryManager.buildContext(query, {
      maxResults,
      includeTimestamp: true,
    });
  }

  // =============================================================
  // User Preferences
  // =============================================================

  private async getUserPreferences(): Promise<Record<string, any>> {
    if (!this.memoryManager) return {};

    try {
      const results = await this.memoryManager.searchMemory(
        'user preferences settings',
        { topK: 1, threshold: 0.8 }
      );

      if (results.length > 0 && results[0].metadata?.preferences) {
        return results[0].metadata.preferences as Record<string, any>;
      }
    } catch (e) {
      console.warn('[MemoryTool] Failed to load preferences:', e);
    }

    return {};
  }

  async saveUserPreferences(preferences: Record<string, any>): Promise<void> {
    if (!this.memoryManager) return;

    await this.memoryManager.saveMemory({
      content: `User preferences: ${JSON.stringify(preferences)}`,
      type: 'fact',
      importance: 0.9,
      timestamp: Date.now(),
      metadata: { userId: this.userId, preferences },
    });
  }

  // =============================================================
  // Utilities
  // =============================================================

  private formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
  }

  getMetrics() {
    return this.memoryManager?.getMetrics() || null;
  }
}

export default MemoryTool;
