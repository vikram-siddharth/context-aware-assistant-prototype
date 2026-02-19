import { SessionController } from './session/session-controller';

/**
 * Unit tests for Session Controller — pendingMemoryChange methods
 *
 * Tests:
 * 1. setPendingMemoryChange + hasPendingMemoryChange basic round-trip
 * 2. hasPendingMemoryChange returns false when not set
 * 3. clearPendingMemoryChange removes the flag
 * 4. clearPendingMemoryChange on nonexistent session is safe
 * 5. Setting pendingMemoryChange is idempotent (double-set doesn't break anything)
 * 6. clearSession also clears pending memory changes
 * 7. Memory change flags are isolated between sessions
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
  console.log('\n--- Test 1: Basic round-trip (set + has) ---');
  const sc = new SessionController();

  sc.setPendingMemoryChange('session-1');
  assert(sc.hasPendingMemoryChange('session-1') === true, 'hasPendingMemoryChange returns true after set');
}

function testReturnsFalseWhenNotSet() {
  console.log('\n--- Test 2: hasPendingMemoryChange returns false when not set ---');
  const sc = new SessionController();

  assert(sc.hasPendingMemoryChange('nonexistent') === false, 'returns false for session with no pending change');
}

function testClearPendingMemoryChange() {
  console.log('\n--- Test 3: clearPendingMemoryChange removes the flag ---');
  const sc = new SessionController();

  sc.setPendingMemoryChange('session-1');
  assert(sc.hasPendingMemoryChange('session-1') === true, 'flag exists before clear');

  sc.clearPendingMemoryChange('session-1');
  assert(sc.hasPendingMemoryChange('session-1') === false, 'flag removed after clear');
}

function testClearNonexistentIsSafe() {
  console.log('\n--- Test 4: clearPendingMemoryChange on nonexistent session is safe ---');
  const sc = new SessionController();

  // Should not throw
  sc.clearPendingMemoryChange('nonexistent');
  assert(true, 'clearPendingMemoryChange does not throw for nonexistent session');
}

function testIdempotentSet() {
  console.log('\n--- Test 5: Setting pendingMemoryChange is idempotent ---');
  const sc = new SessionController();

  sc.setPendingMemoryChange('session-1');
  sc.setPendingMemoryChange('session-1'); // double-set
  assert(sc.hasPendingMemoryChange('session-1') === true, 'still true after double-set');

  sc.clearPendingMemoryChange('session-1');
  assert(sc.hasPendingMemoryChange('session-1') === false, 'single clear removes the flag');
}

function testClearSessionClearsMemoryChanges() {
  console.log('\n--- Test 6: clearSession also clears pending memory changes ---');
  const sc = new SessionController();

  sc.addMessage('session-1', { role: 'user', content: 'hello' });
  sc.setPendingMemoryChange('session-1');

  assert(sc.hasSession('session-1') === true, 'session exists before clear');
  assert(sc.hasPendingMemoryChange('session-1') === true, 'memory change flag exists before clear');

  sc.clearSession('session-1');

  assert(sc.hasSession('session-1') === false, 'session gone after clearSession');
  assert(sc.hasPendingMemoryChange('session-1') === false, 'memory change flag gone after clearSession');
}

function testSessionIsolation() {
  console.log('\n--- Test 7: Memory change flags are isolated between sessions ---');
  const sc = new SessionController();

  sc.setPendingMemoryChange('session-a');
  sc.setPendingMemoryChange('session-b');

  assert(sc.hasPendingMemoryChange('session-a') === true, 'session-a has flag');
  assert(sc.hasPendingMemoryChange('session-b') === true, 'session-b has flag');

  // Clear one session, other should remain
  sc.clearPendingMemoryChange('session-a');
  assert(sc.hasPendingMemoryChange('session-a') === false, 'session-a flag cleared');
  assert(sc.hasPendingMemoryChange('session-b') === true, 'session-b flag still exists');
}

// Run all tests
console.log('='.repeat(70));
console.log('SESSION CONTROLLER — PENDING MEMORY CHANGE UNIT TESTS');
console.log('='.repeat(70));

testBasicRoundTrip();
testReturnsFalseWhenNotSet();
testClearPendingMemoryChange();
testClearNonexistentIsSafe();
testIdempotentSet();
testClearSessionClearsMemoryChanges();
testSessionIsolation();

console.log('\n' + '='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70));

if (failed > 0) {
  process.exit(1);
}
