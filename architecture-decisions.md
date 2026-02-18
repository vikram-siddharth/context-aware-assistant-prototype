# Context Aware Assistant — Architecture Decision Record

This document captures key design decisions, tradeoffs, and reasoning as we build the Context Aware Assistant. It is updated as new decisions are made.

---

## Decision 1: Database Schema — Workouts Table (Phase 1)

**Context:** We needed to define the transactional domain state for workouts.

**Decision:** Keep the schema lean for the prototype:
- `id` (primary key)
- `type` (e.g., swimming, cycling)
- `duration` (in minutes)
- `date` (when the workout is scheduled)
- `description` (free text — captures location, equipment, notes, or anything else)
- `status` (scheduled / completed / cancelled)
- `created_at`
- `updated_at`

**Alternatives considered:** We initially considered dedicated columns for location, equipment needed, and individual vs. group. These are valid for a real product but add complexity to the LLM tool definitions without demonstrating additional architectural concepts.

**Tradeoff:** A free-text `description` field is less queryable than structured columns but much simpler for the LLM to populate correctly. For a prototype focused on architecture, this is the right call.

---

## Decision 2: Database Schema — Memories Table (Phase 1)

**Context:** We needed to define persistent memory storage for durable user facts.

**Decision:**
- `id` (primary key)
- `fact` (the raw extracted text)
- `category` (constraint / preference / goal)
- `persistence` (permanent / long_term / short_term — estimated by the LLM during extraction)
- `active` (boolean, default true — supports memory invalidation)
- `created_at`

**Alternatives considered:**
- *Expiry date estimation:* We discussed having the LLM estimate a rough expiry date (e.g., a knee injury might heal in months, a heart condition might be permanent). We also discussed having the assistant ask the user about persistence when a fact is first mentioned, or check if a condition still persists when it's retrieved near its estimated expiry. Deferred as a production enhancement (see Appendix).
- *Confidence scoring:* The spec mentions this as extra credit. Deferred for now.

**Tradeoff:** The `persistence` label is coarse but sufficient. In production, a richer model with dates and user confirmation would improve accuracy.

---

## Decision 3: Memory Deduplication Strategy (Phase 1)

**Context:** A user might mention the same fact multiple times across sessions (e.g., "I hurt my knee" then later "I have a knee injury from marathon training"). We need to avoid storing redundant memories.

**Decision:** Handle deduplication during extraction. When extracting memories from a new message, pass existing memories to the LLM and instruct it to extract only new facts not already captured. This handles extraction and deduplication in a single LLM call.

**Alternatives considered:**
- *Database-level deduplication:* Checking for duplicates at storage time sounds simpler, but semantic duplicates ("I hurt my knee" vs. "I have a knee injury") can't be caught with string matching. You'd need embedding similarity search, which adds infrastructure complexity.
- *Separate deduplication step:* A dedicated LLM call to check for overlaps after extraction. This works but doubles the LLM calls for memory processing.

**Tradeoff:** Combining extraction and deduplication in one prompt is efficient but makes the extraction prompt more complex. For a prototype with a single user and a manageable number of memories, this is practical. At scale, embedding-based deduplication would be more robust.

---

## Decision 4: Orchestrator Design (Phase 3)

**Context:** We needed to define how the Orchestrator processes messages, manages conversation history, and coordinates with agents.

**Decisions:**
- Memory extraction runs asynchronously on every message (non-blocking, background). Within a session, conversation history already provides the LLM with recent facts, so extraction doesn't need to complete before responding. Extraction matters for cross-session persistence.
- Conversation history is managed by the session controller and passed into the Orchestrator as a parameter. The Orchestrator is stateless — it processes whatever messages it receives.
- Memory retrieval happens synchronously before the LLM call so relevant memories can be included in the system prompt.
- The tool list includes only user-facing actions: create_workout, get_workouts, create_plan. Memory extraction is not exposed as a tool.

**Tradeoff:** Async extraction means a memory stored from message N won't be in the retrieval results until message N+1 at earliest. Within a session this is fine because conversation history covers it. Across sessions it's a non-issue since extraction will have completed long before the next session.

---

## Decision 5: Session Controller Timing (Phase 3)

**Context:** The session controller manages conversation history and SSE connections. It wasn't explicitly called out as a build step in our plan.

**Decision:** Build the session controller in two passes. Phase 3: a basic version that manages conversation history per session and passes it to the Orchestrator, with a simple JSON request/response endpoint for testing. Phase 5: enhance it with SSE streaming.

**Rationale:** Building a basic version early lets us test the Orchestrator with real conversation history. Deferring SSE avoids mixing concerns — we can verify the orchestration logic works before adding streaming complexity.

---

## Decision 6: SSE Event Design (Phase 5)

**Context:** We needed to define how the Orchestrator communicates its reasoning progress to the frontend.

**Decisions:**
- Four event types: thinking, action, result, error. Each carries a human-readable content string.
- The Orchestrator translates internal operations (tool calls, memory retrieval) into these events. No internal details leak to the frontend.
- The final LLM response is sent as a single complete result event, not streamed word-by-word.
- A small artificial delay is added between rapid events so reasoning steps feel deliberate.

**Tradeoff:** Sending the complete response is simpler but may feel slow if the LLM takes time. Word-by-word streaming would improve perceived latency. Noted as a production enhancement (see Appendix).

---

## Decision 7: Memory Invalidation — Orchestrator-Driven with User Confirmation (Phase 6)

**Context:** The memory system could add facts but never retire them. Outdated constraints continued to influence recommendations across sessions.

**Initial approach:** Memory invalidation at extraction time — the extraction LLM would detect conflicts with existing memories and flag them for retirement.

**Root cause of failure:** The extraction LLM only sees the raw message, not conversation context. If it missed the conflict, the Orchestrator never knew to ask about memory retirement — even though it could plainly see the contradiction between the retrieved constraint and the user's message.

**Revised decision — Orchestrator-driven invalidation via tool:**

1. **`invalidate_memory` tool** — The Orchestrator LLM can now directly retire outdated memories when it notices a contradiction. This is far more reliable because the Orchestrator has full context: retrieved memories, conversation history, and the user's message.

2. **Memory IDs in system prompt** — Each memory now shows its ID so the LLM can reference it in tool calls.

3. **Inference-based updates with confirmation** — The Orchestrator may propose memory changes based on both explicit statements and reasonable inferences. For example, if a user with a stored knee injury says "I went for a 5k run last weekend," the Orchestrator should infer the injury may have healed and ask the user to confirm. The user confirmation step is the primary safeguard — it doesn't matter whether the trigger was explicit or inferred, because the user approves before any change is made.

4. **User confirmation flow** — When the Orchestrator detects a potential memory change, it asks the user to confirm, phrased forward-looking (e.g., "Can I update my notes to reflect that your shoulder is no longer dislocated?"). If the user confirms, the change is made. If the user doesn't respond, the Orchestrator may proceed based on its best judgment but must inform the user of its decision.

5. **Removed `resolveConflictsAsync`/`resolveConflict`** — The fire-and-forget LLM classification is no longer needed. The Orchestrator handles everything within its normal agentic loop.

The extraction LLM's conflict detection still exists in `memory-agent.ts` but is supplementary. The Orchestrator tool is the reliable path.

**Evolution of this decision:** We initially restricted the Orchestrator to only act on explicit user statements, not inferences. This was an overcorrection in response to a false invalidation bug (a swimming preference was deleted without cause). We later recognized that a real assistant should make reasonable inferences — the confirmation step provides sufficient safety regardless of whether the trigger is explicit or inferred.

---

## Decision 8: Unified Memory Lifecycle in Orchestrator (Phase 6)

**Context:** Deduplication (handled in extraction) and conflict resolution (handled in the Orchestrator) are conceptually similar. Edge cases exist where the extraction LLM might treat an evolved fact as a duplicate and skip it, when it should update the existing memory. Example: "broken ankle" → "swollen ankle" — same underlying fact, but the user identifies with the most recent articulation.

**Decision:** Add an `update_memory` tool to the Orchestrator alongside `invalidate_memory`. The Orchestrator now manages the full memory lifecycle: invalidation (for contradicted facts) and updates (for evolved facts). The extraction agent continues to handle brand new facts that don't relate to any existing memory. If something overlaps with or refines an existing memory, the extraction agent skips it — that's the Orchestrator's job.

The Orchestrator recognizes three categories of memory changes:
- **Contradictions** — the fact is no longer true (e.g., "my wound has healed")
- **Refinements** — more specific information about the same fact (e.g., "my shoulder is dislocated" when the stored memory says "has a shoulder injury")
- **Evolution** — the condition has changed (e.g., "my shoulder is sore but no longer dislocated")

**Same-session elaboration fix:** A gap was discovered where a user elaborates on a fact within the same session (e.g., "I have a shoulder injury" then "my shoulder is dislocated"). The extraction agent skipped it as overlapping, and the Orchestrator didn't trigger an update because it didn't look like a contradiction. The fix: the Orchestrator proactively checks whether new details in the conversation refine an existing memory and uses `update_memory` to capture the more detailed version.

**Tradeoff:** This gives the Orchestrator more responsibility, but it's the only component with enough context (memories + conversation history + user message) to make these judgment calls reliably.

---

## Decision 9: Session-Level Memory Retrieval with Contextual Display (Phase 6)

**Context:** Memory retrieval was happening per message, causing the "Checking if I remember anything relevant" thinking event to appear on every turn. This was repetitive and unnatural. Additionally, per-message retrieval was unnecessary in a fitness context where all physical constraints are always relevant.

**Decision:** Load all active memories once when the first message of a session arrives. Include them in the system prompt for every subsequent message in that session. However, do not list all memories in the chat at session start. Only surface a memory in a thinking event when it actively influences a specific decision — for example, "Keeping in mind your knee injury, I'll avoid high-impact exercises."

**Rationale:** A human trainer mentally reviews what they know about a client before a session, but doesn't recite the client's entire file out loud. They mention relevant facts only when making a specific recommendation. This mirrors that pattern and produces a more natural conversational flow. The memory inspection UI (planned enhancement) provides a dedicated place for users to review all stored memories.

**Evolution of this decision:** Initially we listed all memories at session start. This felt mechanical — especially as the number of memories grew. The shift to contextual display means the LLM has full access to all memories (they're in the system prompt) but only narrates the ones that matter for the current interaction.

---

## Decision 10: Remove Per-Message Relevance Scoring (Phase 6)

**Context:** The Memory Agent contained relevance scoring logic — an LLM call that scored each memory from 0-10 against the current user query and filtered to only relevant ones. This was built for the original per-message retrieval design.

**Decision:** Remove the relevance scoring code from the Memory Agent. With session-level retrieval of all active memories (Decision 9), every active memory is loaded into the system prompt at session start. Per-message relevance scoring is dead code — it adds an unnecessary LLM call that is never reached.

**Rationale:** The domain-specific nature of the assistant (fitness) means all user facts are potentially relevant to any interaction. The LLM, with all memories in its system prompt, is better positioned to decide which memories to surface in context than a separate scoring step.

**When to reintroduce:** If the system expanded to multiple domains or a user accumulated hundreds of memories, relevance scoring (preferably embedding-based for efficiency) would be needed to select the right subset for the context window. Noted in the production enhancements appendix.

---

## Appendix: Production Enhancements (Deferred)

These enhancements were discussed during development and deemed valuable for production but out of scope for the prototype:

1. **Persistence-based memory expiry:** Estimate a rough expiry date for each memory at extraction time (via LLM judgment or user input). Near expiry, proactively ask the user if the fact is still relevant. Would require careful UX design to avoid feeling intrusive, and interacts with the existing confirmation flow.

2. **Word-by-word response streaming:** Stream the final LLM response token-by-token rather than as a single complete event. Improves perceived latency for longer responses.

3. **Memory confidence scoring:** Assign and display a confidence level for each extracted memory. Mentioned in the spec as extra credit.

4. **Memory inspection UI:** A panel where the user can view and manage their stored memories directly.

5. **Personality-aware reasoning tone:** Let the user choose a personality style and have the reasoning steps adapt accordingly.

6. **Embedding-based memory retrieval:** Replace LLM-based relevance scoring with vector similarity search for faster, more scalable memory retrieval.

7. **User confirmation for domain actions:** Currently, the Planning Agent designs a workout and the Task Agent writes it to the database without user approval. In higher-stakes domains (financial transactions, medical recommendations, bookings), you'd want a confirmation step between planning and execution — the same pattern we built for memory invalidation. The Orchestrator would present the proposed action, wait for user approval, and only then delegate to the Task Agent. For the workout domain this is low-risk, but the architecture should support it.

8. **Transaction handling for tool execution:** The Orchestrator's tool execution loop is not wrapped in a database transaction. If the loop calls multiple tools and one fails partway through, earlier writes are not rolled back. For the workout domain the consequence is minor (a duplicate workout at worst), but in higher-stakes domains (financial transactions, multi-step bookings), you'd want the entire tool execution sequence to be atomic — all operations succeed or all are rolled back.

9. **Dynamic tool registration by agents:** Currently, the Orchestrator's `executeTool` function is a manual routing table — a switch/if-else that maps each tool name to the correct agent. This grows linearly with the number of tools. A more scalable pattern would have each agent register the tools it handles, so the Orchestrator looks up the responsible agent automatically. Adding a new tool would only require changes in the relevant agent, not in the Orchestrator.

---

*— End of document —*
