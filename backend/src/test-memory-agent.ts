import 'reflect-metadata';
import { AppDataSource } from './database/data-source';
import { memoryAgent } from './agents/memory-agent';

async function testMemoryAgent() {
  try {
    // Initialize database
    console.log('Initializing database...');
    await AppDataSource.initialize();
    console.log('✅ Database connected');

    // Test 1: Extract memories from a message
    console.log('\n--- Test 1: Extracting memories ---');
    const testMessage = "I have a knee injury and I prefer morning workouts. My goal is to run a 5K in 3 months.";
    console.log('Message:', testMessage);

    await memoryAgent.extractMemories(testMessage);
    console.log('✅ Memory extraction completed (check logs above)');

    // Test 2: Retrieve all memories
    console.log('\n--- Test 2: Retrieving all memories ---');
    const allMemories = await memoryAgent.getAllMemories();
    console.log('Total memories:', allMemories.length);
    allMemories.forEach((m) => {
      console.log(`- ${m.fact} (${m.category}, ${m.persistence})`);
    });

    // Test 3: Retrieve relevant memories for a query
    console.log('\n--- Test 3: Retrieving relevant memories ---');
    const query = "I want to plan a running workout for tomorrow";
    console.log('Query:', query);

    const relevantMemories = await memoryAgent.retrieveRelevantMemories(query);
    console.log('Relevant memories:', relevantMemories.length);
    relevantMemories.forEach((m) => {
      console.log(`- ${m.fact} (${m.category})`);
    });

    console.log('\n✅ All tests completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testMemoryAgent();
