import { Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Workout, WorkoutStatus } from '../entities/Workout';

// Type definitions for inputs and outputs
export interface CreateWorkoutInput {
  type: string;
  duration: number;
  date: Date;
  description?: string;
  status?: WorkoutStatus;
}

export interface UpdateWorkoutInput {
  type?: string;
  duration?: number;
  date?: Date;
  description?: string | null;
  status?: WorkoutStatus;
}

export interface GetWorkoutsFilter {
  status?: WorkoutStatus;
  startDate?: Date;
  endDate?: Date;
  type?: string;
}

export class TaskAgent {
  private workoutRepository: Repository<Workout>;

  constructor() {
    this.workoutRepository = AppDataSource.getRepository(Workout);
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
    });

    return await this.workoutRepository.save(workout);
  }

  /**
   * Get workouts with optional filtering
   */
  async getWorkouts(filter?: GetWorkoutsFilter): Promise<Workout[]> {
    const queryBuilder = this.workoutRepository.createQueryBuilder('workout');

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
  async getWorkoutStats(): Promise<{
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
  }> {
    const [total, scheduled, completed, cancelled] = await Promise.all([
      this.workoutRepository.count(),
      this.workoutRepository.count({ where: { status: WorkoutStatus.SCHEDULED } }),
      this.workoutRepository.count({ where: { status: WorkoutStatus.COMPLETED } }),
      this.workoutRepository.count({ where: { status: WorkoutStatus.CANCELLED } }),
    ]);

    return { total, scheduled, completed, cancelled };
  }
}

// Export a singleton instance
export const taskAgent = new TaskAgent();
