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
- `persistence` (permanent / temporary — estimated by the LLM during extraction)
- `active` (boolean, default true — supports memory invalidation)
- `created_at`

**Alternatives considered:**
- *Expiry date estimation:* We discussed having the LLM estimate a rough expiry date (e.g., a knee injury might heal in months, a heart condition might be permanent). We also discussed having the assistant ask the user about persistence when a fact is first mentioned, or check if a condition still persists when it's retrieved near its estimated expiry. Deferred as a production enhancement (see Appendix).
- *Confidence scoring:* The spec mentions this as extra credit. Deferred for now.

**Tradeoff:** The `persistence` label is a binary signal (permanent vs. temporary) used to trigger the expiry-setting flow for non-permanent memories. The `estimated_expiry` date (Decision 14) is the actual source of truth for temporality.

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

4. **User confirmation flow** — When the Orchestrator detects a potential memory change, it asks the user to confirm, phrased forward-looking (e.g., "Can I update my notes to reflect that your shoulder is no longer dislocated?"). If the user confirms, the change is made. If the user doesn't respond, the Orchestrator may proceed based on its best judgment but must inform the user of its decision. A structural guardrail (same pattern as Decision 11) blocks `invalidate_memory` and `update_memory` from executing in the same turn as the ask, preventing the tool from firing before the user has a chance to respond.

5. **Invalidation vs. update** — If a fact evolves to a state where it no longer constrains behavior (e.g., "wound has healed"), that's an invalidation, not an update. A healed injury is not an updated injury — it's a resolved one. `update_memory` is reserved for cases where the fact still applies but the details have changed (e.g., "shoulder injury" → "shoulder is sore but improving").

6. **Removed `resolveConflictsAsync`/`resolveConflict`** — The fire-and-forget LLM classification is no longer needed. The Orchestrator handles everything within its normal agentic loop.

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

## Decision 11: User Confirmation for Domain Actions (Enhancement)

**Context:** Two problems with the current plan-and-execute flow:

1. **UX:** The Task Agent writes to Postgres before the user has seen the plan. The reasoning stream shows "Creating your plan..." before the assistant describes it.
2. **Data fidelity:** The Planning Agent generates detailed plans that accommodate constraints (e.g., "backstroke focus, low kick intensity to protect knee"), but the Orchestrator LLM re-interprets those details when calling `create_workout` and may drop specifics. The stored workout becomes a lossy summary of what was actually planned.

**Decision:** Split plan-and-execute into two turns with a new `confirm_proposal` tool.

- `create_plan` executes as before, but the Orchestrator stashes the structured output in session state as `pendingProposal` instead of immediately writing. The Planning Agent's output matches `create_workout`'s parameter shape so it can flow directly to the Task Agent without LLM re-interpretation.
- The LLM presents the plan and asks for confirmation.
- On the next turn, if the user approves, the LLM calls `confirm_proposal` (no arguments). The Orchestrator passes the stashed plan directly to the Task Agent — the LLM never specifies workout parameters on the confirmation turn.
- If the user requests changes, `create_plan` runs again and replaces the pending proposal. If the user changes topic, the proposal is abandoned.
- A guardrail in `executeTool` blocks `create_workout` from executing in the same turn as `create_plan`, catching cases where the LLM ignores the system prompt.

**Scope:** All domain writes (creates, updates, deletes) require user confirmation. Reads (`get_workouts`) do not. All workout creation goes through `create_plan` → `confirm_proposal`. `create_workout` is no longer a tool the LLM can call directly — it is only called internally by `confirm_proposal`.

**Pending proposal storage:** Session state (in-memory, alongside conversation history). Same lifecycle as ephemeral state — cleared on New Chat. This is correct because workout plans are designed within a single session.

**Unlike memory invalidation (Decision 7), domain actions are never written without confirmation.** A missed memory update is low-cost and recoverable. An unwanted workout record is visible in the UI and harder to undo.

**Alternatives considered:**
- *Postgres with `pending` status:* Write immediately, flip to `scheduled` on confirmation. Introduces write-before-approval, which is the problem we're solving.
- *Serialize the plan in conversation history:* Round-tripping structured data through natural language risks the same lossy re-interpretation.

**Tradeoff:** The two-turn flow adds a round trip to every planning interaction, but workout planning is inherently conversational — the user benefits from reviewing the plan.

---

## Decision 12: Dynamic Tool Registration by Agents (Enhancement)

**Context:** The Orchestrator's `executeTool` function is a manual routing table that maps each tool name to the correct agent. This grows linearly with the number of tools and requires changes to the Orchestrator whenever a tool is added to any agent.

**Decision:** Each agent implements a `getTools()` method that returns its tool definitions (Zod schema, description, execute function). At startup, the Orchestrator pulls tools from all agents and builds a unified registry. Adding a new tool only requires changes in the relevant agent.

- **Pull model:** The Orchestrator calls `getTools()` on each agent, rather than agents pushing registrations. This keeps initialization order clear and collision detection simple.
- **Collision detection:** If two agents register the same tool name, the system fails at startup with a clear error.
- **`confirm_proposal` ownership:** Registered by the Task Agent, since it ultimately writes a workout. The Task Agent's execute function expects workout parameters as input (effectively an alias for `createWorkout`). The Orchestrator wraps the call — it reads `pendingProposal` from session state, passes it as the argument, and clears the proposal after a successful write. This preserves the Task Agent's purity (no session state knowledge) while keeping tool ownership logical.

**Alternatives considered:**
- *Push model (agents register themselves):* Introduces timing questions about when all agents have finished registering. Useful for plugin systems, unnecessary for a fixed set of agents.
- *External registry/config file:* Same problem as the current switch/case — a separate file to update when tools change.

**Tradeoff:** The pull model requires the Orchestrator to hold references to all agents, but it already does. The wrapping pattern for `confirm_proposal` splits coordination (Orchestrator) from execution (Task Agent), which is slightly indirect but preserves clean boundaries.

---

## Decision 13: Memory Inspection UI (Enhancement)

**Context:** Users have no way to see what the system remembers about them. Memories are only visible when the Orchestrator surfaces them in reasoning events during conversation.

**Decision:** Add a read-only panel that displays all active memories with their metadata (fact, category, expiry date, created date). Inactive memories are excluded — the panel answers "what does the system remember about me right now," not "what has the system ever known." No edit, delete, or deactivate controls — all memory changes are handled conversationally through the Orchestrator (invalidation via Decision 7, updates via Decision 8).

- **Backend:** A single `GET /api/memories` endpoint that returns active memories. This bypasses the Orchestrator — it's direct read access to the memories table.
- **Frontend:** A panel accessible from the chat interface (sidebar, modal, or toggle — implementation detail).
- **No cache staleness concern:** Since the panel is read-only, it cannot put the Orchestrator's session-level memory cache (Decision 9) out of sync.

**Alternatives considered:**
- *Editable panel with deactivate/edit controls:* Creates a second path for memory changes that bypasses the Orchestrator's judgment. Introduces cache staleness (panel changes vs. Orchestrator's cached memories) and edge cases like user edits contradicting existing memories.

**Tradeoff:** A read-only panel is less powerful but consistent with the system's design — the Orchestrator is the single authority for memory lifecycle decisions.

---

## Decision 14: Persistence-Based Memory Expiry (Enhancement)

**Context:** Memories have a `persistence` label (permanent / temporary) but no mechanism for expiry. Outdated facts remain active indefinitely unless the user explicitly contradicts them in conversation.

**Decision:** Add an `estimated_expiry` date (nullable) to the memories table and a `set_memory_expiry` tool (registered by the Memory Agent). Permanent memories get null expiry. For memories with a shelf life, the Orchestrator estimates expiry conversationally.

**Shelf-life determination:** When a new fact is mentioned, the Orchestrator determines whether it has a natural endpoint (injuries heal, projects end, races have a date). If the fact is likely indefinite (preferences, abilities, stable conditions), expiry stays null. This is a binary judgment, not a confidence score.

**Estimation approach:** For facts with a natural endpoint, the Orchestrator asks the user once, at a natural point in conversation — not as an interruption. The phrasing adapts to the category:

- **Goals:** Ask for a specific date ("When is the race?")
- **Preferences:** Ask for a window ("How long will the project keep you busy?")
- **Constraints:** Ask for whatever the user knows ("Do you have a sense of how long recovery might take?"), then the LLM estimates from that

**Fallback:** If the user ignores the question or gives an unhelpful answer, the Orchestrator does not ask again. It estimates a reasonable expiry on its own using the fact text, category, and conversation context, and calls `set_memory_expiry` with its best guess. The LLM always sets an expiry for facts with natural endpoints — the conversational ask is an attempt to get better data, not a prerequisite.

**User-initiated expiry updates:** If the user mentions a change to a timeframe ("the race is in May, not April" or "my recovery is taking longer than expected"), the Orchestrator uses `set_memory_expiry` to update it. No special flow — handled like any other conversational memory change.

**Extraction is unchanged.** Memory extraction still runs asynchronously in the background. Expiry estimation is a separate conversational step in the Orchestrator's normal flow. The extraction may write the memory with a null expiry, which the Orchestrator fills in after the user answers or via the fallback estimate.

**Check-in behavior:** At session start, memories that are expired or expiring within two weeks are noted in the system prompt. The Orchestrator asks about them:

- **Goals and preferences:** Proactively, at the first natural opportunity. A passed race date or expired time-bound preference should be surfaced promptly.
- **Constraints:** When relevant to the conversation, which in a fitness context is most of the time.

**After check-in:** Three outcomes, all handled by existing tools: the user confirms the fact still applies (Orchestrator extends or clears the expiry), the user says it's resolved (invalidate), or the user gives updated information (update).

**Expired memories remain active** until a user invalidates them. Better to over-constrain than to silently drop a real constraint because the LLM's estimate was off.

**Memory inspection UI update:** Memories ordered by expiry date (soonest first, permanent at the bottom). Memories within the two-week threshold are visually highlighted.

**Tradeoff:** The conversational approach to expiry estimation adds overhead — the Orchestrator needs to find natural moments to ask about timeframes without derailing the primary conversation. But it produces much better estimates than silent LLM guessing, especially for goals and preferences where the user has precise information.

---

## Decision 15: Memory-ID-Specific Confirmation Guardrail with Turn-Based Expiry (Enhancement)

**Context:** When multiple memory changes arise in a single interaction, the Orchestrator batches all confirmation questions into one message and treats the user's next turn as their only chance to respond. This is unnatural — users may want to address each question in a separate message. It also means unanswered questions immediately fall through to the fallback behavior, giving the user no real opportunity to respond.

The underlying cause was the session-level flag gating memory mutations. It had no concept of individual memories or patience across turns — once armed, it authorized any memory change, and once the next turn passed, unanswered confirmations were treated as ignored.

**Decision:** Replace the session-level flag with per-memory-ID tracking and a 3-turn patience window.

- `pendingMemoryChanges` becomes a `Map` keyed by memory ID, each entry recording the proposed change and the turn it was armed. Arming for memory A does not authorize changes to memory B.
- When a memory tool executes, only that memory's authorization is consumed. Other authorized memories remain available in the same agentic loop.
- At the start of each `processMessage`, entries older than 3 turns are expired. This prevents stale authorizations from accumulating while giving the user adequate time to respond across multiple messages.
- The system prompt instructs the LLM to ask once, then wait up to 3 turns before proceeding silently. No nagging — if the user hasn't responded after 3 turns, the Orchestrator falls back per Decision 7 (proceed and inform for memory changes) or Decision 14 (estimate on its own for expiry).

The two arming paths (extraction pre-arm and inference block-then-retry) are preserved with the same semantics, scoped to specific memory IDs instead of the session.

**Tradeoff:** Per-memory-ID tracking adds complexity to session state, but eliminates cross-contamination between unrelated memory changes and makes multi-question conversations feel natural.

---

## Appendix: Production Enhancements (Deferred)

These enhancements were discussed during development and deemed valuable for production but out of scope for the prototype:

1. **Word-by-word response streaming:** Stream the final LLM response token-by-token rather than as a single complete event. Improves perceived latency for longer responses.

2. **Memory confidence scoring:** Assign and display a confidence level for each extracted memory. Mentioned in the spec as extra credit.

3. **Personality-aware reasoning tone:** Let the user choose a personality style and have the reasoning steps adapt accordingly.

4. **Embedding-based memory retrieval:** Replace LLM-based relevance scoring with vector similarity search for faster, more scalable memory retrieval.

5. **Transaction handling for tool execution:** The Orchestrator's tool execution loop is not wrapped in a database transaction. If the loop calls multiple tools and one fails partway through, earlier writes are not rolled back. For the workout domain the consequence is minor (a duplicate workout at worst), but in higher-stakes domains (financial transactions, multi-step bookings), you'd want the entire tool execution sequence to be atomic — all operations succeed or all are rolled back.

---

*— End of document —*
