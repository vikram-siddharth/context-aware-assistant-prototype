import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { taskAgent } from './agents/task-agent';

// Load environment variables
dotenv.config();

async function testTaskAgent() {
  try {
    // Connect to database
    console.log('🔌 Connecting to database...');
    await AppDataSource.initialize();
    console.log('✅ Database connected successfully\n');

    // Create a swimming workout for today
    console.log('🏊 Creating swimming workout...');
    const today = new Date();
    const workout = await taskAgent.createWorkout({
      type: 'Swimming',
      duration: 45,
      date: today,
      description: 'Morning swim session',
      user_id: 'test-user',
    });
    console.log('✅ Workout created:', {
      id: workout.id,
      type: workout.type,
      duration: workout.duration,
      date: workout.date,
      status: workout.status,
      description: workout.description,
    });
    console.log('');

    // Fetch all workouts
    console.log('📋 Fetching all workouts...');
    const workouts = await taskAgent.getWorkouts({ user_id: 'test-user' });
    console.log(`✅ Found ${workouts.length} workout(s):\n`);

    workouts.forEach((w, index) => {
      console.log(`Workout ${index + 1}:`);
      console.log(`  ID: ${w.id}`);
      console.log(`  Type: ${w.type}`);
      console.log(`  Duration: ${w.duration} minutes`);
      console.log(`  Date: ${w.date}`);
      console.log(`  Status: ${w.status}`);
      console.log(`  Description: ${w.description || 'N/A'}`);
      console.log(`  Created: ${w.created_at}`);
      console.log('');
    });

    // Get workout stats
    console.log('📊 Workout Statistics:');
    const stats = await taskAgent.getWorkoutStats('test-user');
    console.log(`  Total: ${stats.total}`);
    console.log(`  Scheduled: ${stats.scheduled}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  Cancelled: ${stats.cancelled}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    // Close database connection
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
      console.log('\n🔌 Database connection closed');
    }
    process.exit(0);
  }
}

// Run the test
testTaskAgent();
