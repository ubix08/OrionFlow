// src/core/phase-manager.ts - Conversation Phase State Machine

export type ConversationPhase = 
  | 'discovery'      // Understanding user intent, gathering context
  | 'planning'       // Creating task plans and todo structure
  | 'execution'      // Running task steps via workers
  | 'review'         // Checking step outputs, user validation
  | 'delivery';      // Final presentation and completion

export interface PhaseTransition {
  from: ConversationPhase;
  to: ConversationPhase;
  reason: string;
  timestamp: number;
}

export interface PhaseContext {
  currentPhase: ConversationPhase;
  activeTaskId: string | null;
  currentStepNumber: number | null;
  history: PhaseTransition[];
}

/**
 * Manages conversation phase state machine
 * Ensures valid transitions and maintains phase history
 */
export class PhaseManager {
  private context: PhaseContext;
  
  private readonly validTransitions: Record<ConversationPhase, ConversationPhase[]> = {
    discovery: ['planning', 'execution', 'delivery'], // Can skip planning for simple tasks
    planning: ['execution', 'discovery'],             // Can go back to refine
    execution: ['review', 'discovery', 'delivery'],   // Can pause/restart or skip review
    review: ['execution', 'delivery', 'discovery'],   // Continue, finish, or restart
    delivery: ['discovery']                           // Start new task
  };

  constructor(initialPhase: ConversationPhase = 'discovery') {
    this.context = {
      currentPhase: initialPhase,
      activeTaskId: null,
      currentStepNumber: null,
      history: []
    };
  }

  // -----------------------------------------------------------
  // Phase Queries
  // -----------------------------------------------------------

  getCurrentPhase(): ConversationPhase {
    return this.context.currentPhase;
  }

  getActiveTaskId(): string | null {
    return this.context.activeTaskId;
  }

  getCurrentStepNumber(): number | null {
    return this.context.currentStepNumber;
  }

  getContext(): PhaseContext {
    return { ...this.context };
  }

  isInTaskExecution(): boolean {
    return this.context.activeTaskId !== null;
  }

  // -----------------------------------------------------------
  // Phase Transitions
  // -----------------------------------------------------------

  canTransition(to: ConversationPhase): boolean {
    return this.validTransitions[this.context.currentPhase].includes(to);
  }

  transitionTo(phase: ConversationPhase, reason: string): void {
    if (!this.canTransition(phase)) {
      throw new Error(
        `Invalid phase transition: ${this.context.currentPhase} -> ${phase}. ` +
        `Valid transitions: ${this.validTransitions[this.context.currentPhase].join(', ')}`
      );
    }

    const transition: PhaseTransition = {
      from: this.context.currentPhase,
      to: phase,
      reason,
      timestamp: Date.now()
    };

    this.context.history.push(transition);
    this.context.currentPhase = phase;

    console.log(`[Phase] ${transition.from} -> ${transition.to}: ${reason}`);

    // Reset task context if returning to discovery
    if (phase === 'discovery') {
      this.context.activeTaskId = null;
      this.context.currentStepNumber = null;
    }
  }

  // -----------------------------------------------------------
  // Task Context Management
  // -----------------------------------------------------------

  setActiveTask(taskId: string, initialStep: number = 1): void {
    this.context.activeTaskId = taskId;
    this.context.currentStepNumber = initialStep;
    console.log(`[Phase] Active task set: ${taskId}, step ${initialStep}`);
  }

  advanceStep(): void {
    if (this.context.currentStepNumber !== null) {
      this.context.currentStepNumber++;
      console.log(`[Phase] Advanced to step ${this.context.currentStepNumber}`);
    }
  }

  clearActiveTask(): void {
    const wasActive = this.context.activeTaskId;
    this.context.activeTaskId = null;
    this.context.currentStepNumber = null;
    if (wasActive) {
      console.log(`[Phase] Cleared active task: ${wasActive}`);
    }
  }

  // -----------------------------------------------------------
  // Phase Recommendations
  // -----------------------------------------------------------

  recommendNextPhase(situation: {
    hasActiveTasks?: boolean;
    userRequestedNew?: boolean;
    stepCompleted?: boolean;
    allStepsComplete?: boolean;
    needsUserInput?: boolean;
  }): { phase: ConversationPhase; reason: string } | null {
    const current = this.context.currentPhase;

    // Discovery phase
    if (current === 'discovery') {
      if (situation.hasActiveTasks) {
        return { phase: 'planning', reason: 'Complex task requires planning' };
      }
      if (situation.userRequestedNew) {
        return { phase: 'execution', reason: 'Simple task, execute directly' };
      }
    }

    // Planning phase
    if (current === 'planning') {
      return { phase: 'execution', reason: 'Plan ready, begin execution' };
    }

    // Execution phase
    if (current === 'execution') {
      if (situation.stepCompleted && situation.needsUserInput) {
        return { phase: 'review', reason: 'Step complete, needs validation' };
      }
      if (situation.allStepsComplete) {
        return { phase: 'delivery', reason: 'All steps complete' };
      }
    }

    // Review phase
    if (current === 'review') {
      if (situation.allStepsComplete) {
        return { phase: 'delivery', reason: 'Task complete after review' };
      }
      return { phase: 'execution', reason: 'Continue to next step' };
    }

    // Delivery phase
    if (current === 'delivery') {
      return { phase: 'discovery', reason: 'Ready for next task' };
    }

    return null;
  }

  // -----------------------------------------------------------
  // History & Debugging
  // -----------------------------------------------------------

  getHistory(): PhaseTransition[] {
    return [...this.context.history];
  }

  getPhaseStatistics(): {
    totalTransitions: number;
    phaseDistribution: Record<ConversationPhase, number>;
    averageTimeInPhase: Record<ConversationPhase, number>;
  } {
    const distribution: Record<string, number> = {};
    const timeInPhase: Record<string, number[]> = {};

    for (let i = 0; i < this.context.history.length; i++) {
      const transition = this.context.history[i];
      distribution[transition.from] = (distribution[transition.from] || 0) + 1;

      if (i > 0) {
        const prevTransition = this.context.history[i - 1];
        const duration = transition.timestamp - prevTransition.timestamp;
        if (!timeInPhase[prevTransition.to]) {
          timeInPhase[prevTransition.to] = [];
        }
        timeInPhase[prevTransition.to].push(duration);
      }
    }

    const averageTimeInPhase: Record<string, number> = {};
    for (const [phase, times] of Object.entries(timeInPhase)) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      averageTimeInPhase[phase] = Math.round(avg / 1000); // Convert to seconds
    }

    return {
      totalTransitions: this.context.history.length,
      phaseDistribution: distribution as Record<ConversationPhase, number>,
      averageTimeInPhase: averageTimeInPhase as Record<ConversationPhase, number>
    };
  }

  // -----------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------

  toJSON(): PhaseContext {
    return { ...this.context };
  }

  static fromJSON(data: PhaseContext): PhaseManager {
    const manager = new PhaseManager(data.currentPhase);
    manager.context = { ...data };
    return manager;
  }
}
