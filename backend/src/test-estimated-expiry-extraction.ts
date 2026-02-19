import 'reflect-metadata';
import { AppDataSource } from './database/data-source';
import { Memory } from './entities/Memory';
import { memoryAgent } from './agents/memory-agent';

async function testExtractionWithExpiry() {
  const createdIds: string[] = [];

  try {
    console.log('Initializing database...');
    await AppDataSource.initialize();
    console.log('✅ Database connected\n');

    const memoryRepository = AppDataSource.getRepository(Memory);

    // ── Test 4: Extraction integration ─────────────────────────────
    console.log('--- Test 4: Memory extraction produces estimated_expiry: null ---');
    const message = 'I am allergic to peanuts and I enjoy cycling on weekends.';
    console.log('  Message:', message);

    const result = await memoryAgent.extractMemories(message);
    console.log('  Extracted memories:', result.newMemories.length);

    if (result.newMemories.length === 0) {
      throw new Error('Expected at least one memory to be extracted');
    }

    let allNull = true;
    for (const mem of result.newMemories) {
      createdIds.push(mem.id);

      // Re-read from DB to be sure (don't trust the in-memory object alone)
      const fromDb = await memoryRepository.findOneBy({ id: mem.id });
      if (!fromDb) {
        throw new Error(`Could not re-read memory ${mem.id} from DB`);
      }

      console.log(
        `  - "${fromDb.fact}" (${fromDb.category}, ${fromDb.persistence}) → estimated_expiry: ${fromDb.estimated_expiry}`
      );

      if (fromDb.estimated_expiry !== null) {
        console.error(`  ❌ Memory ${fromDb.id} has non-null estimated_expiry`);
        allNull = false;
      }
    }

    if (!allNull) {
      throw new Error('Some extracted memories had non-null estimated_expiry');
    }
    console.log('  ✅ All extracted memories have estimated_expiry: null\n');

    // ── Cleanup ────────────────────────────────────────────────────
    for (const id of createdIds) {
      await memoryRepository.delete(id);
    }
    console.log('Cleaned up test memories.');
    console.log('\n✅ Test passed');
    process.exit(0);
  } catch (error) {
    // Best-effort cleanup
    if (createdIds.length > 0) {
      try {
        const repo = AppDataSource.getRepository(Memory);
        for (const id of createdIds) {
          await repo.delete(id);
        }
      } catch {}
    }
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testExtractionWithExpiry();
