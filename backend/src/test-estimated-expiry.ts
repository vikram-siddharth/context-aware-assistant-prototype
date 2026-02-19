import 'reflect-metadata';
import { AppDataSource } from './database/data-source';
import { Memory, MemoryCategory, MemoryPersistence } from './entities/Memory';

async function testEstimatedExpiry() {
  try {
    console.log('Initializing database...');
    await AppDataSource.initialize();
    console.log('✅ Database connected\n');

    const memoryRepository = AppDataSource.getRepository(Memory);

    // ── Test 1: Schema metadata ────────────────────────────────────
    console.log('--- Test 1: Schema metadata ---');
    const metadata = AppDataSource.getMetadata(Memory);
    const expiryColumn = metadata.columns.find(
      (col) => col.propertyName === 'estimated_expiry'
    );

    if (!expiryColumn) {
      throw new Error('estimated_expiry column not found in entity metadata');
    }
    console.log('  Column found:', expiryColumn.propertyName);
    console.log('  Type:', expiryColumn.type);
    console.log('  Nullable:', expiryColumn.isNullable);
    console.log('  Default:', expiryColumn.default);

    let pass = true;

    if (expiryColumn.type !== 'date') {
      console.error('  ❌ Expected type "date", got:', expiryColumn.type);
      pass = false;
    }
    if (!expiryColumn.isNullable) {
      console.error('  ❌ Expected nullable to be true');
      pass = false;
    }
    if (expiryColumn.default !== null) {
      console.error('  ❌ Expected default null, got:', expiryColumn.default);
      pass = false;
    }

    if (pass) {
      console.log('  ✅ Schema metadata is correct\n');
    } else {
      throw new Error('Schema metadata assertions failed');
    }

    // ── Test 2: Direct DB round-trip (no estimated_expiry set) ─────
    console.log('--- Test 2: New memory defaults to estimated_expiry: null ---');
    const memory = memoryRepository.create({
      fact: 'test fact for expiry column',
      category: MemoryCategory.PREFERENCE,
      persistence: MemoryPersistence.LONG_TERM,
    });
    const saved = await memoryRepository.save(memory);
    console.log('  Saved memory ID:', saved.id);

    // Re-read from DB to confirm the column value
    const fetched = await memoryRepository.findOneBy({ id: saved.id });
    if (!fetched) {
      throw new Error('Could not re-read saved memory');
    }

    console.log('  estimated_expiry value:', fetched.estimated_expiry);
    if (fetched.estimated_expiry !== null) {
      console.error('  ❌ Expected null, got:', fetched.estimated_expiry);
      throw new Error('estimated_expiry should be null for new memories');
    }
    console.log('  ✅ New memory has estimated_expiry: null\n');

    // ── Test 3: Existing memories are unaffected ───────────────────
    console.log('--- Test 3: Existing memories have estimated_expiry: null ---');
    const allMemories = await memoryRepository.find();
    console.log('  Total memories in DB:', allMemories.length);

    const badMemories = allMemories.filter(
      (m) => m.estimated_expiry !== null && m.id !== saved.id
    );
    if (badMemories.length > 0) {
      console.error(
        '  ❌ Found memories with non-null estimated_expiry:',
        badMemories.map((m) => m.id)
      );
      throw new Error('Existing memories should have null estimated_expiry');
    }
    console.log('  ✅ All existing memories have estimated_expiry: null\n');

    // ── Cleanup ────────────────────────────────────────────────────
    await memoryRepository.delete(saved.id);
    console.log('Cleaned up test memory.');
    console.log('\n✅ All tests passed');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

testEstimatedExpiry();
