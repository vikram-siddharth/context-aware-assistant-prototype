import { SessionController, PendingProposal } from './session/session-controller';
import { WorkoutStatus } from './entities/Workout';

/**
 * Unit tests for Session Controller — PendingProposal methods
 *
 * Tests:
 * 1. setPendingProposal + getPendingProposal basic round-trip
 * 2. getPendingProposal returns null when none exists
 * 3. hasPendingProposal returns correct boolean
 * 4. clearPendingProposal removes the proposal
 * 5. Setting a new proposal overwrites the old one
 * 6. clearSession also clears pending proposals
 * 7. Proposals are isolated between sessions
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

function makeProposal(overrides: Partial<PendingProposal> = {}): PendingProposal {
  return {
    type: 'cardio',
    duration: 45,
    date: '2026-02-18',
    description: 'Low-impact cycling session',
    status: WorkoutStatus.SCHEDULED,
    explanation: 'Cycling was chosen to protect the knee',
    goal: 'Plan a workout for today',
    ...overrides,
  };
}

function testBasicRoundTrip() {
  console.log('\n--- Test 1: Basic round-trip (set + get) ---');
  const sc = new SessionController();
  const proposal = makeProposal();

  sc.setPendingProposal('session-1', proposal);
  const retrieved = sc.getPendingProposal('session-1');

  assert(retrieved !== null, 'getPendingProposal returns non-null after set');
  assert(retrieved!.type === 'cardio', 'type matches');
  assert(retrieved!.duration === 45, 'duration matches');
  assert(retrieved!.date === '2026-02-18', 'date matches');
  assert(retrieved!.description === 'Low-impact cycling session', 'description matches');
  assert(retrieved!.status === WorkoutStatus.SCHEDULED, 'status matches');
  assert(retrieved!.explanation === 'Cycling was chosen to protect the knee', 'explanation matches');
  assert(retrieved!.goal === 'Plan a workout for today', 'goal matches');
}

function testGetReturnsNullWhenNoneSet() {
  console.log('\n--- Test 2: getPendingProposal returns null when none set ---');
  const sc = new SessionController();

  const result = sc.getPendingProposal('nonexistent-session');
  assert(result === null, 'returns null for session with no proposal');
}

function testHasPendingProposal() {
  console.log('\n--- Test 3: hasPendingProposal returns correct boolean ---');
  const sc = new SessionController();

  assert(sc.hasPendingProposal('session-1') === false, 'returns false before setting');

  sc.setPendingProposal('session-1', makeProposal());
  assert(sc.hasPendingProposal('session-1') === true, 'returns true after setting');

  assert(sc.hasPendingProposal('session-2') === false, 'returns false for different session');
}

function testClearPendingProposal() {
  console.log('\n--- Test 4: clearPendingProposal removes the proposal ---');
  const sc = new SessionController();

  sc.setPendingProposal('session-1', makeProposal());
  assert(sc.hasPendingProposal('session-1') === true, 'proposal exists before clear');

  sc.clearPendingProposal('session-1');
  assert(sc.hasPendingProposal('session-1') === false, 'hasPendingProposal returns false after clear');
  assert(sc.getPendingProposal('session-1') === null, 'getPendingProposal returns null after clear');
}

function testClearNonexistentProposal() {
  console.log('\n--- Test 5: clearPendingProposal on nonexistent session is safe ---');
  const sc = new SessionController();

  // Should not throw
  sc.clearPendingProposal('nonexistent-session');
  assert(true, 'clearPendingProposal does not throw for nonexistent session');
}

function testOverwrite() {
  console.log('\n--- Test 6: Setting a new proposal overwrites the old one ---');
  const sc = new SessionController();

  const proposal1 = makeProposal({ type: 'cardio', duration: 30 });
  const proposal2 = makeProposal({ type: 'yoga', duration: 60 });

  sc.setPendingProposal('session-1', proposal1);
  assert(sc.getPendingProposal('session-1')!.type === 'cardio', 'first proposal stored');
  assert(sc.getPendingProposal('session-1')!.duration === 30, 'first proposal duration');

  sc.setPendingProposal('session-1', proposal2);
  assert(sc.getPendingProposal('session-1')!.type === 'yoga', 'second proposal overwrites type');
  assert(sc.getPendingProposal('session-1')!.duration === 60, 'second proposal overwrites duration');
}

function testClearSessionClearsProposals() {
  console.log('\n--- Test 7: clearSession also clears pending proposals ---');
  const sc = new SessionController();

  // Set up conversation history, memories, and a proposal
  sc.addMessage('session-1', { role: 'user', content: 'hello' });
  sc.setPendingProposal('session-1', makeProposal());

  assert(sc.hasSession('session-1') === true, 'session exists before clear');
  assert(sc.hasPendingProposal('session-1') === true, 'proposal exists before clear');

  sc.clearSession('session-1');

  assert(sc.hasSession('session-1') === false, 'session gone after clearSession');
  assert(sc.hasPendingProposal('session-1') === false, 'proposal gone after clearSession');
  assert(sc.getPendingProposal('session-1') === null, 'getPendingProposal returns null after clearSession');
}

function testSessionIsolation() {
  console.log('\n--- Test 8: Proposals are isolated between sessions ---');
  const sc = new SessionController();

  const proposalA = makeProposal({ type: 'cardio', goal: 'cardio goal' });
  const proposalB = makeProposal({ type: 'strength', goal: 'strength goal' });

  sc.setPendingProposal('session-a', proposalA);
  sc.setPendingProposal('session-b', proposalB);

  assert(sc.getPendingProposal('session-a')!.type === 'cardio', 'session-a has cardio');
  assert(sc.getPendingProposal('session-b')!.type === 'strength', 'session-b has strength');

  // Clear one session's proposal, other should remain
  sc.clearPendingProposal('session-a');
  assert(sc.getPendingProposal('session-a') === null, 'session-a proposal cleared');
  assert(sc.getPendingProposal('session-b')!.type === 'strength', 'session-b proposal still exists');
}

function testProposalFieldIntegrity() {
  console.log('\n--- Test 9: All PendingProposal fields preserved through round-trip ---');
  const sc = new SessionController();

  const proposal: PendingProposal = {
    type: 'flexibility',
    duration: 25,
    date: '2026-03-15',
    description: 'Gentle stretching focusing on hamstrings and lower back',
    status: WorkoutStatus.SCHEDULED,
    explanation: 'Chose flexibility work because user has a back issue',
    goal: 'Help me stretch after sitting all day',
  };

  sc.setPendingProposal('session-x', proposal);
  const retrieved = sc.getPendingProposal('session-x')!;

  // Verify the retrieved object is a faithful copy
  assert(retrieved.type === proposal.type, 'type preserved');
  assert(retrieved.duration === proposal.duration, 'duration preserved');
  assert(retrieved.date === proposal.date, 'date preserved');
  assert(retrieved.description === proposal.description, 'description preserved');
  assert(retrieved.status === proposal.status, 'status preserved');
  assert(retrieved.explanation === proposal.explanation, 'explanation preserved');
  assert(retrieved.goal === proposal.goal, 'goal preserved');
}

// Run all tests
console.log('='.repeat(70));
console.log('SESSION CONTROLLER — PENDING PROPOSAL UNIT TESTS');
console.log('='.repeat(70));

testBasicRoundTrip();
testGetReturnsNullWhenNoneSet();
testHasPendingProposal();
testClearPendingProposal();
testClearNonexistentProposal();
testOverwrite();
testClearSessionClearsProposals();
testSessionIsolation();
testProposalFieldIntegrity();

console.log('\n' + '='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70));

if (failed > 0) {
  process.exit(1);
}
