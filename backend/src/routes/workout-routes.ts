import { Router, Request, Response } from 'express';
import { taskAgent } from '../agents/task-agent';
import { WorkoutStatus } from '../entities/Workout';

const router = Router();

/**
 * POST /api/workouts
 * Create a new workout
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { type, duration, date, description, status, userId } = req.body;

    // Validate required fields
    if (!type || !duration || !date) {
      res.status(400).json({
        error: 'Missing required fields: type, duration, date',
      });
      return;
    }

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({
        error: 'Missing required field: userId',
      });
      return;
    }

    // Validate duration is a positive number
    if (typeof duration !== 'number' || duration <= 0) {
      res.status(400).json({
        error: 'Duration must be a positive number',
      });
      return;
    }

    // Validate status if provided
    if (status && !Object.values(WorkoutStatus).includes(status)) {
      res.status(400).json({
        error: 'Invalid status. Must be: scheduled, completed, or cancelled',
      });
      return;
    }

    const workout = await taskAgent.createWorkout({
      type,
      duration,
      date: new Date(date),
      description,
      status,
      user_id: userId,
    });

    res.status(201).json(workout);
  } catch (error) {
    console.error('Error creating workout:', error);
    res.status(500).json({ error: 'Failed to create workout' });
  }
});

/**
 * GET /api/workouts
 * Get all workouts with optional filters
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, type, startDate, endDate, userId } = req.query;

    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: 'Missing required query parameter: userId' });
      return;
    }

    const filter: any = { user_id: userId };

    if (status) {
      if (!Object.values(WorkoutStatus).includes(status as WorkoutStatus)) {
        res.status(400).json({
          error: 'Invalid status filter',
        });
        return;
      }
      filter.status = status as WorkoutStatus;
    }

    if (type) {
      filter.type = type as string;
    }

    if (startDate) {
      filter.startDate = new Date(startDate as string);
    }

    if (endDate) {
      filter.endDate = new Date(endDate as string);
    }

    const workouts = await taskAgent.getWorkouts(filter);
    res.json(workouts);
  } catch (error) {
    console.error('Error fetching workouts:', error);
    res.status(500).json({ error: 'Failed to fetch workouts' });
  }
});

/**
 * GET /api/workouts/stats
 * Get workout statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing required query parameter: userId' });
      return;
    }

    const stats = await taskAgent.getWorkoutStats(userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching workout stats:', error);
    res.status(500).json({ error: 'Failed to fetch workout stats' });
  }
});

/**
 * GET /api/workouts/:id
 * Get a single workout by ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const workout = await taskAgent.getWorkoutById(id);

    if (!workout) {
      res.status(404).json({ error: 'Workout not found' });
      return;
    }

    res.json(workout);
  } catch (error) {
    console.error('Error fetching workout:', error);
    res.status(500).json({ error: 'Failed to fetch workout' });
  }
});

/**
 * PUT /api/workouts/:id
 * Update an existing workout
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type, duration, date, description, status } = req.body;

    // Validate duration if provided
    if (duration !== undefined && (typeof duration !== 'number' || duration <= 0)) {
      res.status(400).json({
        error: 'Duration must be a positive number',
      });
      return;
    }

    // Validate status if provided
    if (status && !Object.values(WorkoutStatus).includes(status)) {
      res.status(400).json({
        error: 'Invalid status. Must be: scheduled, completed, or cancelled',
      });
      return;
    }

    const updateData: any = {};
    if (type !== undefined) updateData.type = type;
    if (duration !== undefined) updateData.duration = duration;
    if (date !== undefined) updateData.date = new Date(date);
    if (description !== undefined) updateData.description = description;
    if (status !== undefined) updateData.status = status;

    const workout = await taskAgent.updateWorkout(id, updateData);

    if (!workout) {
      res.status(404).json({ error: 'Workout not found' });
      return;
    }

    res.json(workout);
  } catch (error) {
    console.error('Error updating workout:', error);
    res.status(500).json({ error: 'Failed to update workout' });
  }
});

/**
 * DELETE /api/workouts/:id
 * Delete a workout
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await taskAgent.deleteWorkout(id);

    if (!deleted) {
      res.status(404).json({ error: 'Workout not found' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting workout:', error);
    res.status(500).json({ error: 'Failed to delete workout' });
  }
});

export default router;
