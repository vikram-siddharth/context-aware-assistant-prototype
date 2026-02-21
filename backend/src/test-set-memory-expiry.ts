import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { orchestrator } from './orchestrator';
import { sessionController } from './session/session-controller';
import { memoryAgent } from './agents/memory-agent';
import { Memory, MemoryCategory, MemoryPersistence } from './entities/Memory';

dotenv.config();

/**
 * Tests for set_memory_expiry tool — DB execution + orchestrator wrapper
 *
 *  1. set_memory_expiry sets expiry in DB (round-trip verification)
 *  2. Invalid date returns success: false without DB write
 *  3. Wrapper refreshes session memory cache after successful set
 *  4. Calling set_memory_expiry again updates (overwrites) the expiry
 *  5. Nonexistent memory ID returns success: false
 */

let passed = 0;
let failed = 0;
const createdMemoryIds: string[] = [];

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
const executeTool = (orchestrator as any).executeTool.bind(orchestrator);

function setCurrentSessionId(sessionId: string): void {
  (orchestrator as any).currentSessionId = sessionId;
}

async function createTestMemory(): Promise<Memory> {
  const repo = AppDataSource.getRepository(Memory);
  const memory = repo.create({
    fact: 'have a sprained ankle',
    category: MemoryCategory.CONSTRAINT,
    persistence: MemoryPersistence.TEMPORARY,
  });
  const saved = await repo.save(memory);
  createdMemoryIds.push(saved.id);
  return saved;
}

// ============================================================
// TESTS
// ============================================================

async function testSetExpiryWritesToDB() {
  console.log('\n--- Test 1: set_memory_expiry writes expiry to DB ---');
  const memory = await createTestMemory();
  const sessionId = 'test-expiry-1';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, [memory]);

  const result = await executeTool('set_memory_expiry', {
    memoryId: memory.id,
    date: '2026-06-15',
  });

  assert(result.success === true, 'returns success: true');
  assert(result.message.includes('2026-06-15'), 'message includes the date');

  // Verify DB round-trip
  const repo = AppDataSource.getRepository(Memory);
  const fromDb = await repo.findOneBy({ id: memory.id });
  assert(fromDb !== null, 'memory still exists in DB');

  const expiryStr = fromDb!.estimated_expiry
    ? new Date(fromDb!.estimated_expiry).toISOString().split('T')[0]
    : null;
  assert(expiryStr === '2026-06-15', `DB has estimated_expiry = 2026-06-15 (got ${expiryStr})`);
}

async function testInvalidDateReturnsError() {
  console.log('\n--- Test 2: Invalid date returns success: false ---');
  const memory = await createTestMemory();
  const sessionId = 'test-expiry-2';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, [memory]);

  const result = await executeTool('set_memory_expiry', {
    memoryId: memory.id,
    date: 'not-a-date',
  });

  assert(result.success === false, 'returns success: false for invalid date');
  assert(result.message.includes('Invalid date'), 'error message mentions invalid date');

  // Verify DB was not changed
  const repo = AppDataSource.getRepository(Memory);
  const fromDb = await repo.findOneBy({ id: memory.id });
  assert(fromDb!.estimated_expiry === null, 'DB still has null expiry (no write occurred)');
}

async function testWrapperRefreshesSessionCache() {
  console.log('\n--- Test 3: Wrapper refreshes session memory cache after set ---');
  const memory = await createTestMemory();
  const sessionId = 'test-expiry-3';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, [memory]);

  // Before: cached memory has null expiry
  const cachedBefore = sessionController.getSessionMemories(sessionId)!;
  const memBefore = cachedBefore.find(m => m.id === memory.id);
  assert(memBefore?.estimated_expiry === null || memBefore?.estimated_expiry === undefined,
    'cached memory starts with null expiry');

  await executeTool('set_memory_expiry', {
    memoryId: memory.id,
    date: '2026-08-01',
  });

  // After: cached memory should have updated expiry (wrapper refreshed from DB)
  const cachedAfter = sessionController.getSessionMemories(sessionId)!;
  assert(cachedAfter !== null, 'session cache still exists after set');
  const memAfter = cachedAfter.find(m => m.id === memory.id);
  assert(memAfter !== undefined, 'memory still in cache after set');

  const cachedExpiryStr = memAfter?.estimated_expiry
    ? new Date(memAfter.estimated_expiry).toISOString().split('T')[0]
    : null;
  assert(cachedExpiryStr === '2026-08-01',
    `cached memory has updated expiry 2026-08-01 (got ${cachedExpiryStr})`);
}

async function testOverwriteExpiry() {
  console.log('\n--- Test 4: Calling set_memory_expiry again overwrites the expiry ---');
  const memory = await createTestMemory();
  const sessionId = 'test-expiry-4';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, [memory]);

  // Set initial expiry
  await executeTool('set_memory_expiry', {
    memoryId: memory.id,
    date: '2026-04-01',
  });

  const repo = AppDataSource.getRepository(Memory);
  const after1 = await repo.findOneBy({ id: memory.id });
  const expiry1 = after1!.estimated_expiry
    ? new Date(after1!.estimated_expiry).toISOString().split('T')[0]
    : null;
  assert(expiry1 === '2026-04-01', `first set: expiry is 2026-04-01 (got ${expiry1})`);

  // Overwrite with new expiry
  const result = await executeTool('set_memory_expiry', {
    memoryId: memory.id,
    date: '2026-05-15',
  });
  assert(result.success === true, 'overwrite returns success: true');

  const after2 = await repo.findOneBy({ id: memory.id });
  const expiry2 = after2!.estimated_expiry
    ? new Date(after2!.estimated_expiry).toISOString().split('T')[0]
    : null;
  assert(expiry2 === '2026-05-15', `overwrite: expiry is now 2026-05-15 (got ${expiry2})`);
}

async function testNonexistentMemoryId() {
  console.log('\n--- Test 5: Nonexistent memory ID returns success: false ---');
  const sessionId = 'test-expiry-5';
  setCurrentSessionId(sessionId);
  sessionController.setSessionMemories(sessionId, []);

  const result = await executeTool('set_memory_expiry', {
    memoryId: '00000000-0000-0000-0000-000000000000',
    date: '2026-12-25',
  });

  assert(result.success === false, 'returns success: false for nonexistent ID');
  assert(result.message.includes('not found'), 'error message mentions not found');
}

// ============================================================
// RUNNER
// ============================================================

async function main() {
  console.log('='.repeat(70));
  console.log('SET_MEMORY_EXPIRY TOOL — EXECUTION + WRAPPER TESTS');
  console.log('='.repeat(70));

  console.log('\nConnecting to database...');
  await AppDataSource.initialize();
  console.log('Database connected\n');

  try {
    await testSetExpiryWritesToDB();
    await testInvalidDateReturnsError();
    await testWrapperRefreshesSessionCache();
    await testOverwriteExpiry();
    await testNonexistentMemoryId();
  } finally {
    // Cleanup test memories
    if (createdMemoryIds.length > 0) {
      const repo = AppDataSource.getRepository(Memory);
      for (const id of createdMemoryIds) {
        await repo.delete(id);
      }
      console.log(`\nCleaned up ${createdMemoryIds.length} test memories.`);
    }

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
