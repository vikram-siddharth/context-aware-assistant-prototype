import { Router, Request, Response } from 'express';
import { sessionController } from '../session/session-controller';
import { orchestrator, OrchestratorEvent } from '../orchestrator';
import { CoreMessage } from 'ai';

const router = Router();

/**
 * POST /api/chat
 * Process a chat message via Server-Sent Events
 *
 * Request body:
 * - message: string (required) - The user's message
 * - sessionId: string (required) - Unique identifier for this conversation session
 *
 * SSE events:
 * - { type: 'thinking' | 'action' | 'result' | 'error', content: string }
 */
router.post('/', async (req: Request, res: Response) => {
  const { message, sessionId, userId } = req.body;

  // Validate required fields (JSON errors before switching to SSE)
  if (!message || typeof message !== 'string') {
    res.status(400).json({
      error: 'Missing or invalid required field: message (must be a non-empty string)',
    });
    return;
  }

  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({
      error: 'Missing or invalid required field: sessionId (must be a non-empty string)',
    });
    return;
  }

  if (!userId || typeof userId !== 'string') {
    res.status(400).json({
      error: 'Missing or invalid required field: userId (must be a non-empty string)',
    });
    return;
  }

  // Associate this session with the user
  sessionController.setSessionUser(sessionId, userId);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  console.log(`[ChatRoute] SSE stream opened for session ${sessionId}`);

  // Write an SSE event to the response stream
  const sendEvent = (event: OrchestratorEvent) => {
    const data = JSON.stringify(event);
    res.write(`data: ${data}\n\n`);
  };

  try {
    // Get conversation history for this session
    const conversationHistory = sessionController.getHistory(sessionId);

    // Process the message through the orchestrator, streaming events
    const { response: assistantResponse } = await orchestrator.processMessage(
      message,
      conversationHistory,
      sendEvent,
      sessionId,
      userId,
    );

    // Add user message to session history
    sessionController.addMessage(sessionId, {
      role: 'user',
      content: message,
    } as CoreMessage);

    // Add assistant response to session history
    sessionController.addMessage(sessionId, {
      role: 'assistant',
      content: assistantResponse,
    } as CoreMessage);
  } catch (error) {
    console.error('[ChatRoute] Error processing chat message:', error);
    sendEvent({ type: 'error', content: 'Failed to process message. Please try again.' });
  } finally {
    res.end();
  }
});

/**
 * DELETE /api/chat/sessions/:sessionId
 * Clear conversation history for a specific session
 */
router.delete('/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    if (!sessionController.hasSession(sessionId)) {
      res.status(404).json({
        error: 'Session not found',
      });
      return;
    }

    sessionController.clearSession(sessionId);

    res.json({
      message: 'Session cleared successfully',
      sessionId,
    });
  } catch (error) {
    console.error('[ChatRoute] Error clearing session:', error);
    res.status(500).json({
      error: 'Failed to clear session',
    });
  }
});

/**
 * GET /api/chat/sessions
 * Get list of active session IDs
 */
router.get('/sessions', (req: Request, res: Response) => {
  try {
    const activeSessions = sessionController.getActiveSessions();

    res.json({
      sessions: activeSessions,
      count: activeSessions.length,
    });
  } catch (error) {
    console.error('[ChatRoute] Error fetching sessions:', error);
    res.status(500).json({
      error: 'Failed to fetch sessions',
    });
  }
});

export default router;
