import { Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Workout, WorkoutStatus } from '../entities/Workout';
import { ToolProvider, ToolDefinition } from './tool-provider';

// Type definitions for inputs and outputs
export interface CreateWorkoutInput {
  type: string;
  duration: number;
  date: Date;
  description?: string;
  status?: WorkoutStatus;
  user_id: string;
}

export interface UpdateWorkoutInput {
  type?: string;
  duration?: number;
  date?: Date;
  description?: string | null;
  status?: WorkoutStatus;
}

export interface GetWorkoutsFilter {
  user_id: string;
  status?: WorkoutStatus;
  startDate?: Date;
  endDate?: Date;
  type?: string;
}

export class TaskAgent implements ToolProvider {
  private workoutRepository: Repository<Workout>;

  constructor() {
    this.workoutRepository = AppDataSource.getRepository(Workout);
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'get_workouts',
        description:
          'Retrieve workouts with optional filters. Use this when the user asks about their workout history or schedule.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['scheduled', 'completed', 'cancelled'],
              description: 'Filter by workout status',
            },
            type: {
              type: 'string',
              description: 'Filter by workout type',
            },
            startDate: {
              type: 'string',
              description: 'Filter by start date (ISO format)',
            },
            endDate: {
              type: 'string',
              description: 'Filter by end date (ISO format)',
            },
          },
        },
        actionDescription: 'Looking up your workouts...',
        execute: async (input: any) => {
          const filter: GetWorkoutsFilter = { user_id: input.user_id };
          if (input.status) filter.status = input.status as WorkoutStatus;
          if (input.type) filter.type = input.type;
          if (input.startDate) filter.startDate = new Date(input.startDate);
          if (input.endDate) filter.endDate = new Date(input.endDate);

          const workouts = await this.getWorkouts(filter);

          return {
            success: true,
            count: workouts.length,
            workouts: workouts.map((w) => ({
              id: w.id,
              type: w.type,
              duration: w.duration,
              date: w.date instanceof Date ? w.date.toISOString() : String(w.date),
              status: w.status,
              description: w.description,
            })),
          };
        },
      },
      {
        name: 'confirm_proposal',
        description:
          'Confirm and save the pending workout plan. Use this after the user approves the proposed plan. Optionally pass simple modifications (date or duration) that the user requested — for substantive changes like a different workout type, use create_plan instead.',
        inputSchema: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              description: 'Override the proposed date (YYYY-MM-DD format). Use when the user confirms but wants a different day.',
            },
            duration: {
              type: 'number',
              description: 'Override the proposed duration in minutes. Use when the user confirms but wants a different length.',
            },
          },
        },
        actionDescription: 'Saving your workout plan...',
        execute: async (input: CreateWorkoutInput) => {
          const workout = await this.createWorkout(input);
          return {
            success: true,
            workout: {
              id: workout.id,
              type: workout.type,
              duration: workout.duration,
              date: workout.date instanceof Date ? workout.date.toISOString() : String(workout.date),
              description: workout.description,
              status: workout.status,
            },
            message: 'Workout plan confirmed and saved.',
          };
        },
      },
    ];
  }

  /**
   * Create a new workout
   */
  async createWorkout(input: CreateWorkoutInput): Promise<Workout> {
    const workout = this.workoutRepository.create({
      type: input.type,
      duration: input.duration,
      date: input.date,
      description: input.description || null,
      status: input.status || WorkoutStatus.SCHEDULED,
      user_id: input.user_id,
    });

    return await this.workoutRepository.save(workout);
  }

  /**
   * Get workouts with optional filtering
   */
  async getWorkouts(filter: GetWorkoutsFilter): Promise<Workout[]> {
    const queryBuilder = this.workoutRepository.createQueryBuilder('workout');

    // Always filter by user
    queryBuilder.andWhere('workout.user_id = :userId', { userId: filter.user_id });

    if (filter?.status) {
      queryBuilder.andWhere('workout.status = :status', { status: filter.status });
    }

    if (filter?.type) {
      queryBuilder.andWhere('workout.type = :type', { type: filter.type });
    }

    if (filter?.startDate) {
      queryBuilder.andWhere('workout.date >= :startDate', { startDate: filter.startDate });
    }

    if (filter?.endDate) {
      queryBuilder.andWhere('workout.date <= :endDate', { endDate: filter.endDate });
    }

    queryBuilder.orderBy('workout.date', 'DESC');

    return await queryBuilder.getMany();
  }

  /**
   * Get a single workout by ID
   */
  async getWorkoutById(id: string): Promise<Workout | null> {
    return await this.workoutRepository.findOne({ where: { id } });
  }

  /**
   * Update an existing workout
   */
  async updateWorkout(id: string, input: UpdateWorkoutInput): Promise<Workout | null> {
    const workout = await this.workoutRepository.findOne({ where: { id } });

    if (!workout) {
      return null;
    }

    // Update only provided fields
    if (input.type !== undefined) workout.type = input.type;
    if (input.duration !== undefined) workout.duration = input.duration;
    if (input.date !== undefined) workout.date = input.date;
    if (input.description !== undefined) workout.description = input.description;
    if (input.status !== undefined) workout.status = input.status;

    return await this.workoutRepository.save(workout);
  }

  /**
   * Delete a workout by ID
   */
  async deleteWorkout(id: string): Promise<boolean> {
    const result = await this.workoutRepository.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /**
   * Get workout statistics
   */
  async getWorkoutStats(userId: string): Promise<{
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
  }> {
    const [total, scheduled, completed, cancelled] = await Promise.all([
      this.workoutRepository.count({ where: { user_id: userId } }),
      this.workoutRepository.count({ where: { status: WorkoutStatus.SCHEDULED, user_id: userId } }),
      this.workoutRepository.count({ where: { status: WorkoutStatus.COMPLETED, user_id: userId } }),
      this.workoutRepository.count({ where: { status: WorkoutStatus.CANCELLED, user_id: userId } }),
    ]);

    return { total, scheduled, completed, cancelled };
  }
}

// Export a singleton instance
export const taskAgent = new TaskAgent();
