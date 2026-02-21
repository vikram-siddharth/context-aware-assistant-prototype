import 'reflect-metadata';
import express from 'express';
import dotenv from 'dotenv';
import { AppDataSource } from './database/data-source';
import chatRoutes from './routes/chat-routes';
import { memoryAgent } from './agents/memory-agent';

dotenv.config();

const PORT = 3099; // Avoid collisions with dev server
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Send a POST to /api/chat and stream SSE events to the console.
 * Returns when the stream closes.
 */
async function streamChat(message: string, sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, userId: 'test-user' }),
  });

  if (!res.ok || !res.body) {
    console.error(`  Request failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.error(`  Body: ${text}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');
    // Keep the last (possibly incomplete) chunk in the buffer
    buffer = parts.pop() || '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          const json = line.slice(6);
          try {
            const event = JSON.parse(json);
            const label = event.type.toUpperCase().padEnd(8);
            // Truncate long result content for readability
            const content =
              event.type === 'result' && event.content.length > 200
                ? event.content.slice(0, 200) + '...'
                : event.content;
            console.log(`  [${label}] ${content}`);
          } catch {
            console.log(`  [RAW     ] ${json}`);
          }
        }
      }
    }
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('SSE STREAMING TEST');
  console.log('='.repeat(80));
  console.log();

  // 1. Initialize database
  console.log('Connecting to database...');
  await AppDataSource.initialize();
  console.log('Database connected\n');

  // Clean up memories so sessions start fresh
  const existing = await memoryAgent.getAllMemories('test-user');
  for (const m of existing) await memoryAgent.deleteMemory(m.id);
  console.log(`Cleaned ${existing.length} existing memories\n`);

  // 2. Start Express server
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`Server listening on ${BASE_URL}\n`);
      resolve(s);
    });
  });

  try {
    // ====================================================================
    // REQUEST 1: mention knee injury (session test-1)
    // ====================================================================
    console.log('='.repeat(80));
    console.log('REQUEST 1 — "I have a knee injury from running"  (session: test-1)');
    console.log('='.repeat(80));

    await streamChat('I have a knee injury from running', 'test-1');

    // Wait for async memory extraction
    console.log('\n  Waiting 3s for memory extraction...\n');
    await new Promise((r) => setTimeout(r, 3000));

    const memories = await memoryAgent.getAllMemories('test-user');
    console.log(`  Memories in DB: ${memories.length}`);
    memories.forEach((m, i) => {
      console.log(`    ${i + 1}. [${m.category}] ${m.fact}`);
    });
    console.log();

    // ====================================================================
    // REQUEST 2: plan a workout (session test-2, different session)
    // ====================================================================
    console.log('='.repeat(80));
    console.log('REQUEST 2 — "Plan a workout for today"  (session: test-2)');
    console.log('='.repeat(80));

    await streamChat('Plan a workout for today', 'test-2');

    console.log();
    console.log('='.repeat(80));
    console.log('DONE — both streams completed');
    console.log('='.repeat(80));
  } finally {
    server.close();
    await AppDataSource.destroy();
    console.log('\nServer stopped, database closed');
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
