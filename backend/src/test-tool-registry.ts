import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { orchestrator } from './orchestrator';
import { sessionController, PendingProposal } from './session/session-controller';
import { taskAgent } from './agents/task-agent';
import { memoryAgent } from './agents/memory-agent';
import { planningAgent } from './agents/planning-agent';
import { WorkoutStatus } from './entities/Workout';
import { ToolProvider, ToolDefinition } from './agents/tool-provider';

dotenv.config();

/**
 * Tests for Decision 12: Dynamic Tool Registration
 *
 * Part A: Registry pattern (structure, composition, collision detection)
 *   1. All 5 tools registered from 3 agents
 *   2. Tool definitions generated in Anthropic format
 *   3. Action descriptions read from registry
 *   4. Collision detection throws on duplicate tool name
 *   5. Unknown tool throws from executeTool
 *   6. Each agent's getTools() returns expected tools
 *
 * Part B: Wrapped execution through registry (DB required)
 *   7. get_workouts executes through registry
 *   8. create_plan wrapper injects memories and stashes proposal
 *   9. confirm_proposal wrapper reads pending proposal and passes to TaskAgent
 *  10. confirm_proposal wrapper returns error when no proposal pending
 *  11. update_memory wrapper refreshes session cache
 *  12. invalidate_memory wrapper refreshes session cache
 */

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

// Access private methods via bracket notation
const buildToolRegistry = (orchestrator as any).buildToolRegistry.bind(orchestrator);
const getToolDefinitions = (orchestrator as any).getToolDefinitions.bind(orchestrator);
const describeToolAction = (orchestrator as any).describeToolAction.bind(orchestrator);
const executeTool = (orchestrator as any).executeTool.bind(orchestrator);

function setCurrentSessionId(sessionId: string): void {
  (orchestrator as any).currentSessionId = sessionId;
}

// ============================================================
// PART A: Registry pattern tests (no DB needed for most)
// ============================================================

function testAllToolsRegistered() {
  console.log('\n--- Test 1: All 5 tools registered from 3 agents ---');
  const registry: Map<string, any> = (orchestrator as any).toolRegistry;

  assert(registry.size === 6, `registry has 6 tools (got ${registry.size})`);
  assert(registry.has('get_workouts'), 'get_workouts registered');
  assert(registry.has('confirm_proposal'), 'confirm_proposal registered');
  assert(registry.has('create_plan'), 'create_plan registered');
  assert(registry.has('update_memory'), 'update_memory registered');
  assert(registry.has('set_memory_expiry'), 'set_memory_expiry registered');
  assert(registry.has('invalidate_memory'), 'invalidate_memory registered');
}

function testToolDefinitionsFormat() {
  console.log('\n--- Test 2: Tool definitions in Anthropic format ---');
  const tools = getToolDefinitions();

  assert(Array.isArray(tools), 'getToolDefinitions returns an array');
  assert(tools.length === 6, `returns 6 tool definitions (got ${tools.length})`);

  for (const tool of tools) {
    assert(typeof tool.name === 'string' && tool.name.length > 0, `${tool.name}: has name`);
    assert(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name}: has description`);
    assert(tool.input_schema !== undefined, `${tool.name}: has input_schema`);
    assert(tool.input_schema.type === 'object', `${tool.name}: input_schema.type is "object"`);
  }

  // Verify specific schemas
  const createPlan = tools.find((t: any) => t.name === 'create_plan');
  assert(createPlan.input_schema.properties.goal !== undefined, 'create_plan has goal property');
  assert(createPlan.input_schema.required?.includes('goal'), 'create_plan requires goal');

  const confirmProposal = tools.find((t: any) => t.name === 'confirm_proposal');
  const confirmProps = Object.keys(confirmProposal.input_schema.properties || {});
  assert(confirmProps.length === 0, 'confirm_proposal has no properties (takes no args)');

  const setMemExpiry = tools.find((t: any) => t.name === 'set_memory_expiry');
  assert(setMemExpiry.input_schema.required?.includes('memoryId'), 'set_memory_expiry requires memoryId');
  assert(setMemExpiry.input_schema.required?.includes('date'), 'set_memory_expiry requires date');

  const updateMemory = tools.find((t: any) => t.name === 'update_memory');
  assert(updateMemory.input_schema.required?.includes('memoryId'), 'update_memory requires memoryId');
  assert(updateMemory.input_schema.required?.includes('newFact'), 'update_memory requires newFact');
  assert(updateMemory.input_schema.required?.includes('reason'), 'update_memory requires reason');

  // Verify create_workout is NOT exposed
  const createWorkout = tools.find((t: any) => t.name === 'create_workout');
  assert(createWorkout === undefined, 'create_workout is NOT exposed to LLM');
}

function testActionDescriptions() {
  console.log('\n--- Test 3: Action descriptions from registry ---');

  assert(describeToolAction('get_workouts') === 'Looking up your workouts...', 'get_workouts description');
  assert(describeToolAction('create_plan') === 'Creating a personalized workout plan...', 'create_plan description');
  assert(describeToolAction('confirm_proposal') === 'Saving your workout plan...', 'confirm_proposal description');
  assert(describeToolAction('update_memory') === 'Updating my notes...', 'update_memory description');
  assert(describeToolAction('set_memory_expiry') === 'Updating my notes...', 'set_memory_expiry description');
  assert(describeToolAction('invalidate_memory') === 'Updating my notes...', 'invalidate_memory description');
  assert(describeToolAction('nonexistent_tool') === 'Working on that...', 'unknown tool gets default');
}

function testCollisionDetection() {
  console.log('\n--- Test 4: Collision detection throws on duplicate tool name ---');

  // Create two mock providers that both register "get_workouts"
  const providerA: ToolProvider = {
    getTools: () => [{
      name: 'get_workouts',
      description: 'Duplicate tool from provider A',
      inputSchema: { type: 'object' as const },
      actionDescription: 'test',
      execute: async () => ({}),
    }],
  };

  const providerB: ToolProvider = {
    getTools: () => [{
      name: 'get_workouts',
      description: 'Duplicate tool from provider B',
      inputSchema: { type: 'object' as const },
      actionDescription: 'test',
      execute: async () => ({}),
    }],
  };

  let threw = false;
  let errorMessage = '';
  try {
    buildToolRegistry([providerA, providerB]);
  } catch (err: any) {
    threw = true;
    errorMessage = err.message;
  }

  assert(threw, 'buildToolRegistry throws on duplicate tool name');
  assert(errorMessage.includes('get_workouts'), 'error message names the colliding tool');
  assert(errorMessage.includes('collision'), 'error message mentions collision');
}

async function testUnknownToolThrows() {
  console.log('\n--- Test 5: executeTool throws for unknown tool ---');

  let threw = false;
  let errorMessage = '';
  try {
    await executeTool('nonexistent_tool', {});
  } catch (err: any) {
    threw = true;
    errorMessage = err.message;
  }

  assert(threw, 'executeTool throws for unknown tool');
  assert(errorMessage.includes('nonexistent_tool'), 'error message names the unknown tool');
}

function testAgentToolOwnership() {
  console.log('\n--- Test 6: Each agent registers the expected tools ---');

  const taskTools = taskAgent.getTools().map(t => t.name);
  assert(taskTools.includes('get_workouts'), 'TaskAgent owns get_workouts');
  assert(taskTools.includes('confirm_proposal'), 'TaskAgent owns confirm_proposal');
  assert(taskTools.length === 2, `TaskAgent has 2 tools (got ${taskTools.length})`);

  const memoryTools = memoryAgent.getTools().map(t => t.name);
  assert(memoryTools.includes('update_memory'), 'MemoryAgent owns update_memory');
  assert(memoryTools.includes('set_memory_expiry'), 'MemoryAgent owns set_memory_expiry');
  assert(memoryTools.includes('invalidate_memory'), 'MemoryAgent owns invalidate_memory');
  assert(memoryTools.length === 3, `MemoryAgent has 3 tools (got ${memoryTools.length})`);

  const planningTools = planningAgent.getTools().map(t => t.name);
  assert(planningTools.includes('create_plan'), 'PlanningAgent owns create_plan');
  assert(planningTools.length === 1, `PlanningAgent has 1 tool (got ${planningTools.length})`);
}

// ============================================================
// PART B: Wrapped execution through registry (DB required)
// ============================================================

async function testGetWorkoutsViaRegistry() {
  console.log('\n--- Test 7: get_workouts executes through registry ---');
  const sessionId = 'test-reg-7';
  setCurrentSessionId(sessionId);

  const result = await executeTool('get_workouts', {});

  assert(result.success === true, 'returns success: true');
  assert(Array.isArray(result.workouts), 'returns workouts array');
  assert(typeof result.count === 'number', 'returns count');
}

async function testCreatePlanWrapper() {
  console.log('\n--- Test 8: create_plan wrapper injects memories and stashes proposal ---');
  const sessionId = 'test-reg-8';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, []);
  sessionController.clearPendingProposal(sessionId);

  const result = await executeTool('create_plan', {
    goal: 'A gentle 20-minute stretching session',
    date: '2026-03-01',
  });

  assert(result.success === true, 'returns success: true');
  assert(result.proposal !== undefined, 'returns proposal');
  assert(typeof result.proposal.type === 'string', 'proposal has type');
  assert(typeof result.proposal.duration === 'number', 'proposal has duration');
  assert(typeof result.proposal.description === 'string', 'proposal has description');
  assert(typeof result.proposal.explanation === 'string', 'proposal has explanation');
  assert(typeof result.message === 'string', 'returns message about presenting to user');

  // Verify wrapper stashed the proposal
  assert(sessionController.hasPendingProposal(sessionId) === true, 'wrapper stashed proposal in session');
  const stashed = sessionController.getPendingProposal(sessionId)!;
  assert(stashed.type === result.proposal.type, 'stashed type matches returned proposal');
  assert(stashed.date === '2026-03-01', 'stashed date matches provided date');
  assert(stashed.goal === 'A gentle 20-minute stretching session', 'stashed goal preserved');
  assert(stashed.status === WorkoutStatus.SCHEDULED, 'stashed status is SCHEDULED');
}

async function testConfirmProposalWrapper() {
  console.log('\n--- Test 9: confirm_proposal wrapper reads proposal and writes to DB ---');
  const sessionId = 'test-reg-9';
  setCurrentSessionId(sessionId);

  // Stash a proposal manually (simulates create_plan having run)
  const proposal: PendingProposal = {
    type: 'yoga',
    duration: 30,
    date: '2026-02-25',
    description: 'Gentle yoga for flexibility',
    status: WorkoutStatus.SCHEDULED,
    explanation: 'Yoga chosen for recovery',
    goal: 'Plan a yoga session',
  };
  sessionController.setPendingProposal(sessionId, proposal);

  const countBefore = (await taskAgent.getWorkouts()).length;

  // confirm_proposal takes no args — wrapper reads from session
  const result = await executeTool('confirm_proposal', {});

  assert(result.success === true, 'returns success: true');
  assert(result.workout !== undefined, 'returns workout object');
  assert(result.workout.type === 'yoga', 'workout type matches proposal');
  assert(result.workout.duration === 30, 'workout duration matches proposal');
  assert(result.workout.description === 'Gentle yoga for flexibility', 'workout description matches');

  // DB write
  const countAfter = (await taskAgent.getWorkouts()).length;
  assert(countAfter === countBefore + 1, `workout count increased (${countBefore} → ${countAfter})`);

  // Proposal cleared
  assert(sessionController.hasPendingProposal(sessionId) === false, 'wrapper cleared proposal after write');
}

async function testConfirmProposalNoPending() {
  console.log('\n--- Test 10: confirm_proposal wrapper returns error when no proposal ---');
  const sessionId = 'test-reg-10';
  setCurrentSessionId(sessionId);
  sessionController.clearPendingProposal(sessionId);

  const result = await executeTool('confirm_proposal', {});

  assert(result.success === false, 'returns success: false');
  assert(result.message.includes('No pending proposal'), 'error message explains the issue');
}

async function testUpdateMemoryWrapper() {
  console.log('\n--- Test 11: update_memory wrapper refreshes session cache ---');
  const sessionId = 'test-reg-11';
  setCurrentSessionId(sessionId);

  // Create a memory to update
  const memories = await memoryAgent.getAllMemories();
  let testMemory;
  if (memories.length > 0) {
    testMemory = memories[0];
  } else {
    // Extract a memory first
    const extraction = await memoryAgent.extractMemories('I have a bad knee from an old injury');
    if (extraction.newMemories.length > 0) {
      testMemory = extraction.newMemories[0];
    }
  }

  if (!testMemory) {
    console.log('  ⚠️ Skipping: could not create test memory');
    return;
  }

  // Set session memories cache
  sessionController.setSessionMemories(sessionId, [testMemory]);

  const result = await executeTool('update_memory', {
    memoryId: testMemory.id,
    newFact: 'have a recovering knee (improving)',
    reason: 'knee is getting better',
  });

  assert(result.success === true, 'returns success: true');

  // Verify session cache was refreshed (wrapper logic)
  const cached = sessionController.getSessionMemories(sessionId);
  assert(cached !== null, 'session cache still exists after update');
  const updatedInCache = cached!.find(m => m.id === testMemory!.id);
  assert(
    updatedInCache?.fact === 'have a recovering knee (improving)',
    'session cache contains updated fact'
  );
}

async function testInvalidateMemoryWrapper() {
  console.log('\n--- Test 12: invalidate_memory wrapper refreshes session cache ---');
  const sessionId = 'test-reg-12';
  setCurrentSessionId(sessionId);

  // Create a memory to invalidate
  const extraction = await memoryAgent.extractMemories('I am training for a triathlon');
  let testMemory;
  if (extraction.newMemories.length > 0) {
    testMemory = extraction.newMemories[0];
  } else {
    const all = await memoryAgent.getAllMemories();
    if (all.length > 0) testMemory = all[all.length - 1];
  }

  if (!testMemory) {
    console.log('  ⚠️ Skipping: could not create test memory');
    return;
  }

  sessionController.setSessionMemories(sessionId, [testMemory]);

  const result = await executeTool('invalidate_memory', {
    memoryId: testMemory.id,
    reason: 'no longer training for triathlon',
  });

  assert(result.success === true, 'returns success: true');

  // Verify session cache was refreshed — invalidated memory should be gone
  const cached = sessionController.getSessionMemories(sessionId);
  assert(cached !== null, 'session cache still exists after invalidation');
  const stillInCache = cached!.find(m => m.id === testMemory!.id);
  assert(stillInCache === undefined, 'invalidated memory removed from session cache');
}

// ============================================================
// RUNNER
// ============================================================

async function main() {
  console.log('='.repeat(70));
  console.log('DECISION 12: DYNAMIC TOOL REGISTRATION — TESTS');
  console.log('='.repeat(70));

  // Part A: Registry pattern tests (run before DB for the pure ones)
  console.log('\n' + '='.repeat(70));
  console.log('PART A: Registry pattern and structure');
  console.log('='.repeat(70));

  testAllToolsRegistered();
  testToolDefinitionsFormat();
  testActionDescriptions();
  testCollisionDetection();
  await testUnknownToolThrows();
  testAgentToolOwnership();

  // Part B: Execution through registry (DB required)
  console.log('\n' + '='.repeat(70));
  console.log('PART B: Wrapped execution through registry (DB required)');
  console.log('='.repeat(70));

  console.log('\nConnecting to database...');
  await AppDataSource.initialize();
  console.log('Database connected\n');

  try {
    await testGetWorkoutsViaRegistry();
    await testCreatePlanWrapper();
    await testConfirmProposalWrapper();
    await testConfirmProposalNoPending();
    await testUpdateMemoryWrapper();
    await testInvalidateMemoryWrapper();
  } finally {
    console.log('\n' + '='.repeat(70));
    console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log('='.repeat(70));

    await AppDataSource.destroy();
    console.log('Database connection closed');

    if (failed > 0) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
