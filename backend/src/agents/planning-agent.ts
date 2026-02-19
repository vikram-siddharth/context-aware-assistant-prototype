import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import dotenv from 'dotenv';
import { Memory } from '../entities/Memory';
import { ToolProvider, ToolDefinition } from './tool-provider';

dotenv.config();

/**
 * Planning Agent
 *
 * Uses LLM to generate personalized workout plans based on:
 * - User's stated goal/request
 * - Relevant memories (constraints, preferences, goals)
 * - Current date context
 *
 * Does NOT write to the database - only generates plans
 */

// Schema for the planned workout
const WorkoutPlanSchema = z.object({
  type: z.string().describe('Type of workout (e.g., cardio, strength, yoga, flexibility, HIIT)'),
  duration: z.number().describe('Duration in minutes'),
  description: z.string().describe('Detailed description of the workout, including specific exercises or activities'),
  explanation: z.string().describe('User-facing explanation of why this plan was chosen, especially how it respects any constraints'),
});

export interface GeneratedPlan {
  type: string;
  duration: number;
  description: string;
  explanation: string;
}

export class PlanningAgent implements ToolProvider {
  private model: any;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not found in environment variables');
    }

    this.model = anthropic('claude-sonnet-4-20250514');
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'create_plan',
        description:
          'Generate a personalized workout plan based on user goals and constraints. This does NOT save the workout — it creates a proposal that must be confirmed by the user via confirm_proposal. Use this for forward-looking requests like "plan a workout for tomorrow" or "create a strength routine for me".',
        inputSchema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: "The user's goal or what they want to achieve with the workout",
            },
            date: {
              type: 'string',
              description: 'Target date in ISO format (YYYY-MM-DD). Defaults to today if not specified.',
            },
          },
          required: ['goal'],
        },
        actionDescription: 'Creating a personalized workout plan...',
        execute: async (input: { goal: string; date?: string; memories?: Memory[] }) => {
          const plan = await this.generatePlan(input.goal, input.memories || [], input.date);
          return {
            success: true,
            proposal: {
              type: plan.type,
              duration: plan.duration,
              description: plan.description,
              explanation: plan.explanation,
            },
          };
        },
      },
    ];
  }

  /**
   * Generate a personalized workout plan
   *
   * @param request - The user's request or goal
   * @param memories - Relevant memories (constraints, preferences, goals)
   * @param currentDate - Optional current date (defaults to today)
   * @returns A structured workout plan with explanation
   */
  async generatePlan(
    request: string,
    memories: Memory[] = [],
    currentDate?: string
  ): Promise<GeneratedPlan> {
    const date = currentDate || new Date().toISOString().split('T')[0];

    console.log('[PlanningAgent] Generating plan for request:', request);
    console.log(`[PlanningAgent] Considering ${memories.length} memories`);

    // Build context from memories
    const memoryContext = this.buildMemoryContext(memories);

    // Build system prompt focused on workout planning
    const systemPrompt = `You are a specialized workout planning assistant. Your job is to create a single, personalized workout plan based on the user's request.

Today's date is ${date}.

## Your Responsibilities
1. Analyze the user's request to understand their fitness goal
2. ALWAYS respect any physical constraints from the user's memory (injuries, limitations, medical conditions)
3. Consider the user's preferences and goals from memory
4. Generate a workout plan that is safe, effective, and appropriate
5. Explain your reasoning, especially when constraints affect your recommendations

## Critical Rules
- If the user has a constraint (e.g., knee injury, back pain), you MUST design around it
- When a constraint rules out certain exercises, explain what you're avoiding and why
- Suggest appropriate alternatives that respect the constraint
- Be specific in your workout descriptions (include exercise types, intensity levels, etc.)
- Keep duration realistic (typically 20-90 minutes)
- Choose appropriate workout types: cardio, strength, yoga, flexibility, HIIT, sports, etc.

${memoryContext}

Generate a single workout plan that addresses the user's request while respecting all constraints.`;

    try {
      const result = await generateObject({
        model: this.model,
        schema: WorkoutPlanSchema,
        system: systemPrompt,
        prompt: request,
      });

      console.log('[PlanningAgent] Plan generated successfully');
      return result.object;
    } catch (error) {
      console.error('[PlanningAgent] Error generating plan:', error);
      throw new Error('Failed to generate workout plan');
    }
  }

  /**
   * Build memory context string for the system prompt
   */
  private buildMemoryContext(memories: Memory[]): string {
    if (memories.length === 0) {
      return '';
    }

    let context = '## User Context (MUST Respect)\n\n';

    // Group memories by category
    const constraints = memories.filter((m) => m.category === 'constraint');
    const preferences = memories.filter((m) => m.category === 'preference');
    const goals = memories.filter((m) => m.category === 'goal');

    if (constraints.length > 0) {
      context += '### CONSTRAINTS (Hard Requirements)\n';
      constraints.forEach((m) => {
        context += `- ${m.fact}\n`;
      });
      context += '\n';
    }

    if (goals.length > 0) {
      context += '### Goals\n';
      goals.forEach((m) => {
        context += `- ${m.fact}\n`;
      });
      context += '\n';
    }

    if (preferences.length > 0) {
      context += '### Preferences\n';
      preferences.forEach((m) => {
        context += `- ${m.fact}\n`;
      });
      context += '\n';
    }

    return context;
  }
}

// Export a singleton instance
export const planningAgent = new PlanningAgent();
