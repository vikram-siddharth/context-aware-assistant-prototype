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

    // Advance the turn counter and expire stale memory change authorizations
    sessionController.incrementTurn(sessionId);
    sessionController.expireStaleChanges(sessionId, 3);

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
      memories = [...memories, ...extractionResult.newMemories];
      console.log(`[Orchestrator] Added ${extractionResult.newMemories.length} new memories to session cache`);
    }

    // Refinements detected by extraction are NOT auto-applied.
    // They are passed to the LLM as signals so it can handle them through
    // the two-turn confirmation flow (ask user → wait → call tool).
    const detectedRefinements = extractionResult.refinements;
    if (detectedRefinements.length > 0) {
      console.log(`[Orchestrator] Detected ${detectedRefinements.length} refinement(s) — passing to LLM for confirmation`);

      // Pre-arm specific memory IDs. The LLM will ask the user to confirm
      // (no tool call this turn). On the next turn, when the user confirms
      // and the LLM calls update_memory/invalidate_memory, the guardrail
      // checks the specific memory ID and allows execution.
      const memoryIds = detectedRefinements.map(r => r.existingMemoryId);
      sessionController.armPendingMemoryChanges(sessionId, memoryIds);
    }

    // Step 2: Build system prompt with memory context + detected refinement signals
    const systemPrompt = this.buildSystemPrompt(sessionId, memories, detectedRefinements, extractionResult.newMemories);

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

          // Guardrail: block memory mutation tools unless user confirmation was received for the specific memory.
          // Arms the memory ID on block so the tool can succeed on retry — either within the
          // same agentic loop (inference path) or on the next processMessage call (extraction path).
          if (toolCall.name === 'update_memory' || toolCall.name === 'invalidate_memory') {
            const memoryId = (toolCall.input as any).memoryId;

            if (!sessionController.isMemoryChangeAuthorized(this.currentSessionId, memoryId)) {
              console.log(`[Orchestrator] Guardrail: Blocked ${toolCall.name} for memory ${memoryId} — user confirmation required first`);
              sessionController.armPendingMemoryChanges(this.currentSessionId, [memoryId]);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: JSON.stringify({
                  success: false,
                  message: 'This tool was blocked because no prior confirmation was registered for this specific memory. Check the conversation: if the user has already confirmed this change in their most recent message, you may call this tool again immediately. If the user has not yet confirmed, ask them first and do not call this tool until they respond.',
                }),
              });
              continue;
            }
          }

          // Consume the specific memory's authorization when the tool actually executes
          if (toolCall.name === 'update_memory' || toolCall.name === 'invalidate_memory') {
            const memoryId = (toolCall.input as any).memoryId;
            sessionController.consumeMemoryChange(this.currentSessionId, memoryId);
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

    // set_memory_expiry: refresh session cache after setting expiry
    const setMemoryExpiry = registry.get('set_memory_expiry')!;
    const setMemoryExpiryBase = setMemoryExpiry.execute;
    setMemoryExpiry.execute = async (input: any) => {
      const result = await setMemoryExpiryBase(input);
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
  private buildSystemPrompt(sessionId: string, memories: Memory[], refinements: MemoryRefinement[] = [], newMemories: Memory[] = []): string {
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

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const twoWeeksFromNow = new Date(today);
      twoWeeksFromNow.setDate(twoWeeksFromNow.getDate() + 14);

      const expiringMemories: { memory: Memory; status: 'expired' | 'expiring_soon'; daysUntil: number }[] = [];

      memories.forEach((memory) => {
        let expiryLabel = '';
        if (memory.estimated_expiry) {
          const expiryDate = new Date(memory.estimated_expiry);
          const expiryStr = expiryDate.toISOString().split('T')[0];
          expiryLabel = ` (expires: ${expiryStr})`;

          const daysUntil = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          if (daysUntil <= 0) {
            expiringMemories.push({ memory, status: 'expired', daysUntil });
          } else if (daysUntil <= 14) {
            expiringMemories.push({ memory, status: 'expiring_soon', daysUntil });
          }
        }
        systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) ${memory.fact}${expiryLabel}\n`;
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

**Resolution** — a constraint, preference, or goal has been fully resolved and no longer influences future behavior.
Example: You know "has a knee injury" but the user says "my knee has fully healed." A healed injury is not an updated injury — it is a resolved one. There is no meaningful constraint left to track.
Action: Confirm, then use invalidate_memory (NOT update_memory).

**Key distinction for evolution vs. resolution**: If the evolved state still represents a constraint, preference, or goal that should influence future planning, use update_memory. If the evolved state means the fact no longer needs to influence behavior at all, use invalidate_memory. "Shoulder is sore but improving" still constrains planning → update_memory. "Wound has fully healed" no longer constrains anything → invalidate_memory.

### Inference-Based Updates
- You may infer that a stored fact has changed based on reasonable evidence, not just explicit statements.
- If the user says something that implies a stored fact may no longer be accurate, treat it as a signal worth checking — not as proof.
- Distinguish between levels of incompatibility:

  **Physically incompatible** — the activity is impossible if the stored fact is still true.
  Example: "I went running yesterday" when you know "has a broken ankle." You cannot run on a broken ankle. This strongly implies the constraint is resolved.
  Action: Your default assumption should be **resolution** (invalidate_memory), not evolution (update_memory). Do NOT hedge by softening the constraint into a weaker version (e.g., "ankle is recovering") — if the user ran on it, it's not broken anymore. Ask the user whether the constraint is still a factor at all, giving them a clear path to either outcome. For example: "Nice — a run! That sounds like your ankle has healed. Should I stop keeping that in mind as a limitation, or is it still something I should factor into your workouts?"
  - If the user says it's resolved ("yeah it's fine now") → use invalidate_memory
  - If the user says it's still a factor ("it's better but still not 100%") → use update_memory with the user's own description of the current state, not your guess

  **Inadvisable but possible** — the activity is risky given the stored fact but not impossible.
  Example: "I went for a light jog" when you know "has a knee injury." Jogging with a knee injury is possible but not recommended.
  Action: Ask conversationally whether the condition has changed. For example: "Nice — how's the knee holding up? Last I knew it was giving you trouble."

  **Compatible** — the activity does not conflict with the stored fact at all.
  Example: "I did some yoga" when you know "has a strength-training goal." These are compatible.
  Action: Do nothing — no need to ask about the memory.

- The key test: **could the user physically do this if the stored fact were still true?** If no, the fact has almost certainly been resolved — default to proposing invalidation, not a softened update. If yes but risky, ask about it. If yes and harmless, ignore it.
- Do NOT silently update or retire a memory based on inference. Always confirm first.
- When proposing a memory change from inference, ask the user whether the constraint still applies at all. Let the user tell you the current state — do not invent a hedged version of the constraint on their behalf.

### Confirmation Before Acting
- Before calling update_memory or invalidate_memory, **always ask the user to confirm first in a separate response**.
- **CRITICAL: Do NOT call update_memory or invalidate_memory in the same response where you ask for confirmation.** Ask the question first, wait for the user's reply, and only call the tool on the next turn if they agree. This is a two-turn flow — just like workout creation:
  1. You ask the user to confirm the memory change — no tool call in this turn
  2. If the user confirms, you call the memory tool on the next turn
  3. If the user declines, you do not make any change
- **IMPORTANT: Never contradict what the user just said.** When the user tells you something new, acknowledge it and propose the update forward-looking. Do NOT restate the old fact as if it's still current.
  - BAD: "I have it noted that your shoulder is dislocated. Should I update that?" (restates old fact, ignores what the user just said)
  - GOOD: "Got it — sounds like your shoulder has improved. Want me to update what I have on file so I keep that in mind going forward?" (acknowledges the new info, proposes the change naturally)
  - BAD: "You mentioned you prefer mornings — are you switching to evenings?" (frames the old fact as current)
  - GOOD: "Sounds like you've moved to evening workouts — should I remember that going forward?" (leads with the new info)
- **Multiple memory changes:** If you detect multiple changes that need confirmation, you may ask about them together in one message (e.g., "Sounds like your shoulder has healed and you've also started running more often. Should I update my notes on both?"). There is no need to ask about each one separately across multiple turns.
- If the user confirms the change, proceed with the appropriate tool call on that turn.
- **Patience window:** If the user does not respond to your confirmation question (ignores it, changes topic, or addresses something else), wait patiently. Do NOT repeat the question on the very next turn. You have up to three turns to wait. Only after three turns of no response should you quietly proceed with the change based on your best judgment, and briefly mention what you did (e.g., "By the way, I went ahead and updated my notes about your shoulder — let me know if that's not right.").
- **Do not nag.** Ask once, then let it go until either the user responds or three turns pass. If the user is in the middle of a different topic, do not interrupt to re-ask about the memory change.

### Choosing the Right Tool
- **update_memory**: Use for refinements and evolution where the fact still influences future behavior — the details changed but the fact still matters (e.g., "shoulder injury" → "shoulder is sore but improving").
- **invalidate_memory**: Use for contradictions AND resolutions — the fact is either no longer true or has been fully resolved and no longer needs to influence behavior (e.g., injury fully healed, goal achieved, preference abandoned).

Use the memory ID from the User Context section above.

### Setting Expiry on Memories

When new facts are extracted (listed in the "Newly Extracted Memories" section when present), determine whether they have natural endpoints:

**Facts with natural endpoints** (set an expiry):
- Injuries and physical conditions (heal over time)
- Goals with target dates (races, competitions, milestones)
- Time-bound projects or commitments
- Temporary restrictions or seasonal preferences

**Facts that are likely indefinite** (leave expiry null — do not call set_memory_expiry):
- General preferences ("like swimming", "prefer mornings")
- Abilities and stable traits
- Chronic or permanent conditions
- Personality-level facts

For facts with a natural endpoint, ask the user about the timeframe at a natural point in the conversation — not as an interruption to their primary request. Adapt the question to the category:
- **Goals**: Ask for a specific date ("When is the race?")
- **Preferences**: Ask for a window ("How long will the project keep you busy?")
- **Constraints**: Ask gently, open-ended ("Do you have a sense of how long recovery might take?")

If the user answers, use set_memory_expiry with their input.

If the user ignores the question or gives an unhelpful answer, do not ask again. Wait patiently — the user has up to three turns to respond. If the user provides the timeframe in a later message (even if they're talking about something else), use set_memory_expiry with their answer. Only after three turns of no response should you fall back to estimating a reasonable expiry based on the fact text, category, and conversation context, and call set_memory_expiry with your best estimate.

**The LLM always sets an expiry for facts with natural endpoints.** The conversational ask is an attempt to get better data, not a prerequisite.

If the user provides a specific date correction ("the race is in May, not April"), use set_memory_expiry to update it directly — no confirmation needed. If the user mentions a vague timeline change ("my recovery is taking longer than expected"), ask for clarification on the new timeframe before calling set_memory_expiry.

**Expiry applies to updates too.** When you use update_memory and the new fact includes temporal information (a date, deadline, or timeframe), also call set_memory_expiry to capture that date. The fact text and the estimated_expiry field serve different purposes — the fact describes what is true, the expiry date drives check-in behavior. Both should be populated.
`;

      // Add expiring memories check-in section if any memories are expired or expiring soon
      if (expiringMemories.length > 0) {
        systemPrompt += '\n## Expiring Memories — Check-In Needed\n';
        systemPrompt += 'The following memories are expired or approaching their estimated expiry. Check in with the user about these:\n\n';

        for (const { memory, status, daysUntil } of expiringMemories) {
          const expiryStr = new Date(memory.estimated_expiry!).toISOString().split('T')[0];
          if (status === 'expired') {
            systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) "${memory.fact}" — **EXPIRED** (was estimated to expire on ${expiryStr}, ${Math.abs(daysUntil)} days ago)\n`;
          } else {
            systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) "${memory.fact}" — **EXPIRING SOON** (estimated expiry: ${expiryStr}, ${daysUntil} days away)\n`;
          }
        }

        systemPrompt += `
Check-in rules:
- **Goals and preferences** approaching or past expiry: Raise proactively at the first natural opportunity in the conversation. A passed race date or expired time-bound preference should be surfaced promptly.
- **Constraints** approaching or past expiry: Raise when relevant to the conversation (which in a fitness context is most of the time).
- After the check-in, use existing tools based on the user's response:
  - Still applies → extend the expiry via set_memory_expiry
  - Fully resolved → retire via invalidate_memory
  - Changed details → update via update_memory
- Weave the check-in naturally — e.g., "By the way, your half-marathon was coming up — how did it go?" or "Last I knew, your ankle was on the mend. How's it feeling these days?"
`;
      }
    }

    // Signal newly extracted memories to the LLM (especially for expiry-setting)
    if (newMemories.length > 0) {
      systemPrompt += '\n## Newly Extracted Memories\n';
      systemPrompt += 'The following facts were just extracted from the user\'s message and saved:\n\n';

      const needExpiry: Memory[] = [];
      for (const memory of newMemories) {
        systemPrompt += `- [${memory.category.toUpperCase()}] (ID: ${memory.id}) "${memory.fact}" — persistence: ${memory.persistence}\n`;
        if (memory.persistence !== 'permanent') {
          needExpiry.push(memory);
        }
      }

      if (needExpiry.length > 0) {
        systemPrompt += '\nThe memories marked short_term or long_term have natural endpoints. For each one, follow the expiry-setting flow described in "Setting Expiry on Memories" above — ask the user about the timeframe at a natural point in this conversation.\n';
      }
    }

    // Pass detected refinements to the LLM as signals that need confirmation
    if (refinements.length > 0) {
      systemPrompt += '\n## Detected Memory Changes\n';
      systemPrompt += 'Based on what the user just said, the following existing memories may need to be updated or retired. These changes have NOT been applied yet — you must handle them through the confirmation flow.\n\n';

      for (const ref of refinements) {
        systemPrompt += `- Memory ID: ${ref.existingMemoryId} — current: "${ref.existingFact}" → detected: "${ref.suggestedUpdate}" (${ref.reason})\n`;
      }

      systemPrompt += `
Evaluate each detected change:
- If the updated fact still represents a relevant constraint, preference, or goal → ask the user to confirm, then use update_memory on the next turn
- If the updated fact means the original is fully resolved and no longer relevant → ask the user to confirm, then use invalidate_memory on the next turn
- Follow the two-turn confirmation flow: ask first (no tool call), act after the user responds
- Weave the confirmation naturally into your response — e.g., "Got it — sounds like your shoulder has improved. Want me to update what I have on file?"
`;
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
