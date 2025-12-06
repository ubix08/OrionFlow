// src/core/phase-manager.ts - Conversation Phase State Machine

export type ConversationPhase = 'discovery' | 'planning' | 'execution' | 'review' | 'delivery';

export interface PhaseTransition {
  from: ConversationPhase;
  to: ConversationPhase;
  timestamp: number;
  reason: string;
}

export interface PhaseContext {
  currentPhase: ConversationPhase;
  history: PhaseTransition[];
  activeTaskId?: string;
  currentStepNumber?: number;
}

export class PhaseManager {
  private currentPhase: ConversationPhase;
  private history: PhaseTransition[] = [];
  private activeTaskId?: string;
  private currentStepNumber?: number;

  constructor(initialPhase: ConversationPhase = 'discovery') {
    this.currentPhase = initialPhase;
  }

  getCurrentPhase(): ConversationPhase {
    return this.currentPhase;
  }

  transitionTo(newPhase: ConversationPhase, reason: string): void {
    if (newPhase === this.currentPhase) return;

    this.history.push({
      from: this.currentPhase,
      to: newPhase,
      timestamp: Date.now(),
      reason
    });

    console.log(`[PhaseManager] Transition: ${this.currentPhase} → ${newPhase} (${reason})`);
    this.currentPhase = newPhase;
  }

  setActiveTask(taskId: string, stepNumber: number): void {
    this.activeTaskId = taskId;
    this.currentStepNumber = stepNumber;
  }

  clearActiveTask(): void {
    this.activeTaskId = undefined;
    this.currentStepNumber = undefined;
  }

  getContext(): PhaseContext {
    return {
      currentPhase: this.currentPhase,
      history: [...this.history],
      activeTaskId: this.activeTaskId,
      currentStepNumber: this.currentStepNumber
    };
  }

  reset(): void {
    this.currentPhase = 'discovery';
    this.history = [];
    this.activeTaskId = undefined;
    this.currentStepNumber = undefined;
  }
}
