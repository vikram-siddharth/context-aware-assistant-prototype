import 'reflect-metadata';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

/**
 * Simple test to verify Anthropic API connection and tool usage
 */
async function testAnthropicTools() {
  console.log('Testing Anthropic API with tools...\n');

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Schedule a 30-minute yoga workout for tomorrow',
      },
    ],
    tools: [
      {
        name: 'create_workout',
        description: 'Create a new workout',
        input_schema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Type of workout',
            },
            duration: {
              type: 'number',
              description: 'Duration in minutes',
            },
            date: {
              type: 'string',
              description: 'Date in ISO format',
            },
          },
          required: ['type', 'duration', 'date'],
        },
      },
    ],
  });

  console.log('Response:', JSON.stringify(message, null, 2));
}

testAnthropicTools().catch(console.error);
