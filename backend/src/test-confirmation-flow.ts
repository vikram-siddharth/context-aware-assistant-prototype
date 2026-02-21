import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { orchestrator } from './orchestrator';
import { sessionController, PendingProposal } from './session/session-controller';
import { taskAgent } from './agents/task-agent';
import { memoryAgent } from './agents/memory-agent';
import { WorkoutStatus } from './entities/Workout';
import { OrchestratorEvent } from './orchestrator';

dotenv.config();

/**
 * Integration tests for Decision 11: User Confirmation for Domain Actions
 *
 * Part A: Direct executeTool tests (bypass LLM, test mechanical behavior)
 *   1. confirm_proposal with no pending proposal → error
 *   2. confirm_proposal with a manually stashed proposal → writes to DB + clears proposal
 *   3. create_plan stashes a proposal in session state (calls PlanningAgent LLM)
 *
 * Part B: End-to-end two-turn flow (full LLM integration)
 *   4. Plan request → proposal stashed, no workout in DB
 *   5. Confirmation message → workout in DB, proposal cleared
 *   6. Re-planning overwrites existing proposal
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

// Access private executeTool via bracket notation for direct testing
const executeToolDirect = (orchestrator as any).executeTool.bind(orchestrator);

function setCurrentSessionId(sessionId: string): void {
  (orchestrator as any).currentSessionId = sessionId;
}

function setCurrentUserId(userId: string): void {
  (orchestrator as any).currentUserId = userId;
}

async function getWorkoutCount(): Promise<number> {
  const workouts = await taskAgent.getWorkouts({ user_id: 'test-user' });
  return workouts.length;
}

async function cleanWorkouts(): Promise<void> {
  const workouts = await taskAgent.getWorkouts({ user_id: 'test-user' });
  for (const w of workouts) {
    await taskAgent.deleteWorkout(w.id);
  }
}

// ============================================================
// PART A: Direct executeTool tests
// ============================================================

async function testConfirmProposalNoProposal() {
  console.log('\n--- Test A1: confirm_proposal with no pending proposal → error ---');
  const sessionId = 'test-a1';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');

  // Ensure no proposal exists
  sessionController.clearPendingProposal(sessionId);

  const result = await executeToolDirect('confirm_proposal', {});

  assert(result.success === false, 'returns success: false');
  assert(typeof result.message === 'string', 'returns an error message');
  assert(result.message.includes('No pending proposal'), 'message mentions no pending proposal');
}

async function testConfirmProposalWithStashedProposal() {
  console.log('\n--- Test A2: confirm_proposal with stashed proposal → writes to DB ---');
  const sessionId = 'test-a2';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');

  const countBefore = await getWorkoutCount();

  // Manually stash a proposal
  const proposal: PendingProposal = {
    type: 'yoga',
    duration: 30,
    date: '2026-02-20',
    description: 'Gentle yoga session focusing on flexibility',
    status: WorkoutStatus.SCHEDULED,
    explanation: 'Yoga chosen for recovery',
    goal: 'Plan a yoga session',
  };
  sessionController.setPendingProposal(sessionId, proposal);

  assert(sessionController.hasPendingProposal(sessionId) === true, 'proposal stashed before confirm');

  // Call confirm_proposal
  const result = await executeToolDirect('confirm_proposal', {});

  assert(result.success === true, 'returns success: true');
  assert(result.workout !== undefined, 'returns workout object');
  assert(result.workout.type === 'yoga', 'workout type matches proposal');
  assert(result.workout.duration === 30, 'workout duration matches proposal');
  assert(result.workout.description === 'Gentle yoga session focusing on flexibility', 'workout description matches proposal');
  assert(result.workout.status === WorkoutStatus.SCHEDULED, 'workout status matches proposal');

  // Verify DB write
  const countAfter = await getWorkoutCount();
  assert(countAfter === countBefore + 1, `workout count increased (${countBefore} → ${countAfter})`);

  // Verify proposal cleared
  assert(sessionController.hasPendingProposal(sessionId) === false, 'proposal cleared after confirm');
  assert(sessionController.getPendingProposal(sessionId) === null, 'getPendingProposal returns null after confirm');
}

async function testCreatePlanStashesProposal() {
  console.log('\n--- Test A3: create_plan stashes proposal, does NOT write to DB ---');
  const sessionId = 'test-a3';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');

  // Initialize session memory cache (create_plan reads from it)
  sessionController.setSessionMemories(sessionId, []);

  const countBefore = await getWorkoutCount();

  const result = await executeToolDirect('create_plan', {
    goal: 'A gentle 20-minute stretching session',
  });

  assert(result.success === true, 'returns success: true');
  assert(result.proposal !== undefined, 'returns proposal object (not workout)');
  assert(result.proposal.type !== undefined, 'proposal has type');
  assert(result.proposal.duration !== undefined, 'proposal has duration');
  assert(result.proposal.description !== undefined, 'proposal has description');
  assert(result.proposal.explanation !== undefined, 'proposal has explanation');
  assert(result.message !== undefined, 'returns message about presenting to user');

  // Verify NO DB write
  const countAfter = await getWorkoutCount();
  assert(countAfter === countBefore, `workout count unchanged (still ${countBefore})`);

  // Verify proposal stashed in session state
  assert(sessionController.hasPendingProposal(sessionId) === true, 'proposal stashed in session');

  const stashed = sessionController.getPendingProposal(sessionId)!;
  assert(stashed.type === result.proposal.type, 'stashed type matches returned proposal');
  assert(stashed.duration === result.proposal.duration, 'stashed duration matches returned proposal');
  assert(stashed.goal === 'A gentle 20-minute stretching session', 'stashed goal preserved');
  assert(stashed.status === WorkoutStatus.SCHEDULED, 'stashed status is SCHEDULED');
}

async function testCreatePlanThenConfirm() {
  console.log('\n--- Test A4: create_plan → confirm_proposal full round-trip ---');
  const sessionId = 'test-a4';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');

  // Initialize session memory cache
  sessionController.setSessionMemories(sessionId, []);

  const countBefore = await getWorkoutCount();

  // Step 1: Create plan
  const planResult = await executeToolDirect('create_plan', {
    goal: 'A 30-minute cardio workout',
    date: '2026-02-25',
  });

  assert(planResult.success === true, 'create_plan succeeded');
  assert(planResult.proposal.date === '2026-02-25', 'proposal uses provided date');

  const countAfterPlan = await getWorkoutCount();
  assert(countAfterPlan === countBefore, 'no DB write after create_plan');

  // Step 2: Confirm proposal
  const confirmResult = await executeToolDirect('confirm_proposal', {});

  assert(confirmResult.success === true, 'confirm_proposal succeeded');
  assert(confirmResult.workout.type === planResult.proposal.type, 'confirmed workout type matches plan');
  assert(confirmResult.workout.duration === planResult.proposal.duration, 'confirmed workout duration matches plan');

  const countAfterConfirm = await getWorkoutCount();
  assert(countAfterConfirm === countBefore + 1, `one workout created after confirm (${countBefore} → ${countAfterConfirm})`);

  // Proposal should be cleared
  assert(sessionController.hasPendingProposal(sessionId) === false, 'proposal cleared after confirm');
}

async function testCreatePlanDateDefault() {
  console.log('\n--- Test A5: create_plan defaults to today when no date provided ---');
  const sessionId = 'test-a5';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');
  sessionController.setSessionMemories(sessionId, []);

  await executeToolDirect('create_plan', {
    goal: 'Quick stretch',
  });

  const stashed = sessionController.getPendingProposal(sessionId)!;
  const today = new Date().toISOString().split('T')[0];
  assert(stashed.date === today, `date defaults to today (${today})`);
}

async function testReplanOverwritesProposal() {
  console.log('\n--- Test A6: Re-planning overwrites existing proposal ---');
  const sessionId = 'test-a6';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');
  sessionController.setSessionMemories(sessionId, []);

  // First plan
  await executeToolDirect('create_plan', { goal: 'A strength workout' });
  const first = sessionController.getPendingProposal(sessionId)!;
  const firstGoal = first.goal;

  assert(firstGoal === 'A strength workout', 'first proposal stored');

  // Re-plan
  await executeToolDirect('create_plan', { goal: 'A yoga session instead' });
  const second = sessionController.getPendingProposal(sessionId)!;

  assert(second.goal === 'A yoga session instead', 'second proposal overwrites first');
  assert(second.goal !== firstGoal, 'goals are different');
}

async function testDoubleConfirmFails() {
  console.log('\n--- Test A7: Double confirm fails (proposal already consumed) ---');
  const sessionId = 'test-a7';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');
  sessionController.setSessionMemories(sessionId, []);

  // Create and confirm
  await executeToolDirect('create_plan', { goal: 'A quick session' });
  const firstConfirm = await executeToolDirect('confirm_proposal', {});
  assert(firstConfirm.success === true, 'first confirm succeeds');

  // Second confirm should fail
  const secondConfirm = await executeToolDirect('confirm_proposal', {});
  assert(secondConfirm.success === false, 'second confirm fails');
  assert(secondConfirm.message.includes('No pending proposal'), 'second confirm explains why');
}

// ============================================================
// PART B: End-to-end two-turn flow (full LLM integration)
// ============================================================

async function testEndToEndPlanAndConfirm() {
  console.log('\n--- Test B1: End-to-end plan → confirm flow ---');
  const sessionId = 'test-b1-' + Date.now();

  const events: OrchestratorEvent[] = [];
  const onEvent = (event: OrchestratorEvent) => events.push(event);

  const countBefore = await getWorkoutCount();

  // Turn 1: Ask for a plan
  console.log('  Turn 1: Sending planning request...');
  const { response: planResponse } = await orchestrator.processMessage(
    'Plan a 30-minute cardio workout for tomorrow',
    [],
    onEvent,
    sessionId,
    'test-user',
  );

  console.log(`  Response preview: ${planResponse.slice(0, 150)}...`);

  // Verify: events should include "Creating a personalized workout plan..."
  const hasActionEvent = events.some(
    (e) => e.type === 'action' && e.content.includes('workout plan')
  );
  assert(hasActionEvent, 'emitted plan-creation action event');

  // Verify: proposal should be stashed
  assert(sessionController.hasPendingProposal(sessionId) === true, 'proposal stashed after plan request');

  // Verify: no workout should have been written to DB
  const countAfterPlan = await getWorkoutCount();
  assert(countAfterPlan === countBefore, `no DB write after plan (${countBefore} → ${countAfterPlan})`);

  // Turn 2: Confirm the plan
  console.log('  Turn 2: Sending confirmation...');
  events.length = 0; // reset events

  // Build conversation history for turn 2
  const history = [
    { role: 'user' as const, content: 'Plan a 30-minute cardio workout for tomorrow' },
    { role: 'assistant' as const, content: planResponse },
  ];

  const { response: confirmResponse } = await orchestrator.processMessage(
    'Yes, that sounds great! Go ahead and save it.',
    history,
    onEvent,
    sessionId,
    'test-user',
  );

  console.log(`  Response preview: ${confirmResponse.slice(0, 150)}...`);

  // Verify: should have a "Saving your workout plan..." action event
  const hasSaveEvent = events.some(
    (e) => e.type === 'action' && e.content.includes('Saving')
  );
  assert(hasSaveEvent, 'emitted save action event on confirmation');

  // Verify: workout should now be in DB
  const countAfterConfirm = await getWorkoutCount();
  assert(countAfterConfirm === countBefore + 1, `workout written to DB after confirm (${countBefore} → ${countAfterConfirm})`);

  // Verify: proposal should be cleared
  assert(sessionController.hasPendingProposal(sessionId) === false, 'proposal cleared after confirmation');
}

async function testEndToEndReject() {
  console.log('\n--- Test B2: End-to-end plan → reject flow ---');
  const sessionId = 'test-b2-' + Date.now();

  const countBefore = await getWorkoutCount();

  // Turn 1: Ask for a plan
  console.log('  Turn 1: Sending planning request...');
  const { response: planResponse } = await orchestrator.processMessage(
    'Plan a strength workout for this weekend',
    [],
    undefined,
    sessionId,
    'test-user',
  );

  assert(sessionController.hasPendingProposal(sessionId) === true, 'proposal stashed after plan request');

  // Turn 2: Reject the plan
  console.log('  Turn 2: Rejecting the plan...');
  const history = [
    { role: 'user' as const, content: 'Plan a strength workout for this weekend' },
    { role: 'assistant' as const, content: planResponse },
  ];

  await orchestrator.processMessage(
    "No thanks, I changed my mind. Let's skip that.",
    history,
    undefined,
    sessionId,
    'test-user',
  );

  // Verify: no workout written
  const countAfterReject = await getWorkoutCount();
  assert(countAfterReject === countBefore, `no workout written after rejection (still ${countBefore})`);
}

async function testPendingProposalInSystemPrompt() {
  console.log('\n--- Test A8: System prompt includes pending proposal context ---');
  const sessionId = 'test-a8';
  setCurrentSessionId(sessionId);
  setCurrentUserId('test-user');

  // Initialize session
  sessionController.setSessionMemories(sessionId, []);

  // Stash a proposal
  const proposal: PendingProposal = {
    type: 'HIIT',
    duration: 20,
    date: '2026-02-20',
    description: 'High intensity intervals',
    status: WorkoutStatus.SCHEDULED,
    explanation: 'Quick and efficient',
    goal: 'Give me an intense workout',
  };
  sessionController.setPendingProposal(sessionId, proposal);

  // Call buildSystemPrompt (private, access via bracket notation)
  const buildSystemPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
  const prompt: string = buildSystemPrompt(sessionId, [], []);

  assert(prompt.includes('Pending Workout Proposal'), 'system prompt includes pending proposal section');
  assert(prompt.includes('HIIT'), 'system prompt includes proposal type');
  assert(prompt.includes('20 minutes'), 'system prompt includes proposal duration');
  assert(prompt.includes('High intensity intervals'), 'system prompt includes proposal description');
  assert(prompt.includes('confirm_proposal'), 'system prompt mentions confirm_proposal');
  assert(prompt.includes('Give me an intense workout'), 'system prompt includes original goal');
}

async function testSystemPromptNoPendingProposal() {
  console.log('\n--- Test A9: System prompt omits pending proposal when none exists ---');
  const sessionId = 'test-a9';

  // Ensure no proposal
  sessionController.clearPendingProposal(sessionId);

  const buildSystemPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
  const prompt: string = buildSystemPrompt(sessionId, [], []);

  assert(!prompt.includes('Pending Workout Proposal'), 'system prompt has no pending proposal section');
}

async function testSystemPromptWorkoutFlow() {
  console.log('\n--- Test A10: System prompt includes Workout Planning Flow section ---');
  const sessionId = 'test-a10';

  const buildSystemPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);
  const prompt: string = buildSystemPrompt(sessionId, [], []);

  assert(prompt.includes('Workout Planning Flow'), 'system prompt includes Workout Planning Flow section');
  assert(prompt.includes('two-turn confirmation flow'), 'system prompt describes two-turn flow');
  assert(prompt.includes('confirm_proposal'), 'system prompt mentions confirm_proposal');
  assert(prompt.includes('create_plan'), 'system prompt mentions create_plan');
  assert(!prompt.includes('Direct Logging'), 'system prompt does NOT include backward-looking logging path');
  assert(!prompt.includes('backward-looking'), 'system prompt does NOT mention backward-looking');
}

async function testToolDefinitions() {
  console.log('\n--- Test A11: Tool definitions — confirm_proposal present, create_workout removed ---');

  const getToolDefs = (orchestrator as any).getToolDefinitions.bind(orchestrator);
  const tools = getToolDefs();

  const toolNames = tools.map((t: any) => t.name);

  assert(toolNames.includes('confirm_proposal'), 'confirm_proposal tool exists');
  assert(toolNames.includes('create_plan'), 'create_plan tool exists');
  assert(toolNames.includes('get_workouts'), 'get_workouts tool exists');
  assert(!toolNames.includes('create_workout'), 'create_workout is NOT exposed to LLM');

  // Check confirm_proposal has optional date and duration overrides
  const confirmTool = tools.find((t: any) => t.name === 'confirm_proposal');
  const props = Object.keys(confirmTool.input_schema.properties || {});
  assert(props.length === 2, 'confirm_proposal has 2 optional properties (date, duration)');
  assert(props.includes('date'), 'confirm_proposal has date override');
  assert(props.includes('duration'), 'confirm_proposal has duration override');

  // Check create_plan has date property
  const planTool = tools.find((t: any) => t.name === 'create_plan');
  assert(planTool.input_schema.properties.date !== undefined, 'create_plan has optional date property');
}

async function testDescribeToolAction() {
  console.log('\n--- Test A12: describeToolAction maps tool names correctly ---');

  const describeToolAction = (orchestrator as any).describeToolAction.bind(orchestrator);

  assert(describeToolAction('confirm_proposal') === 'Saving your workout plan...', 'confirm_proposal action description correct');
  assert(describeToolAction('create_plan') === 'Creating a personalized workout plan...', 'create_plan action description correct');
  assert(describeToolAction('get_workouts') === 'Looking up your workouts...', 'get_workouts action description correct');
  assert(describeToolAction('update_memory') === 'Updating a note...', 'update_memory action description correct');
  assert(describeToolAction('invalidate_memory') === 'Retiring an old note...', 'invalidate_memory action description correct');
  assert(describeToolAction('unknown_tool') === 'Working on that...', 'unknown tool gets default description');
}

// ============================================================
// RUNNER
// ============================================================

async function main() {
  console.log('='.repeat(70));
  console.log('DECISION 11: USER CONFIRMATION FOR DOMAIN ACTIONS — TESTS');
  console.log('='.repeat(70));

  // Initialize database
  console.log('\nConnecting to database...');
  await AppDataSource.initialize();
  console.log('Database connected\n');

  // Clean up
  console.log('Cleaning up existing data...');
  await cleanWorkouts();
  const existingMemories = await memoryAgent.getAllMemories('test-user');
  for (const m of existingMemories) await memoryAgent.deleteMemory(m.id);
  console.log(`Cleaned ${existingMemories.length} memories and all workouts\n`);

  try {
    // Part A: Direct executeTool tests (mechanical behavior)
    console.log('='.repeat(70));
    console.log('PART A: Direct executeTool tests');
    console.log('='.repeat(70));

    await testConfirmProposalNoProposal();
    await testConfirmProposalWithStashedProposal();
    await testCreatePlanStashesProposal();
    await testCreatePlanThenConfirm();
    await testCreatePlanDateDefault();
    await testReplanOverwritesProposal();
    await testDoubleConfirmFails();
    await testPendingProposalInSystemPrompt();
    await testSystemPromptNoPendingProposal();
    await testSystemPromptWorkoutFlow();
    await testToolDefinitions();
    await testDescribeToolAction();

    // Part B: End-to-end two-turn flow (LLM integration)
    console.log('\n' + '='.repeat(70));
    console.log('PART B: End-to-end LLM integration tests');
    console.log('='.repeat(70));

    // Clean workouts before E2E tests for clean counts
    await cleanWorkouts();

    await testEndToEndPlanAndConfirm();
    await testEndToEndReject();

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
