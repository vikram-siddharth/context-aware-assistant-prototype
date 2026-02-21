import { Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Memory, MemoryCategory, MemoryPersistence } from '../entities/Memory';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import dotenv from 'dotenv';
import { ToolProvider, ToolDefinition } from './tool-provider';

dotenv.config();

export interface MemoryRefinement {
  existingMemoryId: string;
  existingFact: string;
  suggestedUpdate: string;
  reason: string;
}

export interface ExtractionResult {
  newMemories: Memory[];
  refinements: MemoryRefinement[];
}

// Schema for extracted memories and detected refinements
const ExtractionSchema = z.object({
  memories: z.array(
    z.object({
      fact: z.string().describe('The durable user fact to remember'),
      category: z.enum(['constraint', 'preference', 'goal']).describe(
        'constraint: hard requirements (e.g., injury, allergy), preference: soft choices (e.g., likes/dislikes), goal: objectives to work toward'
      ),
      persistence: z.enum(['permanent', 'temporary']).describe(
        'permanent: indefinite (e.g., chronic condition, stable trait), temporary: has a natural endpoint (e.g., injury, time-bound goal)'
      ),
    })
  ),
  refinements: z.array(
    z.object({
      existingMemoryId: z.string().describe('The ID of the existing memory being refined'),
      existingFact: z.string().describe('The current text of the existing memory'),
      suggestedUpdate: z.string().describe('The more specific or evolved version of the fact, as a second-person verb phrase'),
      reason: z.string().describe('Brief reason: "more specific", "condition evolved", etc.'),
    })
  ),
});

export class MemoryAgent implements ToolProvider {
  private memoryRepository: Repository<Memory>;
  private model: any;

  constructor() {
    this.memoryRepository = AppDataSource.getRepository(Memory);

    // Initialize Anthropic model
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not found in environment variables');
    }

    this.model = anthropic('claude-sonnet-4-20250514');
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'update_memory',
        description:
          'Update an existing memory when the user provides new information that refines or evolves a stored fact — without fully contradicting it. For example, "has a broken ankle" evolving to "has a swollen ankle", or "runs 3 times a week" changing to "runs 5 times a week". Always inform the user when you do this.',
        inputSchema: {
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
        actionDescription: 'Updating my notes...',
        execute: async (input: { memoryId: string; newFact: string; reason: string }) => {
          const updated = await this.updateMemoryFact(input.memoryId, input.newFact);
          return {
            success: updated,
            message: updated
              ? `Memory updated successfully: ${input.reason}`
              : 'Memory not found or could not be updated',
          };
        },
      },
      {
        name: 'set_memory_expiry',
        description:
          'Set or update the estimated expiry date for a memory that has a natural endpoint (injuries heal, projects end, races have a date). Call this after the user provides a timeframe or when estimating a reasonable expiry for a fact with a natural endpoint.',
        inputSchema: {
          type: 'object',
          properties: {
            memoryId: {
              type: 'string',
              description: 'The ID of the memory to set expiry for (from the User Context section)',
            },
            date: {
              type: 'string',
              description: 'The estimated expiry date in YYYY-MM-DD format',
            },
          },
          required: ['memoryId', 'date'],
        },
        actionDescription: 'Updating my notes...',
        execute: async (input: { memoryId: string; date: string }) => {
          const expiryDate = new Date(input.date);
          if (isNaN(expiryDate.getTime())) {
            return { success: false, message: 'Invalid date format. Use YYYY-MM-DD.' };
          }
          const updated = await this.setMemoryExpiry(input.memoryId, expiryDate);
          return {
            success: updated,
            message: updated
              ? `Memory expiry set to ${input.date}`
              : 'Memory not found or could not be updated',
          };
        },
      },
      {
        name: 'invalidate_memory',
        description:
          'Retire an outdated memory when the user indicates a previously stored fact is no longer true. For example, if the user said they had a knee injury but now says it has healed, use this tool to retire the old constraint. Always inform the user when you do this.',
        inputSchema: {
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
        actionDescription: 'Updating my notes...',
        execute: async (input: { memoryId: string; reason: string }) => {
          const invalidated = await this.invalidateMemory(input.memoryId);
          return {
            success: invalidated,
            message: invalidated
              ? `Memory retired successfully: ${input.reason}`
              : 'Memory not found or already retired',
          };
        },
      },
    ];
  }

  /**
   * Extract genuinely new memories from a user message.
   * Only extracts facts that do not relate to any existing active memory.
   * Overlaps, refinements, and contradictions are skipped — those are
   * handled by the Orchestrator via update_memory / invalidate_memory.
   * This function never throws — all errors are caught and logged.
   */
  async extractMemories(message: string): Promise<ExtractionResult> {
    try {
      // Fetch all existing active memories for deduplication
      const existingMemories = await this.memoryRepository.find({
        where: { active: true },
        order: { created_at: 'DESC' },
      });

      const existingFactsList = existingMemories
        .map((m) => `- (ID: ${m.id}) ${m.fact} [${m.category}, ${m.persistence}]`)
        .join('\n');

      const systemPrompt = `You are a memory extraction agent. You have two jobs:
1. Extract genuinely NEW durable user facts from the user's message.
2. Detect REFINEMENTS — cases where the user's message provides more specific, detailed, or evolved information about an existing memory.

## Job 1: New Fact Extraction

ONLY extract facts that are:
- Durable (likely to remain true across sessions)
- Actionable (will influence future behavior or constraints)
- Personal to the user (not general knowledge)
- Genuinely NEW — not related to any existing memory listed below

Categories:
- constraint: Hard requirements or limitations (injuries, allergies, medical conditions, strict rules)
- preference: Soft choices or likes/dislikes (favorite exercises, preferred times, tastes)
- goal: Objectives or targets the user is working toward

Persistence levels:
- permanent: Indefinite facts (chronic conditions, allergies, fundamental traits, stable preferences)
- temporary: Facts with a natural endpoint (injuries, time-bound goals, temporary restrictions)

FACT FORMAT:
- Store each fact as a second-person verb phrase (as if completing "You ...").
- Examples: "have a dislocated shoulder", "like swimming", "prefer Friday for workouts", "want to run a marathon"
- Always use second-person verb forms (have, like, prefer, want, enjoy, need, are) — never third-person (has, likes, prefers, wants, enjoys, needs, is).
- Never use "the user" or "an user" — just state the fact directly as a second-person phrase.

SESSION INTENT vs. DURABLE FACTS — CRITICAL DISTINCTION:

Distinguish between session intent and durable facts by their linguistic form, regardless of where they appear in the conversation:

- **Session intent (DO NOT extract):** Conditional, volitional, or request phrasing that expresses what the user wants to do now — "I'd like to swim", "I'd love to swim", "I would like to do yoga", "I want a strength workout", "Can we do cardio?", "Let's focus on legs"
- **Durable fact (DO extract):** General statements about enjoyment, habit, or ongoing taste — "I like swimming", "I love swimming", "I enjoy yoga", "I do cardio three times a week", "I hate leg day"

The key test: "I'd like/love to X" (conditional mood → session intent) vs. "I like/love X" or "I like/love to X" as a general statement (indicative mood → durable fact). The contraction "I'd" = "I would" — it signals a wish for this session, not an enduring trait.

Context-specific answers are also session intent — DO NOT extract:
  - "Friday" in response to "When should we schedule this?" (one-time answer)
  - "30 minutes" in response to "How long do you want today's workout?" (single-session choice)

Only extract facts that would still be true and relevant weeks or months from now.
Ask yourself: "If I recalled this fact in a completely different conversation weeks later, would it still be useful?" If not, skip it.

Examples of what NOT to extract:
  - "I'd like to swim" (session intent — conditional "I would like")
  - "I'd love to swim" (session intent — conditional "I would love")
  - "I want a 30-minute workout today" (single-session choice)
  - "Let's do legs" (today's choice, not a lasting preference)
  - "Can we do cardio?" (request for this session)
- Examples of what TO extract:
  - "I like swimming" / "I like to swim" (general enjoyment — durable preference)
  - "I love swimming" (general enjoyment — durable preference)
  - "I always prefer working out on Fridays" (enduring preference)
  - "I usually do 30-minute sessions" (habitual pattern)
  - "I hate leg day" (lasting preference)
  - "I enjoy morning runs" (habitual pattern — durable preference)

## Job 2: Refinement Detection

Check whether the user's message provides more specific or evolved information about any existing memory. If so, report it as a refinement.

Types of refinement:
- **More specific**: "have a shoulder injury" → user says "my shoulder is dislocated" → suggest "have a dislocated shoulder"
- **Evolved condition**: "have a broken ankle" → user says "my ankle is mostly healed, just stiff" → suggest "have a stiff ankle (recovering from break)"
- **Updated detail**: "run 3 times a week" → user says "I've been running 5 times a week" → suggest "run 5 times a week"

Refinement rules:
- Use the existing memory's ID from the list below.
- Write the suggestedUpdate in the same format as existing facts (second-person verb phrase).
- Only report refinements where the user's message genuinely adds specificity or reflects a change. Do not report refinements for unrelated statements.
- Contradictions (fact is no longer true at all) are NOT refinements — skip those, they are handled elsewhere.

EXISTING MEMORIES (reference by ID for refinements; do NOT extract new facts related to these):
${existingFactsList || '(none)'}

## Output Rules
- If nothing genuinely new is present, return an empty memories array.
- If no refinements are detected, return an empty refinements array.
- When in doubt about a new fact, do not extract.
- When in doubt about a refinement, do not report it.`;

      const result = await generateObject({
        model: this.model,
        schema: ExtractionSchema,
        system: systemPrompt,
        prompt: `User message: "${message}"\n\nExtract new facts and detect any refinements to existing memories.`,
      });

      // Save new memories to database
      const savedMemories: Memory[] = [];
      if (result.object.memories && result.object.memories.length > 0) {
        for (const memoryData of result.object.memories) {
          const memory = this.memoryRepository.create({
            fact: memoryData.fact,
            category: memoryData.category as MemoryCategory,
            persistence: memoryData.persistence as MemoryPersistence,
          });

          const saved = await this.memoryRepository.save(memory);
          savedMemories.push(saved);
          console.log(`[MemoryAgent] Extracted new memory: ${memoryData.fact}`);
        }
      } else {
        console.log('[MemoryAgent] No new memories extracted from message');
      }

      // Collect refinements
      const refinements: MemoryRefinement[] = (result.object.refinements || []).map((r) => ({
        existingMemoryId: r.existingMemoryId,
        existingFact: r.existingFact,
        suggestedUpdate: r.suggestedUpdate,
        reason: r.reason,
      }));

      if (refinements.length > 0) {
        console.log(`[MemoryAgent] Detected ${refinements.length} refinement(s)`);
      }

      return { newMemories: savedMemories, refinements };
    } catch (error) {
      console.error('[MemoryAgent] Error in extractMemories:', error);
      return { newMemories: [], refinements: [] };
    }
  }

  /**
   * Get all memories (utility method)
   */
  async getAllMemories(): Promise<Memory[]> {
    try {
      return await this.memoryRepository.find({
        where: { active: true },
        order: { created_at: 'DESC' },
      });
    } catch (error) {
      console.error('[MemoryAgent] Error in getAllMemories:', error);
      return [];
    }
  }

  /**
   * Delete a memory by ID (utility method)
   */
  async deleteMemory(id: string): Promise<boolean> {
    try {
      const result = await this.memoryRepository.delete(id);
      return (result.affected ?? 0) > 0;
    } catch (error) {
      console.error('[MemoryAgent] Error in deleteMemory:', error);
      return false;
    }
  }

  /**
   * Update a memory's fact text.
   * Used when the user refines or evolves an existing fact (e.g., "broken ankle" → "swollen ankle").
   */
  async updateMemoryFact(id: string, newFact: string): Promise<boolean> {
    try {
      const result = await this.memoryRepository.update(id, { fact: newFact });
      const success = (result.affected ?? 0) > 0;
      if (success) {
        console.log(`[MemoryAgent] Updated memory ${id}: ${newFact}`);
      }
      return success;
    } catch (error) {
      console.error('[MemoryAgent] Error in updateMemoryFact:', error);
      return false;
    }
  }

  /**
   * Set or update the estimated expiry date for a memory.
   * Used for facts with natural endpoints (injuries, goals with dates, temporary preferences).
   */
  async setMemoryExpiry(id: string, expiryDate: Date): Promise<boolean> {
    try {
      const result = await this.memoryRepository.update(id, { estimated_expiry: expiryDate });
      const success = (result.affected ?? 0) > 0;
      if (success) {
        console.log(`[MemoryAgent] Set expiry for memory ${id}: ${expiryDate.toISOString().split('T')[0]}`);
      }
      return success;
    } catch (error) {
      console.error('[MemoryAgent] Error in setMemoryExpiry:', error);
      return false;
    }
  }

  /**
   * Invalidate a memory by setting active = false.
   * The memory stays in the database for history purposes.
   */
  async invalidateMemory(id: string): Promise<boolean> {
    try {
      const result = await this.memoryRepository.update(id, { active: false });
      const success = (result.affected ?? 0) > 0;
      if (success) {
        console.log(`[MemoryAgent] Invalidated memory: ${id}`);
      }
      return success;
    } catch (error) {
      console.error('[MemoryAgent] Error in invalidateMemory:', error);
      return false;
    }
  }
}

// Export a singleton instance
export const memoryAgent = new MemoryAgent();
