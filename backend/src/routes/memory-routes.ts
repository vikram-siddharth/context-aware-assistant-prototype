import { Router, Request, Response } from 'express';
import { memoryAgent } from '../agents/memory-agent';

const router = Router();

/**
 * GET /api/memories
 * Returns all active memories with metadata.
 * Direct read access — bypasses the Orchestrator (Decision 13).
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing required query parameter: userId' });
      return;
    }

    const memories = await memoryAgent.getAllMemories(userId);

    res.json({
      memories: memories.map((m) => ({
        id: m.id,
        fact: m.fact,
        category: m.category,
        estimated_expiry: m.estimated_expiry,
        created_at: m.created_at,
      })),
    });
  } catch (error) {
    console.error('[MemoryRoutes] Error fetching memories:', error);
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

export default router;
