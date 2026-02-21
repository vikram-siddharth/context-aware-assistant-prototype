import 'reflect-metadata';
import express from 'express';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import { Memory, MemoryCategory, MemoryPersistence } from './entities/Memory';
import memoryRoutes from './routes/memory-routes';

dotenv.config();

const PORT = 3098; // Avoid collisions with dev server and other tests
const BASE_URL = `http://localhost:${PORT}`;

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

async function main() {
  console.log('='.repeat(80));
  console.log('MEMORY API ENDPOINT TESTS (Decision 13)');
  console.log('='.repeat(80));
  console.log();

  // 1. Initialize database
  console.log('Connecting to database...');
  await AppDataSource.initialize();
  console.log('Database connected\n');

  const memoryRepo = AppDataSource.getRepository(Memory);

  // 2. Start Express server with memory routes
  const app = express();
  app.use(express.json());
  app.use('/api/memories', memoryRoutes);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`Server listening on ${BASE_URL}\n`);
      resolve(s);
    });
  });

  // Track IDs for cleanup
  const createdIds: string[] = [];
  const preExistingActiveIds: string[] = [];

  try {
    // ==================================================================
    // TEST 1: Empty state — no active memories
    // ==================================================================
    console.log('--- Test 1: Empty state returns empty array ---');

    // Deactivate all existing active memories so we start clean (track for restore)
    const preExisting = await memoryRepo.find({ where: { active: true } });
    for (const m of preExisting) {
      preExistingActiveIds.push(m.id);
      await memoryRepo.update(m.id, { active: false });
    }

    const res1 = await fetch(`${BASE_URL}/api/memories`);
    const body1 = await res1.json();

    assert(res1.status === 200, 'Status is 200');
    assert(Array.isArray(body1.memories), 'Response has memories array');
    assert(body1.memories.length === 0, 'No memories returned when none are active');
    console.log();

    // ==================================================================
    // TEST 2: Returns active memories with correct fields
    // ==================================================================
    console.log('--- Test 2: Returns active memories with correct shape ---');

    const m1 = memoryRepo.create({
      fact: 'have a knee injury',
      category: MemoryCategory.CONSTRAINT,
      persistence: MemoryPersistence.TEMPORARY,
      active: true,
    });
    const saved1 = await memoryRepo.save(m1);
    createdIds.push(saved1.id);

    const m2 = memoryRepo.create({
      fact: 'like swimming',
      category: MemoryCategory.PREFERENCE,
      persistence: MemoryPersistence.PERMANENT,
      active: true,
    });
    const saved2 = await memoryRepo.save(m2);
    createdIds.push(saved2.id);

    const res2 = await fetch(`${BASE_URL}/api/memories`);
    const body2 = await res2.json();

    assert(res2.status === 200, 'Status is 200');
    assert(body2.memories.length === 2, `Returns 2 active memories (got ${body2.memories.length})`);

    // Verify response shape — each memory should have exactly these fields
    const firstMemory = body2.memories[0];
    assert('id' in firstMemory, 'Memory has id field');
    assert('fact' in firstMemory, 'Memory has fact field');
    assert('category' in firstMemory, 'Memory has category field');
    assert('persistence' in firstMemory, 'Memory has persistence field');
    assert('estimated_expiry' in firstMemory, 'Memory has estimated_expiry field');
    assert('created_at' in firstMemory, 'Memory has created_at field');

    // Verify no extra fields leak (e.g., active flag should not be exposed)
    const fieldCount = Object.keys(firstMemory).length;
    assert(fieldCount === 6, `Memory has exactly 6 fields (got ${fieldCount})`);
    assert(!('active' in firstMemory), 'active flag is NOT exposed in response');
    console.log();

    // ==================================================================
    // TEST 3: Inactive memories are excluded
    // ==================================================================
    console.log('--- Test 3: Inactive memories are excluded ---');

    const m3 = memoryRepo.create({
      fact: 'want to run a marathon',
      category: MemoryCategory.GOAL,
      persistence: MemoryPersistence.TEMPORARY,
      active: false, // Inactive — should NOT appear
    });
    const saved3 = await memoryRepo.save(m3);
    createdIds.push(saved3.id);

    const res3 = await fetch(`${BASE_URL}/api/memories`);
    const body3 = await res3.json();

    assert(body3.memories.length === 2, `Still returns only 2 active memories (got ${body3.memories.length})`);

    const returnedFacts = body3.memories.map((m: any) => m.fact);
    assert(!returnedFacts.includes('want to run a marathon'), 'Inactive memory not in results');
    assert(returnedFacts.includes('have a knee injury'), 'Active constraint memory present');
    assert(returnedFacts.includes('like swimming'), 'Active preference memory present');
    console.log();

    // ==================================================================
    // TEST 4: Correct category and persistence values
    // ==================================================================
    console.log('--- Test 4: Category and persistence values are correct ---');

    const kneeMemory = body3.memories.find((m: any) => m.fact === 'have a knee injury');
    const swimMemory = body3.memories.find((m: any) => m.fact === 'like swimming');

    assert(kneeMemory.category === 'constraint', `Knee injury category is constraint (got ${kneeMemory.category})`);
    assert(kneeMemory.persistence === 'temporary', `Knee injury persistence is temporary (got ${kneeMemory.persistence})`);
    assert(swimMemory.category === 'preference', `Swimming category is preference (got ${swimMemory.category})`);
    assert(swimMemory.persistence === 'permanent', `Swimming persistence is permanent (got ${swimMemory.persistence})`);
    console.log();

    // ==================================================================
    // TEST 5: Ordering — newest first (DESC by created_at)
    // ==================================================================
    console.log('--- Test 5: Memories ordered newest first ---');

    // m2 (swimming) was created after m1 (knee), so should appear first
    assert(body3.memories[0].fact === 'like swimming', `First memory is the newest (got "${body3.memories[0].fact}")`);
    assert(body3.memories[1].fact === 'have a knee injury', `Second memory is the oldest (got "${body3.memories[1].fact}")`);
    console.log();

    // ==================================================================
    // TEST 6: created_at is a valid ISO date string
    // ==================================================================
    console.log('--- Test 6: created_at is a parseable date ---');

    const dateStr = body3.memories[0].created_at;
    const parsed = new Date(dateStr);
    assert(!isNaN(parsed.getTime()), `created_at parses to valid Date (value: ${dateStr})`);
    console.log();

    // ==================================================================
    // TEST 7: estimated_expiry round-trip (set date vs null)
    // ==================================================================
    console.log('--- Test 7: estimated_expiry round-trip ---');

    const expiryDate = new Date('2026-06-15');
    const m4 = memoryRepo.create({
      fact: 'recovering from shoulder surgery',
      category: MemoryCategory.CONSTRAINT,
      persistence: MemoryPersistence.TEMPORARY,
      active: true,
      estimated_expiry: expiryDate,
    });
    const saved4 = await memoryRepo.save(m4);
    createdIds.push(saved4.id);

    const res7 = await fetch(`${BASE_URL}/api/memories`);
    const body7 = await res7.json();

    const shoulderMemory = body7.memories.find((m: any) => m.fact === 'recovering from shoulder surgery');
    const swimMemory7 = body7.memories.find((m: any) => m.fact === 'like swimming');

    assert(shoulderMemory !== undefined, 'Memory with expiry exists in response');
    assert(shoulderMemory.estimated_expiry !== null, 'estimated_expiry is not null for memory with expiry set');
    const parsedExpiry = new Date(shoulderMemory.estimated_expiry);
    assert(!isNaN(parsedExpiry.getTime()), `estimated_expiry parses to valid Date (value: ${shoulderMemory.estimated_expiry})`);
    assert(
      parsedExpiry.toISOString().startsWith('2026-06-15'),
      `estimated_expiry matches set date (got ${parsedExpiry.toISOString()})`,
    );

    assert(swimMemory7.estimated_expiry === null, `Memory without expiry returns null (got ${swimMemory7.estimated_expiry})`);
    console.log();

    // ==================================================================
    // RESULTS
    // ==================================================================
    console.log('='.repeat(80));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(80));
  } finally {
    // Cleanup: delete test memories we created
    for (const id of createdIds) {
      await memoryRepo.delete(id);
    }
    // Reactivate memories that were active before the test
    for (const id of preExistingActiveIds) {
      await memoryRepo.update(id, { active: true });
    }

    server.close();
    await AppDataSource.destroy();
    console.log('\nServer stopped, database closed');

    if (failed > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
