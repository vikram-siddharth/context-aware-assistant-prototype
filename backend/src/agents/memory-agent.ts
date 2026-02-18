import { Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Memory, MemoryCategory, MemoryPersistence } from '../entities/Memory';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import dotenv from 'dotenv';

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
      persistence: z.enum(['permanent', 'long_term', 'short_term']).describe(
        'permanent: indefinite (e.g., chronic condition), long_term: months/years, short_term: weeks'
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

export class MemoryAgent {
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
- permanent: Indefinite facts (chronic conditions, allergies, fundamental traits)
- long_term: Months to years (fitness goals, ongoing preferences)
- short_term: Weeks (temporary restrictions, short-term objectives)

FACT FORMAT:
- Store each fact as a second-person verb phrase (as if completing "You ...").
- Examples: "have a dislocated shoulder", "like swimming", "prefer Friday for workouts", "want to run a marathon"
- Always use second-person verb forms (have, like, prefer, want, enjoy, need, are) — never third-person (has, likes, prefers, wants, enjoys, needs, is).
- Never use "the user" or "an user" — just state the fact directly as a second-person phrase.

CONTEXT-DEPENDENT STATEMENTS — DO NOT EXTRACT:
- If a statement is clearly an answer to a specific question in the conversation (e.g., "Friday is best" in response to "What day works for you this week?"), it is a one-time scheduling decision, NOT a durable fact.
- Distinguish between context-specific desires and durable preferences. A conditional or request-style statement ("I would like to swim", "I'd like to do yoga", "Can we do cardio?") in response to a prompt like "How can I help you?" is a one-time intent for this session — NOT a lasting preference. A general statement about enjoyment or habit ("I like to swim", "I enjoy yoga", "I do cardio three times a week") IS a durable fact.
- Only extract facts that would still be true and relevant weeks or months from now.
- Ask yourself: "If I recalled this fact in a completely different conversation weeks later, would it still be useful?" If not, skip it.
- Examples of what NOT to extract:
  - "Friday" in response to "When should we schedule this?" (one-time answer)
  - "30 minutes" in response to "How long do you want today's workout?" (single-session choice)
  - "Let's do legs" in response to "What should we focus on today?" (today's choice, not a lasting preference)
  - "I would like to swim" in response to "How can I help you?" (context-specific desire, not a durable preference)
  - "I'd like a strength workout" in response to "What are you looking for today?" (session intent, not a lasting preference)
- Examples of what TO extract:
  - "I always prefer working out on Fridays" (enduring preference)
  - "I usually do 30-minute sessions" (habitual pattern)
  - "I hate leg day" (lasting preference)
  - "I like to swim" (general enjoyment — durable preference)
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
