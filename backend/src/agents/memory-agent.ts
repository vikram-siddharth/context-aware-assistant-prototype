import { Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { Memory, MemoryCategory, MemoryPersistence } from '../entities/Memory';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export interface ExtractionResult {
  newMemories: Memory[];
}

// Schema for extracted memories
const ExtractedMemoriesSchema = z.object({
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
});

// Schema for relevance scoring
const RelevanceScoreSchema = z.object({
  relevantMemories: z.array(
    z.object({
      memoryId: z.string(),
      relevanceScore: z.number().min(0).max(10).describe('0-10 score indicating relevance'),
      reason: z.string().optional().describe('Why this memory is relevant'),
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
        .map((m) => `- ${m.fact} (${m.category}, ${m.persistence})`)
        .join('\n');

      const systemPrompt = `You are a memory extraction agent. Your job is to identify genuinely NEW durable user facts from the user's message that should be remembered across sessions.

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

EXISTING MEMORIES (do NOT extract anything related to these):
${existingFactsList || '(none)'}

FACT FORMAT:
- Store each fact as a simple second-person statement about the user.
- Examples: "Has a dislocated shoulder", "Likes swimming", "Prefers Friday for workouts", "Wants to run a marathon"
- Never use "the user" or "an user" — just state the fact directly as if describing the person.

CONTEXT-DEPENDENT STATEMENTS — DO NOT EXTRACT:
- If a statement is clearly an answer to a specific question in the conversation (e.g., "Friday is best" in response to "What day works for you this week?"), it is a one-time scheduling decision, NOT a durable fact.
- Only extract facts that would still be true and relevant weeks or months from now.
- Ask yourself: "If I recalled this fact in a completely different conversation weeks later, would it still be useful?" If not, skip it.
- Examples of what NOT to extract:
  - "Friday" in response to "When should we schedule this?" (one-time answer)
  - "30 minutes" in response to "How long do you want today's workout?" (single-session choice)
  - "Let's do legs" in response to "What should we focus on today?" (today's choice, not a lasting preference)
- Examples of what TO extract:
  - "I always prefer working out on Fridays" (enduring preference)
  - "I usually do 30-minute sessions" (habitual pattern)
  - "I hate leg day" (lasting preference)

CRITICAL RULES:
- If the user's message overlaps with, refines, updates, or contradicts an existing memory, DO NOT extract it. That is handled elsewhere.
- Only extract facts that are completely independent from every existing memory.
- If nothing genuinely new is present, return an empty array.
- When in doubt, do not extract.`;

      const result = await generateObject({
        model: this.model,
        schema: ExtractedMemoriesSchema,
        system: systemPrompt,
        prompt: `User message: "${message}"\n\nExtract only genuinely new facts that are unrelated to any existing memory.`,
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

      return { newMemories: savedMemories };
    } catch (error) {
      console.error('[MemoryAgent] Error in extractMemories:', error);
      return { newMemories: [] };
    }
  }

  /**
   * Retrieve memories relevant to a given query
   * Returns memories sorted by relevance (most relevant first)
   */
  async retrieveRelevantMemories(query: string): Promise<Memory[]> {
    try {
      // Fetch all active memories
      const allMemories = await this.memoryRepository.find({
        where: { active: true },
        order: { created_at: 'DESC' },
      });

      // If no memories exist, return empty array
      if (allMemories.length === 0) {
        return [];
      }

      // Build memory list for the LLM
      const memoryList = allMemories
        .map((m) => `ID: ${m.id}\nFact: ${m.fact}\nCategory: ${m.category}\nPersistence: ${m.persistence}`)
        .join('\n\n');

      // Call Claude to score relevance
      const systemPrompt = `You are a memory relevance scorer. Given a user query and a list of stored memories, determine which memories are relevant to the query.

Score each memory from 0-10 based on relevance:
- 10: Directly addresses the query or is a critical constraint
- 7-9: Highly relevant, would influence the response
- 4-6: Moderately relevant, provides useful context
- 1-3: Tangentially related
- 0: Not relevant

Return ONLY memories with a score >= 5.`;

      const result = await generateObject({
        model: this.model,
        schema: RelevanceScoreSchema,
        system: systemPrompt,
        prompt: `Query: "${query}"\n\nMemories:\n${memoryList}\n\nScore the relevance of each memory to this query.`,
      });

      // Map memory IDs to actual Memory objects and sort by relevance
      const relevantMemoriesData = result.object.relevantMemories || [];

      const relevantMemories = relevantMemoriesData
        .map((item) => {
          const memory = allMemories.find((m) => m.id === item.memoryId);
          return memory ? { memory, score: item.relevanceScore } : null;
        })
        .filter((item): item is { memory: Memory; score: number } => item !== null)
        .sort((a, b) => b.score - a.score) // Sort by score descending
        .map((item) => item.memory);

      console.log(`[MemoryAgent] Retrieved ${relevantMemories.length} relevant memories for query`);
      return relevantMemories;
    } catch (error) {
      console.error('[MemoryAgent] Error in retrieveRelevantMemories:', error);
      // Return empty array on error - retrieval is best-effort
      return [];
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
