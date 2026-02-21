import { CoreMessage } from 'ai';
import { Memory } from '../entities/Memory';
import { WorkoutStatus } from '../entities/Workout';

export interface PendingMemoryChange {
  memoryId: string;
  armedAtTurn: number;
}

export interface PendingMemoryChangeSet {
  changes: Map<string, PendingMemoryChange>;  // keyed by memoryId
  currentTurn: number;
}

export interface PendingProposal {
  type: string;
  duration: number;
  date: string;           // ISO YYYY-MM-DD, converted to Date at execution time
  description: string;
  status: WorkoutStatus;
  explanation: string;    // user-facing reasoning from PlanningAgent
  goal: string;           // original user goal, preserved for re-planning
}

/**
 * Session Controller
 * Manages conversation history and cached memories per session ID in memory
 */
export class SessionController {
  private sessions: Map<string, CoreMessage[]>;
  private sessionMemories: Map<string, Memory[]>;
  private pendingProposals: Map<string, PendingProposal>;
  private pendingMemoryChanges: Map<string, PendingMemoryChangeSet>;
  private sessionUsers: Map<string, string>;  // sessionId → userId

  constructor() {
    this.sessions = new Map();
    this.sessionMemories = new Map();
    this.pendingProposals = new Map();
    this.pendingMemoryChanges = new Map();
    this.sessionUsers = new Map();
  }

  /**
   * Add a message to a session's conversation history
   */
  addMessage(sessionId: string, message: CoreMessage): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }

    const history = this.sessions.get(sessionId)!;
    history.push(message);
  }

  /**
   * Get the conversation history for a session
   * Returns empty array if session doesn't exist
   */
  getHistory(sessionId: string): CoreMessage[] {
    return this.sessions.get(sessionId) || [];
  }

  /**
   * Store loaded memories for a session
   */
  setSessionMemories(sessionId: string, memories: Memory[]): void {
    this.sessionMemories.set(sessionId, memories);
  }

  /**
   * Get cached memories for a session, or null if not yet loaded
   */
  getSessionMemories(sessionId: string): Memory[] | null {
    return this.sessionMemories.get(sessionId) ?? null;
  }

  /**
   * Check if memories have been loaded for this session
   */
  hasLoadedMemories(sessionId: string): boolean {
    return this.sessionMemories.has(sessionId);
  }

  /**
   * Associate a session with a user ID.
   */
  setSessionUser(sessionId: string, userId: string): void {
    this.sessionUsers.set(sessionId, userId);
  }

  /**
   * Get the user ID associated with a session, or null if not set.
   */
  getSessionUser(sessionId: string): string | null {
    return this.sessionUsers.get(sessionId) ?? null;
  }

  /**
   * Clear conversation history and cached memories for a session
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionMemories.delete(sessionId);
    this.pendingProposals.delete(sessionId);
    this.pendingMemoryChanges.delete(sessionId);
    this.sessionUsers.delete(sessionId);
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Store a pending proposal for a session.
   * Only one proposal can be pending at a time — setting a new one overwrites the old.
   */
  setPendingProposal(sessionId: string, proposal: PendingProposal): void {
    this.pendingProposals.set(sessionId, proposal);
  }

  /**
   * Get the pending proposal for a session, or null if none exists.
   */
  getPendingProposal(sessionId: string): PendingProposal | null {
    return this.pendingProposals.get(sessionId) ?? null;
  }

  /**
   * Clear the pending proposal for a session.
   */
  clearPendingProposal(sessionId: string): void {
    this.pendingProposals.delete(sessionId);
  }

  /**
   * Check if a session has a pending proposal.
   */
  hasPendingProposal(sessionId: string): boolean {
    return this.pendingProposals.has(sessionId);
  }

  /**
   * Arm specific memory IDs as authorized for mutation.
   * Only adds entries that don't already exist (preserves original armedAtTurn).
   * Called by the extraction path (pre-arming) and the inference path (block-then-retry).
   */
  armPendingMemoryChanges(sessionId: string, memoryIds: string[]): void {
    if (!this.pendingMemoryChanges.has(sessionId)) {
      this.pendingMemoryChanges.set(sessionId, {
        changes: new Map(),
        currentTurn: 0,
      });
    }
    const changeSet = this.pendingMemoryChanges.get(sessionId)!;
    for (const memoryId of memoryIds) {
      if (!changeSet.changes.has(memoryId)) {
        changeSet.changes.set(memoryId, {
          memoryId,
          armedAtTurn: changeSet.currentTurn,
        });
      }
    }
  }

  /**
   * Check if a specific memory ID is authorized for mutation.
   */
  isMemoryChangeAuthorized(sessionId: string, memoryId: string): boolean {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    if (!changeSet) return false;
    return changeSet.changes.has(memoryId);
  }

  /**
   * Remove a single memory ID's authorization after successful tool execution.
   * Cleans up the PendingMemoryChangeSet if no changes remain.
   */
  consumeMemoryChange(sessionId: string, memoryId: string): void {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    if (!changeSet) return;
    changeSet.changes.delete(memoryId);
    if (changeSet.changes.size === 0) {
      this.pendingMemoryChanges.delete(sessionId);
    }
  }

  /**
   * Increment the turn counter for a session. Called at the start of processMessage.
   */
  incrementTurn(sessionId: string): void {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    if (changeSet) {
      changeSet.currentTurn++;
    }
  }

  /**
   * Expire any pending memory changes older than maxTurns.
   * Called at the start of processMessage, after incrementing the turn.
   */
  expireStaleChanges(sessionId: string, maxTurns: number = 3): void {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    if (!changeSet) return;
    for (const [memoryId, change] of changeSet.changes) {
      if (changeSet.currentTurn - change.armedAtTurn > maxTurns) {
        changeSet.changes.delete(memoryId);
      }
    }
    if (changeSet.changes.size === 0) {
      this.pendingMemoryChanges.delete(sessionId);
    }
  }

  /**
   * Check if any pending memory changes exist for a session.
   */
  hasPendingMemoryChanges(sessionId: string): boolean {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    return changeSet !== undefined && changeSet.changes.size > 0;
  }

  /**
   * Get all pending memory IDs for a session.
   */
  getPendingMemoryChangeIds(sessionId: string): string[] {
    const changeSet = this.pendingMemoryChanges.get(sessionId);
    if (!changeSet) return [];
    return Array.from(changeSet.changes.keys());
  }
}

// Export a singleton instance
export const sessionController = new SessionController();
