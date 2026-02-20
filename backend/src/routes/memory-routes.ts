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
    const memories = await memoryAgent.getAllMemories();

    res.json({
      memories: memories.map((m) => ({
        id: m.id,
        fact: m.fact,
        category: m.category,
        persistence: m.persistence,
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
