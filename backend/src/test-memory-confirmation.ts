import { SessionController } from './session/session-controller';

/**
 * Unit tests for Session Controller — pendingMemoryChanges (memory-ID-specific tracking)
 *
 * Tests:
 *  1. armPendingMemoryChanges + isMemoryChangeAuthorized basic round-trip
 *  2. isMemoryChangeAuthorized returns false for unarmed memory ID
 *  3. consumeMemoryChange removes only the target, leaves others
 *  4. consumeMemoryChange on nonexistent session/memory is safe
 *  5. Arming same memory ID twice is idempotent (preserves original armedAtTurn)
 *  6. clearSession clears pending memory changes
 *  7. Memory change flags are isolated between sessions
 *  8. incrementTurn advances the turn counter
 *  9. expireStaleChanges removes old entries
 * 10. expireStaleChanges preserves recent entries
 * 11. hasPendingMemoryChanges reflects state
 * 12. getPendingMemoryChangeIds returns correct IDs
 * 13. Cross-contamination prevention — arm A, check B → false
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

function testBasicRoundTrip() {
  console.log('\n--- Test 1: Arm + authorize round-trip ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-abc']);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-abc') === true,
    'isMemoryChangeAuthorized returns true after arming');
}

function testUnauthorizedMemory() {
  console.log('\n--- Test 2: Unauthorized memory returns false ---');
  const sc = new SessionController();

  assert(sc.isMemoryChangeAuthorized('nonexistent', 'mem-abc') === false,
    'returns false for session with no pending changes');

  sc.armPendingMemoryChanges('session-1', ['mem-abc']);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-xyz') === false,
    'returns false for unarmed memory ID in a session that has other armed IDs');
}

function testConsumeRemovesOnlyTarget() {
  console.log('\n--- Test 3: Consume removes only the target, leaves others ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-a', 'mem-b']);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-a') === true, 'mem-a authorized before consume');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-b') === true, 'mem-b authorized before consume');

  sc.consumeMemoryChange('session-1', 'mem-a');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-a') === false, 'mem-a consumed');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-b') === true, 'mem-b still authorized');
}

function testConsumeNonexistentIsSafe() {
  console.log('\n--- Test 4: Consume nonexistent session/memory is safe ---');
  const sc = new SessionController();

  // Should not throw
  sc.consumeMemoryChange('nonexistent', 'mem-abc');
  assert(true, 'consumeMemoryChange does not throw for nonexistent session');

  sc.armPendingMemoryChanges('session-1', ['mem-abc']);
  sc.consumeMemoryChange('session-1', 'mem-xyz');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-abc') === true,
    'consuming nonexistent memory does not affect existing entries');
}

function testIdempotentArm() {
  console.log('\n--- Test 5: Arming same memory ID twice preserves original armedAtTurn ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-abc']);
  // Advance turn
  sc.incrementTurn('session-1');
  // Arm again — should NOT reset armedAtTurn
  sc.armPendingMemoryChanges('session-1', ['mem-abc']);

  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-abc') === true, 'still authorized after double-arm');

  // Expire with maxTurns=0 — if armedAtTurn was reset to turn 1, it wouldn't expire.
  // If original armedAtTurn=0 was preserved, currentTurn(1) - armedAtTurn(0) = 1 > 0 → expires.
  sc.expireStaleChanges('session-1', 0);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-abc') === false,
    'original armedAtTurn preserved — expires based on first arm');
}

function testClearSessionClearsPendingChanges() {
  console.log('\n--- Test 6: clearSession clears pending memory changes ---');
  const sc = new SessionController();

  sc.addMessage('session-1', { role: 'user', content: 'hello' });
  sc.armPendingMemoryChanges('session-1', ['mem-abc', 'mem-def']);

  assert(sc.hasSession('session-1') === true, 'session exists before clear');
  assert(sc.hasPendingMemoryChanges('session-1') === true, 'pending changes exist before clear');

  sc.clearSession('session-1');

  assert(sc.hasSession('session-1') === false, 'session gone after clearSession');
  assert(sc.hasPendingMemoryChanges('session-1') === false, 'pending changes gone after clearSession');
}

function testSessionIsolation() {
  console.log('\n--- Test 7: Memory change flags are isolated between sessions ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-a', ['mem-1']);
  sc.armPendingMemoryChanges('session-b', ['mem-2']);

  assert(sc.isMemoryChangeAuthorized('session-a', 'mem-1') === true, 'session-a has mem-1');
  assert(sc.isMemoryChangeAuthorized('session-b', 'mem-2') === true, 'session-b has mem-2');
  assert(sc.isMemoryChangeAuthorized('session-a', 'mem-2') === false, 'session-a does NOT have mem-2');
  assert(sc.isMemoryChangeAuthorized('session-b', 'mem-1') === false, 'session-b does NOT have mem-1');

  // Consume in one session, other should remain
  sc.consumeMemoryChange('session-a', 'mem-1');
  assert(sc.hasPendingMemoryChanges('session-a') === false, 'session-a has no pending changes');
  assert(sc.isMemoryChangeAuthorized('session-b', 'mem-2') === true, 'session-b still has mem-2');
}

function testIncrementTurn() {
  console.log('\n--- Test 8: incrementTurn advances the counter ---');
  const sc = new SessionController();

  // Arm at turn 0 (default)
  sc.armPendingMemoryChanges('session-1', ['mem-first']);
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');
  // Now at turn 2. Arm a new memory — should get armedAtTurn=2
  sc.armPendingMemoryChanges('session-1', ['mem-second']);

  // Expire with maxTurns=1: turn 2 - 0 = 2 > 1 → mem-first expires; turn 2 - 2 = 0 > 1 → false, mem-second stays
  sc.expireStaleChanges('session-1', 1);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-first') === false,
    'mem-first expired (armedAtTurn=0, currentTurn=2, maxTurns=1)');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-second') === true,
    'mem-second still authorized (armedAtTurn=2, currentTurn=2, maxTurns=1)');
}

function testExpireRemovesOldEntries() {
  console.log('\n--- Test 9: expireStaleChanges removes old entries ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-old']);
  // Advance 4 turns
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');

  // currentTurn=4, armedAtTurn=0, maxTurns=3: 4 - 0 = 4 > 3 → expired
  sc.expireStaleChanges('session-1', 3);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-old') === false,
    'entry expired after 4 turns (maxTurns=3)');
  assert(sc.hasPendingMemoryChanges('session-1') === false,
    'session cleanup: no pending changes after all expired');
}

function testExpirePreservesRecentEntries() {
  console.log('\n--- Test 10: expireStaleChanges preserves recent entries ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-recent']);
  // Advance 3 turns
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');
  sc.incrementTurn('session-1');

  // currentTurn=3, armedAtTurn=0, maxTurns=3: 3 - 0 = 3, 3 > 3 is FALSE → preserved
  sc.expireStaleChanges('session-1', 3);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-recent') === true,
    'entry preserved at exactly maxTurns boundary (3 turns, not expired yet)');
}

function testHasPendingMemoryChanges() {
  console.log('\n--- Test 11: hasPendingMemoryChanges reflects state ---');
  const sc = new SessionController();

  assert(sc.hasPendingMemoryChanges('session-1') === false, 'false when no session data');

  sc.armPendingMemoryChanges('session-1', ['mem-abc']);
  assert(sc.hasPendingMemoryChanges('session-1') === true, 'true when changes armed');

  sc.consumeMemoryChange('session-1', 'mem-abc');
  assert(sc.hasPendingMemoryChanges('session-1') === false, 'false after all changes consumed');
}

function testGetPendingMemoryChangeIds() {
  console.log('\n--- Test 12: getPendingMemoryChangeIds returns correct IDs ---');
  const sc = new SessionController();

  assert(sc.getPendingMemoryChangeIds('session-1').length === 0, 'empty array when no session data');

  sc.armPendingMemoryChanges('session-1', ['mem-a', 'mem-b', 'mem-c']);
  const ids = sc.getPendingMemoryChangeIds('session-1');
  assert(ids.length === 3, 'returns 3 IDs');
  assert(ids.includes('mem-a'), 'includes mem-a');
  assert(ids.includes('mem-b'), 'includes mem-b');
  assert(ids.includes('mem-c'), 'includes mem-c');

  sc.consumeMemoryChange('session-1', 'mem-b');
  const idsAfter = sc.getPendingMemoryChangeIds('session-1');
  assert(idsAfter.length === 2, 'returns 2 IDs after consuming one');
  assert(!idsAfter.includes('mem-b'), 'mem-b no longer in list');
}

function testCrossContaminationPrevention() {
  console.log('\n--- Test 13: Cross-contamination prevention — arm A, check B → false ---');
  const sc = new SessionController();

  sc.armPendingMemoryChanges('session-1', ['mem-a']);
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-a') === true, 'mem-a is authorized');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-b') === false,
    'mem-b is NOT authorized (arming A does not authorize B)');
  assert(sc.isMemoryChangeAuthorized('session-1', 'mem-c') === false,
    'mem-c is NOT authorized (arming A does not authorize C)');
}

// Run all tests
console.log('='.repeat(70));
console.log('SESSION CONTROLLER — PENDING MEMORY CHANGE UNIT TESTS');
console.log('='.repeat(70));

testBasicRoundTrip();
testUnauthorizedMemory();
testConsumeRemovesOnlyTarget();
testConsumeNonexistentIsSafe();
testIdempotentArm();
testClearSessionClearsPendingChanges();
testSessionIsolation();
testIncrementTurn();
testExpireRemovesOldEntries();
testExpirePreservesRecentEntries();
testHasPendingMemoryChanges();
testGetPendingMemoryChangeIds();
testCrossContaminationPrevention();

console.log('\n' + '='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70));

if (failed > 0) {
  process.exit(1);
}
