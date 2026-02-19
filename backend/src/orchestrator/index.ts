import Anthropic from '@anthropic-ai/sdk';
import { CoreMessage } from 'ai';
import { memoryAgent, MemoryRefinement } from '../agents/memory-agent';
import { taskAgent } from '../agents/task-agent';
import { planningAgent } from '../agents/planning-agent';
import { sessionController, PendingProposal } from '../session/session-controller';
import { WorkoutStatus } from '../entities/Workout';
import { Memory } from '../entities/Memory';
import { ToolProvider, ToolDefinition } from '../agents/tool-provider';
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
interface RegisteredTool {
  definition: ToolDefinition;
  execute: (input: any) => Promise<any>;
}

export class Orchestrator {
  private client: Anthropic;
  private toolRegistry: Map<string, RegisteredTool>;

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not found in environment variables');
    }

    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    this.toolRegistry = this.buildToolRegistry([taskAgent, memoryAgent, planningAgent]);
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
    const tool = this.toolRegistry.get(toolName);
    return tool?.definition.actionDescription || 'Working on that...';
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

      // Memories are loaded into context but NOT announced at session start.
      // They only surface via thinking events when they actively influence a decision.
    } else {
      // Subsequent messages: use cached memories, no events
      memories = sessionController.getSessionMemories(sessionId) || [];
      console.log(`[Orchestrator] Using ${memories.length} cached memories for session ${sessionId}`);
    }

    // Run extraction (awaited so we can use refinement signals in the prompt)
    const extractionResult = await memoryAgent.extractMemories(userMessage);

    if (extractionResult.newMemories.length > 0) {
      const cached = sessionController.getSessionMemories(sessionId) || [];
      sessionController.setSessionMemories(sessionId, [...cached, ...extractionResult.newMemories]);
      console.log(`[Orchestrator] Added ${extractionResult.newMemories.length} new memories to session cache`);
    }

    // Auto-apply refinements detected by extraction.
    // The user explicitly provided more specific info — their own words are the confirmation.
    const appliedRefinements: MemoryRefinement[] = [];
    if (extractionResult.refinements.length > 0) {
      for (const ref of extractionResult.refinements) {
        const updated = await memoryAgent.updateMemoryFact(ref.existingMemoryId, ref.suggestedUpdate);
        if (updated) {
          appliedRefinements.push(ref);
          console.log(`[Orchestrator] Auto-applied refinement: "${ref.existingFact}" → "${ref.suggestedUpdate}"`);
        }
      }

      if (appliedRefinements.length > 0) {
        await this.emit(onEvent, { type: 'action', content: 'Updating my notes...' });

        // Refresh session cache so the system prompt and future messages see updated facts
        const refreshed = await memoryAgent.getAllMemories();
        sessionController.setSessionMemories(sessionId, refreshed);
        memories = refreshed;
      }
    }

    // Step 2: Build system prompt with memory context + applied refinement notifications
    const systemPrompt = this.buildSystemPrompt(sessionId, memories, appliedRefinements);

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
      const toolsCalledThisTurn: Set<string> = new Set();

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
          // Guardrail: block confirm_proposal in the same turn as create_plan
          if (toolsCalledThisTurn.has('create_plan') && toolCall.name === 'confirm_proposal') {
            console.log(`[Orchestrator] Guardrail: Blocked confirm_proposal — create_plan was called this turn`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: JSON.stringify({
                success: false,
                message: 'Cannot save a workout in the same turn as plan generation. Present the plan to the user first and wait for their confirmation.',
              }),
            });
            continue;
          }

          console.log(`[Orchestrator] Executing tool: ${toolCall.name}`);
          toolsCalledThisTurn.add(toolCall.name);

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
   * Get tool definitions in Anthropic format from the registry
   */
  private getToolDefinitions(): Anthropic.Tool[] {
    return Array.from(this.toolRegistry.values()).map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      input_schema: tool.definition.inputSchema,
    }));
  }

  /**
   * Execute a tool call via registry lookup
   */
  private async executeTool(toolName: string, input: any): Promise<any> {
    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return tool.execute(input);
  }

  /**
   * Build tool registry from all agents' getTools() methods.
   * Fails at startup if two agents register the same tool name.
   */
  private buildToolRegistry(providers: ToolProvider[]): Map<string, RegisteredTool> {
    const registry = new Map<string, RegisteredTool>();

    for (const provider of providers) {
      for (const tool of provider.getTools()) {
        if (registry.has(tool.name)) {
          throw new Error(
            `Tool name collision at startup: "${tool.name}" is registered by multiple agents`
          );
        }
        registry.set(tool.name, { definition: tool, execute: tool.execute });
      }
    }

    this.applyToolWrappers(registry);
    return registry;
  }

  /**
   * Apply orchestrator-level wrappers for tools that need session coordination.
   * Each wrapper delegates to the agent's execute function but adds context
   * the agent doesn't have (session state, memory cache refreshes).
   */
  private applyToolWrappers(registry: Map<string, RegisteredTool>): void {
    // create_plan: inject session memories, stash proposal in session state
    const createPlan = registry.get('create_plan')!;
    const createPlanBase = createPlan.execute;
    createPlan.execute = async (input: any) => {
      const sessionMemories = sessionController.getSessionMemories(this.currentSessionId) || [];
      const result = await createPlanBase({ ...input, memories: sessionMemories });

      const proposalDate = input.date || new Date().toISOString().split('T')[0];
      const proposal: PendingProposal = {
        type: result.proposal.type,
        duration: result.proposal.duration,
        date: proposalDate,
        description: result.proposal.description,
        status: WorkoutStatus.SCHEDULED,
        explanation: result.proposal.explanation,
        goal: input.goal,
      };

      sessionController.setPendingProposal(this.currentSessionId, proposal);

      return {
        ...result,
        proposal: {
          ...result.proposal,
          date: proposalDate,
        },
        message: 'Plan generated. Present this to the user and wait for their confirmation before saving.',
      };
    };

    // confirm_proposal: read pending proposal from session, pass as input, clear after success
    const confirmProposal = registry.get('confirm_proposal')!;
    const confirmProposalBase = confirmProposal.execute;
    confirmProposal.execute = async (_input: any) => {
      const pending = sessionController.getPendingProposal(this.currentSessionId);

      if (!pending) {
        return {
          success: false,
          message: 'No pending proposal to confirm. Use create_plan first to generate a workout plan.',
        };
      }

      const result = await confirmProposalBase({
        type: pending.type,
        duration: pending.duration,
        date: new Date(pending.date),
        description: pending.description,
        status: pending.status,
      });

      sessionController.clearPendingProposal(this.currentSessionId);
      return result;
    };

    // update_memory: refresh session cache after update
    const updateMemory = registry.get('update_memory')!;
    const updateMemoryBase = updateMemory.execute;
    updateMemory.execute = async (input: any) => {
      const result = await updateMemoryBase(input);
      if (result.success) {
        const refreshed = await memoryAgent.getAllMemories();
        sessionController.setSessionMemories(this.currentSessionId, refreshed);
      }
      return result;
    };

    // invalidate_memory: refresh session cache after invalidation
    const invalidateMemory = registry.get('invalidate_memory')!;
    const invalidateMemoryBase = invalidateMemory.execute;
    invalidateMemory.execute = async (input: any) => {
      const result = await invalidateMemoryBase(input);
      if (result.success) {
        const refreshed = await memoryAgent.getAllMemories();
        sessionController.setSessionMemories(this.currentSessionId, refreshed);
      }
      return result;
    };
  }

  /**
   * Build a system prompt that includes relevant memories and any pending conflicts
   */
  private buildSystemPrompt(sessionId: string, memories: Memory[], refinements: MemoryRefinement[] = []): string {
    const currentDate = new Date().toISOString().split('T')[0];

    let systemPrompt = `You are a friendly, conversational fitness buddy who helps users track workouts and create personalized plans.

Today's date is ${currentDate}.

## Your Capabilities
- Generate personalized workout plans based on user goals and constraints
- Retrieve workout history with filters
- Remember user facts (injuries, preferences, goals) and use them to guide planning

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

## Session Intent vs. Durable Facts

Not everything the user says is worth remembering. Distinguish between:

**Session intent** — what the user wants to do right now:
- "I'd like to swim" / "I'd love to swim" / "Can we do yoga?"
- "I want a 30-minute workout today"
- "Let's focus on upper body"

These drive the current conversation and planning, but are NOT durable facts. Do not treat them as preferences, do not offer to remember them, and do not use update_memory or invalidate_memory based on them.

**Durable facts** — stable truths about the user:
- "I like swimming" / "I love yoga" / "I enjoy running"
- "I usually work out for 30 minutes"
- "I prefer upper body exercises"

These reflect ongoing preferences, habits, or conditions worth remembering.

**The key test**: Conditional or request phrasing ("I'd like to…", "I'd love to…", "I want to…", "Can we…", "Let's do…") signals session intent. General or habitual phrasing ("I like…", "I love…", "I enjoy…", "I usually…", "I always…", "I hate…") signals a durable fact.

## Workout Planning Flow

All workout creation goes through a two-turn confirmation flow:

1. When the user asks for a workout plan, use create_plan to generate a personalized plan
2. Present the plan to the user in a friendly, conversational way — include what the workout involves, how long it is, and why you chose it
3. Ask the user clearly whether you should schedule the workout. Use direct language like "Should I go ahead and schedule this?" or "Want me to save this workout?" — not vague prompts like "ready to give it a go?"
4. When asking for confirmation, restate the key details in a brief summary: workout type, duration, date, and any notable accommodations. The user should be able to say yes based on the confirmation message alone, without re-reading earlier messages.
5. Only after the user confirms (on a subsequent message), use confirm_proposal to save it
6. If the user wants changes, use create_plan again with an adjusted goal
7. If the user rejects the plan entirely, acknowledge it and move on — do NOT save anything

### Key Rules
- NEVER call confirm_proposal in the same response where you called create_plan. You must present the plan and wait for the user's next message.
- All workout creation goes through create_plan → confirm_proposal. There is no way to create a workout without this two-turn flow.
`;

    // Add memory context if available
    if (memories.length > 0) {
      systemPrompt += '\n## User Context\n';

      memories.forEach((memory) => {
        systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) ${memory.fact}\n`;
      });

      systemPrompt += `
### How to Use These Memories
- Do NOT list or announce memories at the start of a conversation.
- Only surface a memory when it actively influences a specific decision you are making right now. Mention it naturally as part of your reasoning — for example, "Keeping your knee injury in mind, I'll focus on low-impact options."
- Constraint memories are hard requirements — always respect them when planning or suggesting activities.
- If a memory is not relevant to the current request, do not mention it at all.

## Managing Memories

You have tools to update or retire stored memories. Use them with care — here are the rules:

### When to Consider a Change
There are three categories of memory change. Be alert for all of them:

**Contradictions** — a stored fact is no longer true.
Example: You know "has a knee injury" but the user says "my knee is fully healed now."
Action: Confirm, then use invalidate_memory.

**Refinements** — the user provides more specific or detailed information about an existing fact without changing its core meaning.
Example: You know "has a shoulder injury" but the user says "my shoulder is dislocated."
Action: Confirm, then use update_memory with the more precise version.

**Evolution** — the condition or fact has changed but not disappeared entirely.
Example: You know "has a broken ankle" but the user says "my ankle is mostly healed, just a bit stiff."
Action: Confirm, then use update_memory to reflect the current state.

### Inference-Based Updates
- You may infer that a stored fact has changed based on reasonable evidence, not just explicit statements.
- If the user says something that implies a stored fact may no longer be accurate (e.g., "I went for a 10K run" when you know they have a knee injury), treat it as a signal worth checking — not as proof.
- When you notice an implication like this, ask the user conversationally to confirm. For example: "Nice — a 10K! Last I knew your knee was giving you trouble. Has that cleared up?"
- Do NOT silently update or retire a memory based on inference. Always confirm first.
- Use good judgment about what counts as a reasonable inference. "I went for a run" with a stored knee injury is worth asking about. "I did some yoga" with a strength-training goal is not — those are compatible.

### Confirmation Before Acting
- Before calling update_memory or invalidate_memory, **always ask the user to confirm first**.
- **IMPORTANT: Never contradict what the user just said.** When the user tells you something new, acknowledge it and propose the update forward-looking. Do NOT restate the old fact as if it's still current.
  - BAD: "I have it noted that your shoulder is dislocated. Should I update that?" (restates old fact, ignores what the user just said)
  - GOOD: "Got it — sounds like your shoulder has improved. Want me to update what I have on file so I keep that in mind going forward?" (acknowledges the new info, proposes the change naturally)
  - BAD: "You mentioned you prefer mornings — are you switching to evenings?" (frames the old fact as current)
  - GOOD: "Sounds like you've moved to evening workouts — should I remember that going forward?" (leads with the new info)
- If the user confirms the change, proceed with the appropriate tool call.
- If the user does not respond to your question and moves on to a different topic, you may proceed with the change, but briefly mention what you did (e.g., "By the way, I've noted that your shoulder is feeling better now — let me know if that's not right.").

### Choosing the Right Tool
- **update_memory**: Use for refinements and evolution — the fact is being updated, not erased.
- **invalidate_memory**: Use for contradictions — the fact is no longer true at all and should be retired.

Use the memory ID from the User Context section above.
`;
    }

    // Notify the LLM about refinements that were already applied
    if (refinements.length > 0) {
      systemPrompt += '\n## Recently Updated Memories\n';
      systemPrompt += 'Based on what the user just said, the following memories were automatically updated with more specific information:\n\n';

      for (const ref of refinements) {
        systemPrompt += `- "${ref.existingFact}" → "${ref.suggestedUpdate}" (${ref.reason})\n`;
      }

      systemPrompt += '\nBriefly and naturally acknowledge these updates in your response — for example, "Got it, I\'ll keep in mind that your shoulder is dislocated" — woven into whatever else you\'re saying. Do not use technical language like "updated my records" or "noted in the system."\n';
    }

    // Add pending proposal context if one exists
    const pendingProposal = sessionController.getPendingProposal(sessionId);
    if (pendingProposal) {
      systemPrompt += `\n## Pending Workout Proposal
There is a workout plan waiting for the user's confirmation:
- Type: ${pendingProposal.type}
- Duration: ${pendingProposal.duration} minutes
- Date: ${pendingProposal.date}
- Description: ${pendingProposal.description}
- Explanation: ${pendingProposal.explanation}

If the user confirms (e.g., "yes", "looks good", "go ahead"), use confirm_proposal to save it.
If the user wants changes, use create_plan again with an adjusted goal. The original goal was: "${pendingProposal.goal}"
If the user rejects it or changes topic, acknowledge their decision and move on.
`;
    }

    return systemPrompt;
  }

}

// Export a singleton instance
export const orchestrator = new Orchestrator();
