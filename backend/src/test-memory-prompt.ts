import { orchestrator } from './orchestrator';
import { sessionController } from './session/session-controller';
import { Memory, MemoryCategory, MemoryPersistence } from './entities/Memory';

/**
 * System prompt content tests for the memory system fixes:
 *
 * Issue 1: Resolution category — prompt distinguishes evolution (update_memory)
 *          from resolution (invalidate_memory) for fully resolved constraints
 *
 * Issue 2: Two-turn confirmation — prompt instructs the LLM not to call memory
 *          tools in the same response where it asks for confirmation
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
  m.fact = overrides.fact || 'Has a knee injury';
  m.category = overrides.category || MemoryCategory.CONSTRAINT;
  m.persistence = overrides.persistence || MemoryPersistence.LONG_TERM;
  m.active = overrides.active ?? true;
  m.created_at = overrides.created_at || new Date();
  return m;
}

// ============================================================
// Issue 1: Resolution category in system prompt
// ============================================================

function testResolutionCategoryPresent() {
  console.log('\n--- Test 1: System prompt includes Resolution category ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(prompt.includes('**Resolution**'), 'prompt contains Resolution heading');
  assert(
    prompt.includes('fully resolved and no longer influences future behavior'),
    'Resolution description mentions "no longer influences future behavior"'
  );
  assert(
    prompt.includes('invalidate_memory (NOT update_memory)'),
    'Resolution action explicitly says invalidate_memory, NOT update_memory'
  );
}

function testEvolutionVsResolutionDistinction() {
  console.log('\n--- Test 2: System prompt includes evolution vs. resolution distinction ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Key distinction for evolution vs. resolution'),
    'prompt contains the key distinction section'
  );
  assert(
    prompt.includes('Shoulder is sore but improving'),
    'prompt includes evolution example (still constrains → update_memory)'
  );
  assert(
    prompt.includes('Wound has fully healed'),
    'prompt includes resolution example (no longer constrains → invalidate_memory)'
  );
}

function testChoosingTheRightToolUpdated() {
  console.log('\n--- Test 3: "Choosing the Right Tool" section reflects resolution ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  // update_memory should mention "still influences future behavior"
  assert(
    prompt.includes('still influences future behavior'),
    'update_memory guidance mentions "still influences future behavior"'
  );

  // invalidate_memory should mention "contradictions AND resolutions"
  assert(
    prompt.includes('contradictions AND resolutions'),
    'invalidate_memory guidance mentions "contradictions AND resolutions"'
  );

  // Should include concrete examples for invalidate_memory
  assert(
    prompt.includes('injury fully healed'),
    'invalidate_memory examples include "injury fully healed"'
  );
  assert(
    prompt.includes('goal achieved'),
    'invalidate_memory examples include "goal achieved"'
  );
}

function testResolutionNotPresentWithoutMemories() {
  console.log('\n--- Test 4: Memory management section absent when no memories exist ---');
  const prompt: string = buildSystemPrompt('test-session', [], []);

  // The Managing Memories section is only added when memories.length > 0
  assert(
    !prompt.includes('**Resolution**'),
    'no Resolution category when no memories'
  );
  assert(
    !prompt.includes('Choosing the Right Tool'),
    'no Choosing the Right Tool when no memories'
  );
}

// ============================================================
// Issue 2: Two-turn confirmation language in system prompt
// ============================================================

function testTwoTurnConfirmationLanguage() {
  console.log('\n--- Test 5: System prompt includes two-turn confirmation flow for memory tools ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('always ask the user to confirm first in a separate response'),
    'confirmation section says "in a separate response"'
  );
  assert(
    prompt.includes('CRITICAL: Do NOT call update_memory or invalidate_memory in the same response'),
    'prompt includes CRITICAL instruction not to call tools in same response'
  );
  assert(
    prompt.includes('This is a two-turn flow'),
    'prompt explicitly names it a "two-turn flow"'
  );
}

function testTwoTurnStepsDescribed() {
  console.log('\n--- Test 6: Two-turn flow steps are explicitly listed ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('You ask the user to confirm the memory change — no tool call in this turn'),
    'Step 1 described: ask user, no tool call'
  );
  assert(
    prompt.includes('If the user confirms, you call the memory tool on the next turn'),
    'Step 2 described: call tool on next turn'
  );
  assert(
    prompt.includes('If the user declines, you do not make any change'),
    'Step 3 described: no change on decline'
  );
}

function testWorkoutTwoTurnFlowStillPresent() {
  console.log('\n--- Test 7: Workout two-turn flow (Decision 11) still intact ---');
  const prompt: string = buildSystemPrompt('test-session', [], []);

  assert(
    prompt.includes('Workout Planning Flow'),
    'prompt still includes Workout Planning Flow section'
  );
  assert(
    prompt.includes('NEVER call confirm_proposal in the same response where you called create_plan'),
    'workout guardrail instruction still present'
  );
  assert(
    prompt.includes('two-turn confirmation flow'),
    'workout section still describes two-turn flow'
  );
}

function testAllFourCategoriesPresent() {
  console.log('\n--- Test 8: All four memory change categories present ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(prompt.includes('**Contradictions**'), 'Contradictions category present');
  assert(prompt.includes('**Refinements**'), 'Refinements category present');
  assert(prompt.includes('**Evolution**'), 'Evolution category present');
  assert(prompt.includes('**Resolution**'), 'Resolution category present');
}

function testResolutionExampleUsesInvalidate() {
  console.log('\n--- Test 9: Resolution example explicitly uses invalidate_memory, not update_memory ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  // Find the Resolution section and verify its Action line
  const resolutionIdx = prompt.indexOf('**Resolution**');
  assert(resolutionIdx > -1, 'Resolution section found');

  // The Action line after Resolution should say invalidate_memory
  const afterResolution = prompt.slice(resolutionIdx, resolutionIdx + 500);
  assert(
    afterResolution.includes('Action: Confirm, then use invalidate_memory'),
    'Resolution action line says "invalidate_memory"'
  );
  assert(
    afterResolution.includes('NOT update_memory'),
    'Resolution action line says "NOT update_memory"'
  );
}

function testInferenceBasedUpdatesStillPresent() {
  console.log('\n--- Test 10: Inference-Based Updates section still intact ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    prompt.includes('Inference-Based Updates'),
    'Inference-Based Updates section present'
  );
  assert(
    prompt.includes('Do NOT silently update or retire a memory based on inference'),
    'inference caution still present'
  );
}

function testDetectedMemoryChangesSection() {
  console.log('\n--- Test 11: Detected Memory Changes section when refinements present ---');
  const memories = [fakeMemory({ id: 'mem-123', fact: 'Has a knee injury' })];
  const refinements: any[] = [
    {
      existingMemoryId: 'mem-123',
      existingFact: 'Has a knee injury',
      suggestedUpdate: 'Knee has fully healed',
      reason: 'user stated recovery',
    },
  ];
  const prompt: string = buildSystemPrompt('test-session', memories, refinements);

  assert(
    prompt.includes('Detected Memory Changes'),
    'section title is "Detected Memory Changes"'
  );
  assert(
    !prompt.includes('Recently Updated Memories'),
    'old "Recently Updated Memories" section is gone'
  );
  assert(
    prompt.includes('have NOT been applied yet'),
    'prompt says changes have NOT been applied'
  );
  assert(
    prompt.includes('mem-123'),
    'prompt includes the memory ID'
  );
  assert(
    prompt.includes('Has a knee injury'),
    'prompt includes the current fact'
  );
  assert(
    prompt.includes('Knee has fully healed'),
    'prompt includes the detected update'
  );
  assert(
    prompt.includes('two-turn confirmation flow'),
    'prompt tells LLM to follow two-turn flow'
  );
}

function testNoDetectedChangesWithoutRefinements() {
  console.log('\n--- Test 12: No Detected Memory Changes section when no refinements ---');
  const memories = [fakeMemory()];
  const prompt: string = buildSystemPrompt('test-session', memories, []);

  assert(
    !prompt.includes('Detected Memory Changes'),
    'no Detected Memory Changes section when refinements are empty'
  );
}

// ============================================================
// RUNNER
// ============================================================

console.log('='.repeat(70));
console.log('SYSTEM PROMPT CONTENT — MEMORY SYSTEM FIXES');
console.log('='.repeat(70));

testResolutionCategoryPresent();
testEvolutionVsResolutionDistinction();
testChoosingTheRightToolUpdated();
testResolutionNotPresentWithoutMemories();
testTwoTurnConfirmationLanguage();
testTwoTurnStepsDescribed();
testWorkoutTwoTurnFlowStillPresent();
testAllFourCategoriesPresent();
testResolutionExampleUsesInvalidate();
testInferenceBasedUpdatesStillPresent();
testDetectedMemoryChangesSection();
testNoDetectedChangesWithoutRefinements();

console.log('\n' + '='.repeat(70));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(70));

if (failed > 0) {
  process.exit(1);
}
