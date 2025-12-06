// src/core/phase-manager.ts - Conversation Phase State Machine

export type ConversationPhase = 'discovery' | 'planning' | 'execution' | 'review' | 'delivery';

interface PhaseTransition {
  from: ConversationPhase;
  to: ConversationPhase;
  timestamp: number;
  reason: string;
}

interface PhaseContext {
  currentPhase: ConversationPhase;
  activeTaskId?: string;
  currentStepNumber?: number;
  history: PhaseTransition[];
}

/**
 * Manages conversation phases for the admin agent
 * Tracks state transitions and provides context for decision-making
 */
export class PhaseManager {
  private currentPhase: ConversationPhase;
  private activeTaskId?: string;
  private currentStepNumber?: number;
  private transitionHistory: PhaseTransition[] = [];

  constructor(initialPhase: ConversationPhase = 'discovery') {
    this.currentPhase = initialPhase;
  }

  /**
   * Get current phase
   */
  getCurrentPhase(): ConversationPhase {
    return this.currentPhase;
  }

  /**
   * Transition to a new phase
   */
  transitionTo(newPhase: ConversationPhase, reason: string): void {
    if (newPhase === this.currentPhase) {
      return; // No transition needed
    }

    this.transitionHistory.push({
      from: this.currentPhase,
      to: newPhase,
      timestamp: Date.now(),
      reason
    });

    this.currentPhase = newPhase;

    console.log(`[PhaseManager] Transition: ${this.transitionHistory[this.transitionHistory.length - 1].from} → ${newPhase} (${reason})`);
  }

  /**
   * Set active task context
   */
  setActiveTask(taskId: string, stepNumber: number): void {
    this.activeTaskId = taskId;
    this.currentStepNumber = stepNumber;
  }

  /**
   * Clear active task
   */
  clearActiveTask(): void {
    this.activeTaskId = undefined;
    this.currentStepNumber = undefined;
  }

  /**
   * Update current step number
   */
  updateStepNumber(stepNumber: number): void {
    this.currentStepNumber = stepNumber;
  }

  /**
   * Get full phase context
   */
  getContext(): PhaseContext {
    return {
      currentPhase: this.currentPhase,
      activeTaskId: this.activeTaskId,
      currentStepNumber: this.currentStepNumber,
      history: [...this.transitionHistory]
    };
  }

  /**
   * Reset to initial phase
   */
  reset(): void {
    this.currentPhase = 'discovery';
    this.activeTaskId = undefined;
    this.currentStepNumber = undefined;
    this.transitionHistory = [];
  }

  /**
   * Get transition history
   */
  getHistory(): PhaseTransition[] {
    return [...this.transitionHistory];
  }

  /**
   * Check if currently in a specific phase
   */
  isInPhase(phase: ConversationPhase): boolean {
    return this.currentPhase === phase;
  }

  /**
   * Get suggested next phases based on current phase
   */
  getSuggestedNextPhases(): ConversationPhase[] {
    const transitions: Record<ConversationPhase, ConversationPhase[]> = {
      discovery: ['planning', 'execution', 'discovery'], // Can stay in discovery or move forward
      planning: ['execution', 'discovery'], // Can go back to refine or move forward
      execution: ['review', 'delivery', 'execution'], // Can checkpoint, complete, or continue
      review: ['execution', 'delivery'], // Can continue or complete
      delivery: ['discovery'] // Back to start for new tasks
    };

    return transitions[this.currentPhase] || [];
  }
}
