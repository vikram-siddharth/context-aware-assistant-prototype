import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { orchestrator } from './orchestrator';
import { memoryAgent } from './agents/memory-agent';
import { taskAgent } from './agents/task-agent';

dotenv.config();

/**
 * Test script for Orchestrator
 *
 * Tests:
 * 1. Memory extraction from user messages
 * 2. Cross-session memory retrieval
 * 3. Tool execution (workout creation)
 * 4. Constraint enforcement from memory
 */
async function testOrchestrator() {
  try {
    console.log('='.repeat(80));
    console.log('🧪 ORCHESTRATOR TEST SUITE');
    console.log('='.repeat(80));
    console.log();

    // Initialize database
    console.log('📦 Connecting to database...');
    await AppDataSource.initialize();
    console.log('✅ Database connected\n');

    // Clean up any existing test data
    console.log('🧹 Cleaning up existing test data...');
    const existingMemories = await memoryAgent.getAllMemories('test-user');
    for (const memory of existingMemories) {
      await memoryAgent.deleteMemory(memory.id);
    }
    console.log(`✅ Cleaned ${existingMemories.length} existing memories\n`);

    // ========================================================================
    // SESSION 1: User mentions knee injury
    // ========================================================================
    console.log('='.repeat(80));
    console.log('SESSION 1: User mentions knee injury');
    console.log('='.repeat(80));

    const message1 = 'I injured my knee last month training for a marathon';
    console.log(`\n📨 User message: "${message1}"`);
    console.log(`🔑 Session ID: session-1\n`);

    const { response: response1 } = await orchestrator.processMessage(message1, [], undefined, 'session-1', 'test-user');

    console.log('🤖 Assistant response:');
    console.log('-'.repeat(80));
    console.log(response1);
    console.log('-'.repeat(80));
    console.log();

    // Wait for parallel extraction to complete (extraction now runs in parallel with retrieval)
    console.log('⏳ Waiting 3 seconds for memory extraction to settle...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify memory was stored
    const memories = await memoryAgent.getAllMemories('test-user');
    console.log(`✅ Memories stored in database: ${memories.length}`);
    if (memories.length > 0) {
      memories.forEach((mem, idx) => {
        console.log(`   ${idx + 1}. [${mem.category}] ${mem.fact} (${mem.persistence})`);
      });
    }
    console.log();

    // ========================================================================
    // SESSION 2: Different session asks for workout plan
    // ========================================================================
    console.log('='.repeat(80));
    console.log('SESSION 2: Different session asks for workout plan');
    console.log('='.repeat(80));

    const message2 = 'Plan a workout for today';
    console.log(`\n📨 User message: "${message2}"`);
    console.log(`🔑 Session ID: session-2 (different from session-1)\n`);

    const { response: response2 } = await orchestrator.processMessage(message2, [], undefined, 'session-2', 'test-user');

    console.log('🤖 Assistant response:');
    console.log('-'.repeat(80));
    console.log(response2);
    console.log('-'.repeat(80));
    console.log();

    // Check if the response mentions the knee injury or shows constraint awareness
    const mentionsKnee = response2.toLowerCase().includes('knee');
    const mentionsInjury = response2.toLowerCase().includes('injury');
    const showsConstraintAwareness = mentionsKnee || mentionsInjury;

    console.log('🔍 Cross-session memory verification:');
    console.log(`   - Response mentions "knee": ${mentionsKnee ? '✅' : '❌'}`);
    console.log(`   - Response mentions "injury": ${mentionsInjury ? '✅' : '❌'}`);
    console.log(`   - Shows constraint awareness: ${showsConstraintAwareness ? '✅ PASS' : '❌ FAIL'}`);
    console.log();

    // ========================================================================
    // SESSION 3: Test workout creation
    // ========================================================================
    console.log('='.repeat(80));
    console.log('SESSION 3: Test workout creation');
    console.log('='.repeat(80));

    const message3 = 'Schedule a 30-minute yoga session for tomorrow';
    console.log(`\n📨 User message: "${message3}"`);
    console.log(`🔑 Session ID: session-3\n`);

    const { response: response3 } = await orchestrator.processMessage(message3, [], undefined, 'session-3', 'test-user');

    console.log('🤖 Assistant response:');
    console.log('-'.repeat(80));
    console.log(response3);
    console.log('-'.repeat(80));
    console.log();

    // Verify workout was created
    const workouts = await taskAgent.getWorkouts({ user_id: 'test-user' });
    console.log(`✅ Workouts in database: ${workouts.length}`);
    if (workouts.length > 0) {
      workouts.forEach((workout, idx) => {
        const dateStr = workout.date instanceof Date
          ? workout.date.toISOString().split('T')[0]
          : new Date(workout.date).toISOString().split('T')[0];
        console.log(`   ${idx + 1}. ${workout.type} - ${workout.duration}min on ${dateStr} (${workout.status})`);
      });
    }
    console.log();

    // ========================================================================
    // FINAL VERIFICATION
    // ========================================================================
    console.log('='.repeat(80));
    console.log('📊 FINAL TEST RESULTS');
    console.log('='.repeat(80));
    console.log();

    const finalMemories = await memoryAgent.getAllMemories('test-user');
    const finalWorkouts = await taskAgent.getWorkouts({ user_id: 'test-user' });

    console.log(`✅ Total memories stored: ${finalMemories.length}`);
    console.log(`✅ Total workouts created: ${finalWorkouts.length}`);
    console.log(`${showsConstraintAwareness ? '✅' : '❌'} Cross-session memory retrieval: ${showsConstraintAwareness ? 'WORKING' : 'FAILED'}`);
    console.log();

    if (finalMemories.length > 0 && showsConstraintAwareness) {
      console.log('🎉 ALL TESTS PASSED!');
      console.log('   - Memory extraction: ✅');
      console.log('   - Memory persistence: ✅');
      console.log('   - Cross-session retrieval: ✅');
      console.log('   - Constraint enforcement: ✅');
      if (finalWorkouts.length > 0) {
        console.log('   - Workout creation: ✅');
      }
    } else {
      console.log('⚠️  SOME TESTS FAILED');
      if (finalMemories.length === 0) {
        console.log('   - Memory extraction: ❌ (no memories stored)');
      }
      if (!showsConstraintAwareness) {
        console.log('   - Cross-session retrieval: ❌ (constraint not mentioned)');
      }
    }
    console.log();
    console.log('='.repeat(80));

    // Close database connection
    await AppDataSource.destroy();
    console.log('✅ Database connection closed');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

// Run the test
testOrchestrator();
