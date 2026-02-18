/**
 * Test script for the Planning Agent
 *
 * This script demonstrates the Planning Agent's ability to:
 * - Generate personalized workout plans using LLM
 * - Respect physical constraints from memories
 * - Provide explanations for plan decisions
 */

import 'reflect-metadata';
import { AppDataSource } from './database/data-source';
import { planningAgent } from './agents/planning-agent';
import { memoryAgent } from './agents/memory-agent';
import { Memory } from './entities/Memory';

async function main() {
  console.log('=== Planning Agent Test ===\n');

  // Initialize database
  await AppDataSource.initialize();
  console.log('✓ Database connected\n');

  // Test 1: Generate plan without any constraints
  console.log('--- Test 1: Plan without constraints ---');
  const plan1 = await planningAgent.generatePlan(
    'I want a high-intensity cardio workout',
    []
  );
  console.log('Generated Plan:');
  console.log(`  Type: ${plan1.type}`);
  console.log(`  Duration: ${plan1.duration} minutes`);
  console.log(`  Description: ${plan1.description}`);
  console.log(`  Explanation: ${plan1.explanation}\n`);

  // Test 2: Generate plan WITH constraints (simulate knee injury)
  console.log('--- Test 2: Plan with knee injury constraint ---');

  // First, extract a knee injury memory
  await memoryAgent.extractMemories('I have a knee injury and cannot do high-impact exercises');

  // Retrieve memories
  const memories = await memoryAgent.getAllMemories();
  console.log(`Retrieved ${memories.length} memories from database\n`);

  // Generate plan with constraint
  const plan2 = await planningAgent.generatePlan(
    'I want an effective cardio workout',
    memories
  );
  console.log('Generated Plan (with constraint):');
  console.log(`  Type: ${plan2.type}`);
  console.log(`  Duration: ${plan2.duration} minutes`);
  console.log(`  Description: ${plan2.description}`);
  console.log(`  Explanation: ${plan2.explanation}\n`);

  // Test 3: Generate plan with multiple constraints and preferences
  console.log('--- Test 3: Plan with multiple context factors ---');
  await memoryAgent.extractMemories('I prefer morning workouts and I want to build upper body strength');

  const allMemories = await memoryAgent.getAllMemories();
  const plan3 = await planningAgent.generatePlan(
    'Create a strength workout for me',
    allMemories
  );
  console.log('Generated Plan (with multiple constraints):');
  console.log(`  Type: ${plan3.type}`);
  console.log(`  Duration: ${plan3.duration} minutes`);
  console.log(`  Description: ${plan3.description}`);
  console.log(`  Explanation: ${plan3.explanation}\n`);

  console.log('✓ All tests completed successfully');
  await AppDataSource.destroy();
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
