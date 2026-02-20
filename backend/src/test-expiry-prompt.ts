import { orchestrator } from './orchestrator';
import { Memory, MemoryCategory, MemoryPersistence } from './entities/Memory';

/**
 * System prompt content tests for Decision 14: Persistence-Based Memory Expiry
 *
 * Tests the three new system prompt features:
 *   1. "Setting Expiry on Memories" section (instructions for the LLM)
 *   2. Expiry date labels inline in memory listing
 *   3. "Expiring Memories — Check-In Needed" section (conditional, with thresholds)
 *
 * No DB or LLM calls — tests buildSystemPrompt output directly.
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

const buildSystemPrompt = (orchestrator as any).buildSystemPrompt.bind(orchestrator);

/**
 * Create a fake Memory object (not saved to DB)
 */
function fakeMemory(overrides: Partial<Memory> = {}): Memory {
  const m = new Memory();
  m.id = overrides.id || 'fake-uuid-1234';
  m.fact = overrides.fact || 'have a knee injury';
  m.category = overrides.category || MemoryCategory.CONSTRAINT;
  m.persistence = overrides.persistence || MemoryPersistence.LONG_TERM;
  m.active = overrides.active ?? true;
  m.estimated_expiry = overrides.estimated_expiry ?? null;
  m.created_at = overrides.created_at || new Date();
  return m;
}

// Helper: get a date N days from now
function daysFromNow(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

// ============================================================
// A. "Setting Expiry on Memories" section
// ============================================================

function testExpiryInstructionsPresent() {
  console.log('\n--- Test 1: "Setting Expiry on Memories" section present when memories exist ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(prompt.includes('Setting Expiry on Memories'), 'section title present');
  assert(prompt.includes('Facts with natural endpoints'), 'natural endpoints guidance present');
  assert(prompt.includes('Facts that are likely indefinite'), 'indefinite facts guidance present');
  assert(prompt.includes('set_memory_expiry'), 'set_memory_expiry tool referenced');
  assert(
    prompt.includes('The LLM always sets an expiry for facts with natural endpoints'),
    'fallback estimation rule present'
  );
  assert(
    prompt.includes('not as an interruption to their primary request'),
    'conversational timing guidance present'
  );
}

function testExpiryInstructionsAbsentWithoutMemories() {
  console.log('\n--- Test 2: "Setting Expiry" section absent when no memories ---');
  const prompt: string = buildSystemPrompt('test-session', [], []);

  assert(
    !prompt.includes('Setting Expiry on Memories'),
    'no Setting Expiry section when no memories'
  );
}

function testCategorySpecificPhrasing() {
  console.log('\n--- Test 3: Category-specific expiry question phrasing ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(prompt.includes('**Goals**: Ask for a specific date'), 'goals phrasing present');
  assert(prompt.includes('**Preferences**: Ask for a window'), 'preferences phrasing present');
  assert(prompt.includes('**Constraints**: Ask gently'), 'constraints phrasing present');
}

function testUserInitiatedExpiryUpdate() {
  console.log('\n--- Test 4: User-initiated expiry update instruction ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('the race is in May, not April'),
    'example of user-initiated timeframe change present'
  );
  assert(
    prompt.includes('no confirmation needed'),
    'no-confirmation-needed for expiry updates present'
  );
}

// ============================================================
// B. Expiry date labels in memory listing
// ============================================================

function testExpiryLabelShown() {
  console.log('\n--- Test 5: Memory with expiry shows inline label ---');
  const expiryDate = daysFromNow(30);
  const expiryStr = expiryDate.toISOString().split('T')[0];
  const memories = [fakeMemory({ id: 'mem-exp-1', fact: 'sprained ankle', estimated_expiry: expiryDate })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes(`(expires: ${expiryStr})`),
    `expiry label "(expires: ${expiryStr})" shown inline`
  );
  assert(
    prompt.includes('sprained ankle (expires:'),
    'expiry label appears after the fact text'
  );
}

function testNoExpiryLabelForNullExpiry() {
  console.log('\n--- Test 6: Memory without expiry has no expiry label ---');
  const memories = [fakeMemory({ id: 'mem-noexp', fact: 'like swimming', estimated_expiry: null })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('like swimming\n'),
    'memory line ends with fact (no expiry label)'
  );
  assert(
    !prompt.includes('like swimming (expires:'),
    'no "(expires:" after fact with null expiry'
  );
}

function testMixedExpiryLabels() {
  console.log('\n--- Test 7: Mixed memories — only those with expiry get labels ---');
  const expiryDate = daysFromNow(60);
  const expiryStr = expiryDate.toISOString().split('T')[0];
  const memories = [
    fakeMemory({ id: 'mem-a', fact: 'like yoga', estimated_expiry: null }),
    fakeMemory({ id: 'mem-b', fact: 'training for marathon', estimated_expiry: expiryDate }),
  ];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(!prompt.includes('like yoga (expires:'), 'null-expiry memory has no label');
  assert(
    prompt.includes(`training for marathon (expires: ${expiryStr})`),
    'expiry memory has label'
  );
}

// ============================================================
// C. "Expiring Memories — Check-In Needed" section
// ============================================================

function testExpiredMemoryTriggersCheckIn() {
  console.log('\n--- Test 8: Expired memory triggers check-in section ---');
  const expiredDate = daysFromNow(-5); // 5 days ago
  const memories = [fakeMemory({
    id: 'mem-expired',
    fact: 'training for half-marathon',
    category: MemoryCategory.GOAL,
    estimated_expiry: expiredDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Expiring Memories — Check-In Needed'),
    'check-in section title present'
  );
  assert(prompt.includes('**EXPIRED**'), 'EXPIRED label present');
  assert(prompt.includes('training for half-marathon'), 'fact text in check-in section');
  assert(prompt.includes('mem-expired'), 'memory ID in check-in section');
  assert(prompt.includes('5 days ago'), 'days-ago count present');
}

function testExpiringSoonMemoryTriggersCheckIn() {
  console.log('\n--- Test 9: Expiring-soon memory triggers check-in section ---');
  const soonDate = daysFromNow(7); // 7 days from now
  const soonStr = soonDate.toISOString().split('T')[0];
  const memories = [fakeMemory({
    id: 'mem-soon',
    fact: 'recovering from ankle sprain',
    category: MemoryCategory.CONSTRAINT,
    estimated_expiry: soonDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Expiring Memories — Check-In Needed'),
    'check-in section title present'
  );
  assert(prompt.includes('**EXPIRING SOON**'), 'EXPIRING SOON label present');
  assert(prompt.includes('recovering from ankle sprain'), 'fact text in check-in section');
  assert(prompt.includes('7 days away'), 'days-away count present');
}

function testFarFutureExpiryNoCheckIn() {
  console.log('\n--- Test 10: Far-future expiry does NOT trigger check-in ---');
  const farDate = daysFromNow(60); // 2 months away
  const memories = [fakeMemory({
    id: 'mem-far',
    fact: 'want to run a 10K by summer',
    estimated_expiry: farDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    !prompt.includes('Expiring Memories — Check-In Needed'),
    'no check-in section for far-future expiry'
  );
  assert(
    !prompt.includes('**EXPIRED**'),
    'no EXPIRED label'
  );
  assert(
    !prompt.includes('**EXPIRING SOON**'),
    'no EXPIRING SOON label'
  );
}

function testNullExpiryNoCheckIn() {
  console.log('\n--- Test 11: Null expiry does NOT trigger check-in ---');
  const memories = [fakeMemory({ estimated_expiry: null })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    !prompt.includes('Expiring Memories — Check-In Needed'),
    'no check-in section for null expiry'
  );
}

function testCheckInRulesContent() {
  console.log('\n--- Test 12: Check-in section includes category-specific rules ---');
  const expiredDate = daysFromNow(-1);
  const memories = [fakeMemory({
    id: 'mem-rules',
    fact: 'some expiring fact',
    estimated_expiry: expiredDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Goals and preferences'),
    'check-in rules mention goals and preferences'
  );
  assert(
    prompt.includes('Raise proactively at the first natural opportunity'),
    'proactive check-in for goals/preferences'
  );
  assert(
    prompt.includes('Constraints'),
    'check-in rules mention constraints'
  );
  assert(
    prompt.includes('when relevant to the conversation'),
    'context-dependent check-in for constraints'
  );
}

function testCheckInToolInstructions() {
  console.log('\n--- Test 13: Check-in section includes tool instructions ---');
  const expiredDate = daysFromNow(-3);
  const memories = [fakeMemory({ estimated_expiry: expiredDate })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('extend the expiry via set_memory_expiry'),
    'extend option references set_memory_expiry'
  );
  assert(
    prompt.includes('retire via invalidate_memory'),
    'retire option references invalidate_memory'
  );
  assert(
    prompt.includes('update via update_memory'),
    'update option references update_memory'
  );
}

function testBoundaryExactly14Days() {
  console.log('\n--- Test 14: Memory expiring in exactly 14 days triggers check-in ---');
  const boundaryDate = daysFromNow(14);
  const memories = [fakeMemory({
    id: 'mem-boundary',
    fact: 'boundary test fact',
    estimated_expiry: boundaryDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Expiring Memories — Check-In Needed'),
    'exactly 14 days triggers check-in (within threshold)'
  );
  assert(prompt.includes('**EXPIRING SOON**'), 'EXPIRING SOON label at 14-day boundary');
}

function testBoundary15DaysNoCheckIn() {
  console.log('\n--- Test 15: Memory expiring in 15 days does NOT trigger check-in ---');
  const beyondDate = daysFromNow(15);
  const memories = [fakeMemory({
    id: 'mem-beyond',
    fact: 'beyond boundary fact',
    estimated_expiry: beyondDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    !prompt.includes('Expiring Memories — Check-In Needed'),
    '15 days out does not trigger check-in'
  );
}

function testExpiryTodayIsExpired() {
  console.log('\n--- Test 16: Memory expiring today is treated as EXPIRED ---');
  const todayDate = daysFromNow(0);
  const memories = [fakeMemory({
    id: 'mem-today',
    fact: 'expires today fact',
    estimated_expiry: todayDate,
  })];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Expiring Memories — Check-In Needed'),
    'today triggers check-in'
  );
  assert(prompt.includes('**EXPIRED**'), 'today is treated as EXPIRED (daysUntil <= 0)');
}

// ============================================================
// RUNNER
// ============================================================

console.log('='.repeat(70));
console.log('DECISION 14: EXPIRY SYSTEM PROMPT CONTENT TESTS');
console.log('='.repeat(70));

// A. Setting Expiry instructions
testExpiryInstructionsPresent();
testExpiryInstructionsAbsentWithoutMemories();
testCategorySpecificPhrasing();
testUserInitiatedExpiryUpdate();

// B. Expiry labels
testExpiryLabelShown();
testNoExpiryLabelForNullExpiry();
testMixedExpiryLabels();

// C. Check-in section
testExpiredMemoryTriggersCheckIn();
testExpiringSoonMemoryTriggersCheckIn();
testFarFutureExpiryNoCheckIn();
testNullExpiryNoCheckIn();
testCheckInRulesContent();
testCheckInToolInstructions();
testBoundaryExactly14Days();
testBoundary15DaysNoCheckIn();
testExpiryTodayIsExpired();

console.log('\n' + '='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70));

if (failed > 0) {
  process.exit(1);
}
