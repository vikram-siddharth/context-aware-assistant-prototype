import Anthropic from '@anthropic-ai/sdk';
import { CoreMessage } from 'ai';
import { memoryAgent } from '../agents/memory-agent';
import { taskAgent } from '../agents/task-agent';
import { planningAgent } from '../agents/planning-agent';
import { sessionController } from '../session/session-controller';
import { WorkoutStatus } from '../entities/Workout';
import { Memory } from '../entities/Memory';
import dotenv from 'dotenv';

dotenv.config();

export type OrchestratorEvent = {
  type: 'thinking' | 'action' | 'result' | 'error';
  content: string;
};

export type EventCallback = (event: OrchestratorEvent) => void;

/**
 * Orchestrator
 *
 * Central intelligence layer that:
 * - Retrieves relevant memories
 * - Builds context-aware system prompts
 * - Calls LLM with tool definitions
 * - Delegates tool execution to specialized agents
 * - Triggers async memory extraction
 * - Emits human-readable events via callback for SSE streaming
 */
export class Orchestrator {
  private client: Anthropic;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not found in environment variables');
    }

    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  private currentSessionId: string = ''; // Track current session for tool execution

  /**
   * Small delay between rapid events so the UI can render them
   */
  private delay(ms: number = 400): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Emit an event through the callback, with a delay to pace rapid events
   */
  private async emit(
    onEvent: EventCallback | undefined,
    event: OrchestratorEvent
  ): Promise<void> {
    if (onEvent) {
      onEvent(event);
      await this.delay();
    }
  }

  /**
   * Get a human-readable description of what a tool does (no tool names or JSON)
   */
  private describeToolAction(toolName: string): string {
    switch (toolName) {
      case 'create_workout':
        return 'Scheduling your workout...';
      case 'get_workouts':
        return 'Looking up your workouts...';
      case 'create_plan':
        return 'Creating a personalized workout plan...';
      case 'update_memory':
        return 'Updating my notes...';
      case 'invalidate_memory':
        return 'Updating my notes...';
      default:
        return 'Working on that...';
    }
  }

  /**
   * Rephrase a raw memory fact into natural second-person recall.
   * Memory facts from the DB are third-person descriptions like
   * "Has a knee injury from running" or "Prefers morning workouts".
   * We convert the leading verb to second-person so the articles and
   * phrasing stay intact:
   *   "Has a knee injury" → "I remember you have a knee injury"
   *   "Is training for a 5K" → "I remember you are training for a 5K"
   */
  private rephraseFact(fact: string): string {
    let clean = fact.replace(/\.$/, '');

    // Convert third-person verbs to second-person
    const conversions: [RegExp, string][] = [
      [/^Has\b\s*/i, 'have '],
      [/^Had\b\s*/i, 'had '],
      [/^Is\b\s*/i, 'are '],
      [/^Was\b\s*/i, 'were '],
      [/^Wants to\b\s*/i, 'want to '],
      [/^Prefers\b\s*/i, 'prefer '],
      [/^Likes\b\s*/i, 'like '],
      [/^Dislikes\b\s*/i, 'dislike '],
      [/^Needs\b\s*/i, 'need '],
      [/^Enjoys\b\s*/i, 'enjoy '],
    ];

    for (const [pattern, replacement] of conversions) {
      if (pattern.test(clean)) {
        clean = clean.replace(pattern, replacement);
        return `I remember you ${clean}`;
      }
    }

    // Fallback for facts without a recognized leading verb
    clean = clean.charAt(0).toLowerCase() + clean.slice(1);

    // Skip article if one is already present or the phrase starts with a gerund
    if (/^(a |an |the |my |your )/i.test(clean) || /^\w+ing\b/.test(clean)) {
      return `I remember you mentioned ${clean}`;
    }

    const article = /^[aeiou]/i.test(clean) ? 'an' : 'a';
    return `I remember you mentioned ${article} ${clean}`;
  }

  /**
   * Process a user message and generate a response
   *
   * @param userMessage - The user's message
   * @param conversationHistory - Previous messages in the conversation
   * @param onEvent - Optional callback for emitting streaming events
   * @param sessionId - Session identifier for memory caching
   * @returns The assistant's response
   */
  async processMessage(
    userMessage: string,
    conversationHistory: CoreMessage[] = [],
    onEvent?: EventCallback,
    sessionId: string = 'default',
  ): Promise<{ response: string }> {
    console.log('[Orchestrator] Processing message:', userMessage);
    this.currentSessionId = sessionId;

    // Step 1: Load memories (once per session) and extract new ones
    const isFirstMessage = !sessionController.hasLoadedMemories(sessionId);
    let memories: Memory[];

    if (isFirstMessage) {
      // First message in session: load all active memories from DB
      memories = await memoryAgent.getAllMemories();
      sessionController.setSessionMemories(sessionId, memories);
      console.log(`[Orchestrator] Loaded ${memories.length} memories for new session ${sessionId}`);

      // Emit thinking events only on first message, only if there are memories
      if (memories.length > 0) {
        await this.emit(onEvent, { type: 'thinking', content: 'Checking if I remember anything relevant...' });
        for (const memory of memories) {
          const rephrased = this.rephraseFact(memory.fact);
          await this.emit(onEvent, { type: 'thinking', content: rephrased });
        }
      }
    } else {
      // Subsequent messages: use cached memories, no events
      memories = sessionController.getSessionMemories(sessionId) || [];
      console.log(`[Orchestrator] Using ${memories.length} cached memories for session ${sessionId}`);
    }

    // Run extraction best-effort (async, per-message)
    memoryAgent.extractMemories(userMessage).then((result) => {
      if (result.newMemories.length > 0) {
        // Add newly extracted memories to the session cache
        const cached = sessionController.getSessionMemories(sessionId) || [];
        sessionController.setSessionMemories(sessionId, [...cached, ...result.newMemories]);
        console.log(`[Orchestrator] Added ${result.newMemories.length} new memories to session cache`);
      }
    });

    // Step 2: Build system prompt with memory context
    const systemPrompt = this.buildSystemPrompt(memories);

    // Step 3: Convert conversation history to Anthropic format
    const messages: Anthropic.MessageParam[] = [
      ...conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content as string,
      })),
      {
        role: 'user' as const,
        content: userMessage,
      },
    ];

    // Step 5: Call LLM with tools (with agentic loop)
    try {
      let response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: this.getToolDefinitions(),
      });

      // Handle tool calls in a loop (agentic execution)
      let iterationCount = 0;
      const maxIterations = 5;

      while (response.stop_reason === 'tool_use' && iterationCount < maxIterations) {
        iterationCount++;
        console.log(`[Orchestrator] Tool use iteration ${iterationCount}`);

        // Extract tool calls from response
        const toolCalls = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
        );

        // Execute all tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolCall of toolCalls) {
          console.log(`[Orchestrator] Executing tool: ${toolCall.name}`);

          await this.emit(onEvent, {
            type: 'action',
            content: this.describeToolAction(toolCall.name),
          });

          const result = await this.executeTool(toolCall.name, toolCall.input);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }

        // Add assistant response and tool results to messages
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        messages.push({
          role: 'user',
          content: toolResults,
        });

        // Continue the conversation with tool results
        response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          tools: this.getToolDefinitions(),
        });
      }

      // Extract final text response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      const finalResponse = textBlocks.map((block) => block.text).join('\n');

      console.log('[Orchestrator] Response generated successfully');

      if (onEvent) {
        onEvent({ type: 'result', content: finalResponse });
      }

      return { response: finalResponse };
    } catch (error) {
      console.error('[Orchestrator] Error generating response:', error);
      if (onEvent) {
        onEvent({ type: 'error', content: 'Something went wrong. Please try again.' });
      }
      throw new Error('Failed to generate response');
    }
  }

  /**
   * Get tool definitions in Anthropic format
   */
  private getToolDefinitions(): Anthropic.Tool[] {
    return [
      {
        name: 'create_workout',
        description:
          'Create a new workout. Use this when the user wants to schedule or log a workout.',
        input_schema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Type of workout (e.g., cardio, strength, yoga)',
            },
            duration: {
              type: 'number',
              description: 'Duration in minutes',
            },
            date: {
              type: 'string',
              description: 'Date in ISO format (YYYY-MM-DD)',
            },
            description: {
              type: 'string',
              description: 'Optional description or notes',
            },
            status: {
              type: 'string',
              enum: ['scheduled', 'completed', 'cancelled'],
              description: 'Workout status (defaults to scheduled)',
            },
          },
          required: ['type', 'duration', 'date'],
        },
      },
      {
        name: 'get_workouts',
        description:
          'Retrieve workouts with optional filters. Use this when the user asks about their workout history or schedule.',
        input_schema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['scheduled', 'completed', 'cancelled'],
              description: 'Filter by workout status',
            },
            type: {
              type: 'string',
              description: 'Filter by workout type',
            },
            startDate: {
              type: 'string',
              description: 'Filter by start date (ISO format)',
            },
            endDate: {
              type: 'string',
              description: 'Filter by end date (ISO format)',
            },
          },
        },
      },
      {
        name: 'create_plan',
        description:
          'Generate and save a personalized workout plan based on user goals and constraints. Uses LLM to create a single workout that respects physical constraints from memory, then saves it to the database. Use this when the user asks for a workout plan or routine.',
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: "The user's goal or what they want to achieve with the workout",
            },
          },
          required: ['goal'],
        },
      },
      {
        name: 'update_memory',
        description:
          'Update an existing memory when the user provides new information that refines or evolves a stored fact — without fully contradicting it. For example, "has a broken ankle" evolving to "has a swollen ankle", or "runs 3 times a week" changing to "runs 5 times a week". Always inform the user when you do this.',
        input_schema: {
          type: 'object',
          properties: {
            memoryId: {
              type: 'string',
              description: 'The ID of the memory to update (from the User Context section)',
            },
            newFact: {
              type: 'string',
              description: 'The updated fact text that replaces the old one',
            },
            reason: {
              type: 'string',
              description: 'Brief reason why this memory is being updated',
            },
          },
          required: ['memoryId', 'newFact', 'reason'],
        },
      },
      {
        name: 'invalidate_memory',
        description:
          'Retire an outdated memory when the user indicates a previously stored fact is no longer true. For example, if the user said they had a knee injury but now says it has healed, use this tool to retire the old constraint. Always inform the user when you do this.',
        input_schema: {
          type: 'object',
          properties: {
            memoryId: {
              type: 'string',
              description: 'The ID of the memory to retire (from the User Context section)',
            },
            reason: {
              type: 'string',
              description: 'Brief reason why this memory is being retired',
            },
          },
          required: ['memoryId', 'reason'],
        },
      },
    ];
  }

  /**
   * Execute a tool call
   */
  private async executeTool(toolName: string, input: any): Promise<any> {
    switch (toolName) {
      case 'create_workout':
        const workout = await taskAgent.createWorkout({
          type: input.type,
          duration: input.duration,
          date: new Date(input.date),
          description: input.description,
          status: input.status as WorkoutStatus | undefined,
        });

        return {
          success: true,
          workout: {
            id: workout.id,
            type: workout.type,
            duration: workout.duration,
            date: workout.date.toISOString(),
            status: workout.status,
          },
        };

      case 'get_workouts':
        const filter: any = {};
        if (input.status) filter.status = input.status as WorkoutStatus;
        if (input.type) filter.type = input.type;
        if (input.startDate) filter.startDate = new Date(input.startDate);
        if (input.endDate) filter.endDate = new Date(input.endDate);

        const workouts = await taskAgent.getWorkouts(filter);

        return {
          success: true,
          count: workouts.length,
          workouts: workouts.map((w) => ({
            id: w.id,
            type: w.type,
            duration: w.duration,
            date: w.date.toISOString(),
            status: w.status,
            description: w.description,
          })),
        };

      case 'create_plan':
        // Generate the plan using the Planning Agent
        const sessionMemories = sessionController.getSessionMemories(this.currentSessionId) || [];
        const generatedPlan = await planningAgent.generatePlan(
          input.goal,
          sessionMemories
        );

        // Create a workout based on the generated plan using the Task Agent
        const plannedWorkout = await taskAgent.createWorkout({
          type: generatedPlan.type,
          duration: generatedPlan.duration,
          date: new Date(), // Default to today, but this could be customized
          description: generatedPlan.description,
          status: 'scheduled' as WorkoutStatus,
        });

        return {
          success: true,
          workout: {
            id: plannedWorkout.id,
            type: plannedWorkout.type,
            duration: plannedWorkout.duration,
            date: plannedWorkout.date.toISOString(),
            description: plannedWorkout.description,
            status: plannedWorkout.status,
          },
          explanation: generatedPlan.explanation,
        };

      case 'update_memory':
        const updated = await memoryAgent.updateMemoryFact(input.memoryId, input.newFact);
        if (updated) {
          // Refresh session cache so subsequent messages see the updated memory
          const refreshedAfterUpdate = await memoryAgent.getAllMemories();
          sessionController.setSessionMemories(this.currentSessionId, refreshedAfterUpdate);
        }
        return {
          success: updated,
          message: updated
            ? `Memory updated successfully: ${input.reason}`
            : 'Memory not found or could not be updated',
        };

      case 'invalidate_memory':
        const invalidated = await memoryAgent.invalidateMemory(input.memoryId);
        if (invalidated) {
          // Refresh session cache so the invalidated memory is removed from context
          const refreshedAfterInvalidate = await memoryAgent.getAllMemories();
          sessionController.setSessionMemories(this.currentSessionId, refreshedAfterInvalidate);
        }
        return {
          success: invalidated,
          message: invalidated
            ? `Memory retired successfully: ${input.reason}`
            : 'Memory not found or already retired',
        };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Build a system prompt that includes relevant memories and any pending conflicts
   */
  private buildSystemPrompt(memories: Memory[]): string {
    const currentDate = new Date().toISOString().split('T')[0];

    let systemPrompt = `You are a friendly, conversational fitness buddy who helps users track workouts and create personalized plans.

Today's date is ${currentDate}.

## Your Capabilities
- Create and manage workouts (schedule, log, or cancel)
- Retrieve workout history with filters
- Generate structured workout plans based on user goals

## Communication Style
- Talk like a supportive friend, not a form or a database.
- Never use technical jargon, field names, database terminology, tool names, parameter names, JSON, status codes, or any internal implementation details.
- Never say things like "I've stored that", "updated the record", "memory ID", "database", "constraint category", or anything that sounds like a system talking. You're a person who remembers things, not a machine that stores data.
- When you need workout details, gather them conversationally — one or two questions at a time, woven into natural dialogue. Never present a numbered checklist, structured form, or bullet-point questionnaire.
  - Instead of "Type of workout:", ask "What kind of exercise are you in the mood for?"
  - Instead of "Duration (minutes):", ask "How long are you thinking — a quick 20-minute session or something longer?"
  - Instead of "Date (YYYY-MM-DD):", ask "When are you planning to do this — today, tomorrow?"
- Let the conversation flow. If the user gives partial info, work with what they said and ask a natural follow-up for anything missing.
- Keep responses warm, brief, and encouraging. Sound like a real person, not a system.

## Important Rules
1. ALWAYS respect user constraints from memory (injuries, allergies, limitations)
2. Use the available tools to perform actions — don't just describe what to do
3. When creating workouts, use appropriate types (cardio, strength, yoga, etc.)
4. Dates should be in YYYY-MM-DD format when calling tools, but always use natural language with the user (e.g., "this Thursday" not "2026-02-19")
`;

    // Add memory context if available
    if (memories.length > 0) {
      systemPrompt += '\n## User Context (Remember and Respect These)\n';

      memories.forEach((memory) => {
        systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) ${memory.fact}\n`;
      });

      systemPrompt += '\nPay special attention to CONSTRAINT memories — these are hard requirements you MUST respect.\n';

      systemPrompt += `
## Managing Memories

You have tools to update or retire stored memories. Use them with care — here are the rules:

### When to Consider a Change
- Only propose an update or retirement when the user's statement **directly and clearly** addresses the stored fact.
- Do NOT infer memory changes from indirect evidence. For example, "I went for a run" does NOT mean a knee injury has healed. "I did some yoga" does NOT mean they've dropped a strength-training goal.
- For PREFERENCE memories, be especially conservative. Only propose a change if the user clearly and explicitly expresses a different preference (e.g., "Actually, I've switched to evening workouts" — not just "I worked out this morning").

### Confirmation Before Acting
- Before calling update_memory or invalidate_memory, **always ask the user to confirm first**.
- **IMPORTANT: Never contradict what the user just said.** When the user tells you something new, acknowledge it and propose the update forward-looking. Do NOT restate the old fact as if it's still current.
  - BAD: "I have it noted that your shoulder is dislocated. Should I update that?" (restates old fact, ignores what the user just said)
  - GOOD: "Got it — can I update my notes to reflect that your shoulder is no longer dislocated but just sore?" (acknowledges the new info and proposes the change)
  - BAD: "You mentioned you prefer mornings — are you switching to evenings?" (frames the old fact as current)
  - GOOD: "Sounds like you've moved to evening workouts — should I update my notes to reflect that?" (leads with the new info)
- If the user confirms the change, proceed with the appropriate tool call.
- If the user ignores your question and moves on to a different topic, you may proceed with the change in your next response, but briefly mention what you decided (e.g., "By the way, I updated my notes to reflect that your shoulder is just sore now — let me know if that's not right.").

### Choosing the Right Tool
- **update_memory**: The user refines or evolves an existing fact without fully contradicting it. For example, "has a broken ankle" evolving to "has a swollen ankle", or "runs 3 times a week" changing to "runs 5 times a week".
- **invalidate_memory**: The user indicates a stored fact is no longer true at all. For example, a knee injury has fully healed, or a goal has been dropped entirely.

Use the memory ID from the User Context section above.
`;
    }

    return systemPrompt;
  }

}

// Export a singleton instance
export const orchestrator = new Orchestrator();
