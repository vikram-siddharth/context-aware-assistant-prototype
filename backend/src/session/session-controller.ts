import { CoreMessage } from 'ai';
import { Memory } from '../entities/Memory';

/**
 * Session Controller
 * Manages conversation history and cached memories per session ID in memory
 */
export class SessionController {
  private sessions: Map<string, CoreMessage[]>;
  private sessionMemories: Map<string, Memory[]>;

  constructor() {
    this.sessions = new Map();
    this.sessionMemories = new Map();
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
   * Clear conversation history and cached memories for a session
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionMemories.delete(sessionId);
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
}

// Export a singleton instance
export const sessionController = new SessionController();
