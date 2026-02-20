/**
 * Unit tests for pure functions in MemoryModal.tsx
 * (sortByExpiry, getExpiryStatus)
 *
 * These functions live inside a React component file, so we replicate
 * them here to test in a plain Node environment — same pattern the
 * backend tests use for system-prompt content validation.
 */

type MemoryData = {
  id: string;
  fact: string;
  category: 'constraint' | 'preference' | 'goal';
  persistence: 'permanent' | 'long_term' | 'short_term';
  estimated_expiry: string | null;
  created_at: string;
};

// ---- Functions under test (copied from MemoryModal.tsx) ----

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function getExpiryStatus(expiry: string | null): 'expired' | 'expiring-soon' | 'normal' {
  if (!expiry) return 'normal';
  const diff = new Date(expiry).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  if (diff <= TWO_WEEKS_MS) return 'expiring-soon';
  return 'normal';
}

function sortByExpiry(memories: MemoryData[]): MemoryData[] {
  return [...memories].sort((a, b) => {
    if (a.estimated_expiry && b.estimated_expiry) {
      return new Date(a.estimated_expiry).getTime() - new Date(b.estimated_expiry).getTime();
    }
    if (a.estimated_expiry) return -1;
    if (b.estimated_expiry) return 1;
    return 0;
  });
}

// ---- Test helpers ----

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

function makeMemory(overrides: Partial<MemoryData> & { fact: string }): MemoryData {
  return {
    id: Math.random().toString(36).slice(2),
    category: 'preference',
    persistence: 'permanent',
    estimated_expiry: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---- Tests ----

function testSortByExpiry() {
  console.log('='.repeat(70));
  console.log('PART A: sortByExpiry');
  console.log('='.repeat(70));
  console.log();

  // Test 1: Soonest expiry first
  console.log('--- Test 1: Memories with expiry sort soonest-first ---');
  const soonest = makeMemory({ fact: 'soonest', estimated_expiry: '2026-03-01' });
  const middle = makeMemory({ fact: 'middle', estimated_expiry: '2026-06-01' });
  const latest = makeMemory({ fact: 'latest', estimated_expiry: '2026-12-01' });

  const sorted1 = sortByExpiry([latest, soonest, middle]);
  assert(sorted1[0].fact === 'soonest', `First is soonest (got "${sorted1[0].fact}")`);
  assert(sorted1[1].fact === 'middle', `Second is middle (got "${sorted1[1].fact}")`);
  assert(sorted1[2].fact === 'latest', `Third is latest (got "${sorted1[2].fact}")`);
  console.log();

  // Test 2: Null expiry sorts to bottom
  console.log('--- Test 2: Memories with no expiry sort to the bottom ---');
  const noExpiry1 = makeMemory({ fact: 'permanent-A', estimated_expiry: null });
  const noExpiry2 = makeMemory({ fact: 'permanent-B', estimated_expiry: null });
  const hasExpiry = makeMemory({ fact: 'expiring', estimated_expiry: '2026-04-01' });

  const sorted2 = sortByExpiry([noExpiry1, hasExpiry, noExpiry2]);
  assert(sorted2[0].fact === 'expiring', `First is the one with expiry (got "${sorted2[0].fact}")`);
  assert(
    sorted2[1].fact === 'permanent-A' || sorted2[1].fact === 'permanent-B',
    `Second is a null-expiry memory (got "${sorted2[1].fact}")`,
  );
  assert(
    sorted2[2].fact === 'permanent-A' || sorted2[2].fact === 'permanent-B',
    `Third is a null-expiry memory (got "${sorted2[2].fact}")`,
  );
  console.log();

  // Test 3: Mixed set — expiry memories first in date order, then nulls
  console.log('--- Test 3: Mixed set sorts correctly ---');
  const mixed = [
    makeMemory({ fact: 'no-expiry-1', estimated_expiry: null }),
    makeMemory({ fact: 'exp-late', estimated_expiry: '2026-09-15' }),
    makeMemory({ fact: 'no-expiry-2', estimated_expiry: null }),
    makeMemory({ fact: 'exp-early', estimated_expiry: '2026-03-10' }),
  ];

  const sorted3 = sortByExpiry(mixed);
  assert(sorted3[0].fact === 'exp-early', `First: exp-early (got "${sorted3[0].fact}")`);
  assert(sorted3[1].fact === 'exp-late', `Second: exp-late (got "${sorted3[1].fact}")`);
  assert(sorted3[2].estimated_expiry === null, 'Third has null expiry');
  assert(sorted3[3].estimated_expiry === null, 'Fourth has null expiry');
  console.log();

  // Test 4: All null — stable (no crash, same length)
  console.log('--- Test 4: All null expiry — no crash, preserves order ---');
  const allNull = [
    makeMemory({ fact: 'A', estimated_expiry: null }),
    makeMemory({ fact: 'B', estimated_expiry: null }),
    makeMemory({ fact: 'C', estimated_expiry: null }),
  ];
  const sorted4 = sortByExpiry(allNull);
  assert(sorted4.length === 3, `Returns 3 items (got ${sorted4.length})`);
  assert(sorted4[0].fact === 'A', `Stable order preserved — first is A (got "${sorted4[0].fact}")`);
  console.log();

  // Test 5: Does not mutate original array
  console.log('--- Test 5: Original array is not mutated ---');
  const original = [
    makeMemory({ fact: 'Z', estimated_expiry: '2026-12-01' }),
    makeMemory({ fact: 'A', estimated_expiry: '2026-01-01' }),
  ];
  const originalFirstFact = original[0].fact;
  sortByExpiry(original);
  assert(original[0].fact === originalFirstFact, `Original array unchanged (first still "${originalFirstFact}")`);
  console.log();
}

function testGetExpiryStatus() {
  console.log('='.repeat(70));
  console.log('PART B: getExpiryStatus');
  console.log('='.repeat(70));
  console.log();

  // Test 1: null → normal
  console.log('--- Test 1: null expiry returns "normal" ---');
  assert(getExpiryStatus(null) === 'normal', 'null → normal');
  console.log();

  // Test 2: Far future → normal
  console.log('--- Test 2: Far future date returns "normal" ---');
  const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // +90 days
  assert(getExpiryStatus(farFuture) === 'normal', `+90 days → normal`);
  console.log();

  // Test 3: Within two weeks → expiring-soon
  console.log('--- Test 3: Within two weeks returns "expiring-soon" ---');
  const inOneWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(inOneWeek) === 'expiring-soon', '+7 days → expiring-soon');

  const in13Days = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(in13Days) === 'expiring-soon', '+13 days → expiring-soon');

  const in1Day = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(in1Day) === 'expiring-soon', '+1 day → expiring-soon');
  console.log();

  // Test 4: Past date → expired
  console.log('--- Test 4: Past dates return "expired" ---');
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(yesterday) === 'expired', 'yesterday → expired');

  const longAgo = '2020-01-01T00:00:00Z';
  assert(getExpiryStatus(longAgo) === 'expired', '2020-01-01 → expired');
  console.log();

  // Test 5: Boundary — exactly now → expired (diff <= 0)
  console.log('--- Test 5: Boundary — date at or just past now → expired ---');
  const justPast = new Date(Date.now() - 1000).toISOString(); // 1 second ago
  assert(getExpiryStatus(justPast) === 'expired', '1 second ago → expired');
  console.log();

  // Test 6: Boundary — exactly 14 days → expiring-soon (diff <= TWO_WEEKS_MS)
  console.log('--- Test 6: Boundary — exactly 14 days from now → expiring-soon ---');
  const exactly14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(exactly14Days) === 'expiring-soon', '14 days → expiring-soon');
  console.log();

  // Test 7: Just over 14 days → normal
  console.log('--- Test 7: Just over 14 days → normal ---');
  const over14Days = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  assert(getExpiryStatus(over14Days) === 'normal', '15 days → normal');
  console.log();
}

// ---- Run ----

console.log('='.repeat(70));
console.log('MEMORY MODAL LOGIC TESTS (sortByExpiry + getExpiryStatus)');
console.log('='.repeat(70));
console.log();

testSortByExpiry();
testGetExpiryStatus();

console.log('='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(70));

if (failed > 0) process.exit(1);
