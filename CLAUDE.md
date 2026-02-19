# Context Aware Assistant

## What This Project Is
A stateful AI chatbot that remembers user facts across sessions and uses them to influence future behavior. A user can state a fact (like "I have a knee injury") in one session, and the system will remember and enforce it as a constraint in future sessions.

## Architecture
```
UI (React + TypeScript)
    ↓ (SSE)
Session Controller
    ↓
Orchestrator (intent + planning via LLM)
    ├→ Memory Agent (extract/retrieve user facts, best-effort, async)
    ├→ Task Agent (CRUD operations, deterministic, strongly consistent)
    └→ Planning Agent (constrained reasoning, no direct DB writes)
    ↓
Postgres (TypeORM)
```

## Tech Stack
- Backend: Node.js, TypeScript, Express
- Database: PostgreSQL with TypeORM
- AI: Anthropic SDK (@anthropic-ai/sdk) for orchestrator, Vercel AI SDK for memory agent and planning agent
- Model: claude-sonnet-4-20250514
- Frontend: React + TypeScript (Vite)
- Streaming: Server-Sent Events (SSE)

## Project Structure
- `backend/src/database/` — TypeORM data source and entity configuration
- `backend/src/entities/` — Workout and Memory entities
- `backend/src/agents/` — Task Agent, Memory Agent, Planning Agent
- `backend/src/orchestrator/` — Central orchestrator that delegates to agents
- `backend/src/session/` — Session Controller (in-memory conversation history)
- `backend/src/routes/` — Express route handlers (workout-routes, chat-routes)
- `frontend/src/` — React chat UI (Vite + TypeScript)

## Key Design Rules
- The Orchestrator is the only component that talks to the LLM for intent/planning
- The Task Agent is deterministic — no LLM calls, just CRUD
- The Memory Agent calls the LLM only for extraction and relevance scoring
- The Planning Agent calls the LLM only for workout plan generation
- Memory extraction is best-effort (try/catch everything) — awaited before the main LLM call so refinement signals are available
- Memory deduplication happens during extraction — pass existing active memories to the LLM and ask it to extract only new facts
- Memory management is orchestrator-driven — the orchestrator LLM uses `invalidate_memory` (contradictions/resolutions) and `update_memory` (refinements/evolution where the fact still matters) tools
- Memory changes require user confirmation via two-turn flow — the LLM asks for confirmation in one turn (no tool call), and only calls the memory tool on the next turn after the user responds. A guardrail in `processMessage` blocks `update_memory`/`invalidate_memory` from executing unless a prior confirmation request was made (tracked via `pendingMemoryChanges` in session state).
- Inference-based memory updates are allowed — if the user says something that implies a stored fact may have changed, the orchestrator asks to confirm before updating (e.g., "I ran a 10K" when a knee injury is stored → ask if it's healed)
- Four categories of memory change: contradictions (no longer true → invalidate), refinements (more specific info → update), evolution (condition changed but still relevant → update), resolution (fully resolved, no longer influences behavior → invalidate)
- Memory invalidation uses soft-delete (active = false) — invalidated memories stay in the database for history
- The Planning Agent generates plans but does not write to storage — the Orchestrator stashes plans as pending proposals in session state
- All workout creation goes through a two-turn confirmation: `create_plan` → present to user → `confirm_proposal` (mechanical enforcement)
- `create_workout` is internal-only — called by `confirm_proposal` to write to DB, never exposed to the LLM as a callable tool
- A guardrail in `processMessage` blocks `confirm_proposal` in the same turn as `create_plan`
- Dynamic tool registration: each agent implements a `ToolProvider` interface with `getTools()`. The Orchestrator pulls tools from all agents at startup and builds a unified registry with collision detection. Orchestrator-level wrappers (`applyToolWrappers`) add session coordination (e.g., stashing proposals, refreshing memory caches) without agents needing session knowledge.
- Session intent vs. durable facts: both the Memory Agent extraction prompt and the Orchestrator system prompt distinguish ephemeral session intent ("I'd like to swim") from durable facts ("I like swimming"). The linguistic test (conditional mood → session intent, indicative mood → durable fact) prevents storing one-time requests as lasting preferences.
- The UI must never show tool names, raw JSON, SQL, embeddings, or prompt scaffolding

## Database Schema
### Workout (transactional domain state)
id, type, duration, date, description (nullable), status (scheduled/completed/cancelled), created_at, updated_at

### Memory (persistent memory)
id, fact, category (constraint/preference/goal), persistence (permanent/long_term/short_term), active (boolean, default true), estimated_expiry (date, nullable, default null), created_at

## Implementation Notes

### Orchestrator
- Uses Anthropic SDK directly (@anthropic-ai/sdk) for full control over tool definitions
- Implements agentic loop to handle multi-step tool usage (max 5 iterations)
- Tool definitions come from agents via `ToolProvider.getTools()` — the Orchestrator builds a unified registry at startup via `buildToolRegistry()` and converts definitions to Anthropic format in `getToolDefinitions()`
- `applyToolWrappers(registry)` wraps agent-owned tools with orchestrator-level coordination: `create_plan` gets session memories injected and stashes proposals; `confirm_proposal` reads/clears pending proposals from session state; `update_memory`/`invalidate_memory` refresh the session memory cache after mutations
- `executeTool()` is a simple registry lookup — no switch/case routing
- LLM-callable tools: `get_workouts`, `create_plan`, `confirm_proposal`, `update_memory`, `invalidate_memory`
- `processMessage()` returns `{ response: string }`
- Accepts optional `onEvent` callback (`EventCallback`) for SSE streaming
- Exports `OrchestratorEvent` type: `{ type: 'thinking' | 'action' | 'result' | 'error', content: string }`
- Emits human-readable events at each stage (tool execution, final response) — does NOT list all memories at session start
- Memories are only surfaced in thinking events when they actively influence a specific decision (e.g., "Keeping your knee injury in mind...")
- `describeToolAction()` looks up `actionDescription` from the tool registry (no tool names or JSON exposed)
- `buildSystemPrompt(sessionId, memories, refinements)` includes memory IDs in the user context section, instructs the LLM to manage memories via `update_memory` and `invalidate_memory` with four change categories (contradictions, refinements, evolution, resolution), supports inference-based updates with confirmation, includes two-turn confirmation flow for memory mutations, includes "Session Intent vs. Durable Facts" section (preventing memory tools from being used on ephemeral requests), includes "Workout Planning Flow" instructions (two-turn confirmation), and injects pending proposal context when one exists
- Extraction is awaited (not fire-and-forget) so refinement signals are available before the main LLM call
- When extraction detects refinements, they are NOT auto-applied — they are passed to the LLM via a "Detected Memory Changes" section in the system prompt, so the LLM can handle them through the two-turn confirmation flow (ask user → wait → call update_memory or invalidate_memory)
- 400ms delay between rapid events so the UI can render them; final result event has no delay
- `create_plan` wrapper (in `applyToolWrappers`) injects session memories, calls Planning Agent, stashes the generated plan as a `PendingProposal` in session state (does NOT write to DB), and returns plan details + message telling the LLM to present and wait
- `confirm_proposal` wrapper reads the pending proposal from session state, passes it to Task Agent's execute function, writes it to DB, and clears the proposal
- Guardrail: `toolsCalledThisTurn` Set tracks tool names per `processMessage()` call; blocks `confirm_proposal` if `create_plan` was already called in the same turn
- Guardrail: `pendingMemoryChanges` in session state enforces confirmation for memory mutations — `update_memory`/`invalidate_memory` are blocked unless the session has a pending memory change flag. Two arming paths: (1) **extraction path** — flag pre-armed when extraction detects refinements, allowing the tool on the next turn after user confirms; (2) **inference path** — flag set when the guardrail blocks a tool call, error message tells the LLM to retry immediately if the user already confirmed (block-then-retry within the same agentic loop). Flag is cleared when the tool successfully executes.
- System prompt includes "Session Intent vs. Durable Facts" section with linguistic test (conditional mood = session intent, indicative mood = durable fact)
- System prompt includes "Workout Planning Flow" section describing the two-turn confirmation flow (create_plan → confirm_proposal)
- System prompt includes "Pending Workout Proposal" section (conditional) when a proposal exists, with instructions for confirm/modify/reject

### Session Controller
- In-memory Map storing conversation history by session ID
- Uses AI SDK's CoreMessage type for message format compatibility
- Three Maps + one Set: `sessions` (conversation history), `sessionMemories` (cached memories), `pendingProposals` (pending workout proposals), `pendingMemoryChanges` (sessions awaiting memory change confirmation)
- Exports `PendingProposal` type: `{ type, duration, date (ISO string), description, status, explanation, goal }`
- Methods: addMessage, getHistory, setSessionMemories, getSessionMemories, hasLoadedMemories, clearSession, getActiveSessions, hasSession, setPendingProposal, getPendingProposal, clearPendingProposal, hasPendingProposal, setPendingMemoryChange, hasPendingMemoryChange, clearPendingMemoryChange
- `clearSession()` clears all three Maps and the Set for the session

### Memory Agent
- Implements `ToolProvider` — owns `update_memory` and `invalidate_memory` tools
- Extraction is best-effort, never throws errors — returns `ExtractionResult { newMemories, refinements }`
- Extraction has two jobs: (1) extract genuinely new facts, (2) detect refinements to existing memories
- Extraction prompt includes "Session Intent vs. Durable Facts" section: conditional/volitional phrasing ("I'd like to swim", "I'd love to swim") is session intent and must NOT be extracted; general/habitual phrasing ("I like swimming", "I love swimming") is a durable fact and should be extracted
- Exports `MemoryRefinement` type: `{ existingMemoryId, existingFact, suggestedUpdate, reason }`
- Refinements are returned to the Orchestrator (not acted on by the Memory Agent) — the Orchestrator auto-applies them and notifies the LLM so it can acknowledge naturally
- Deduplication: passes existing active memories (with IDs) to LLM to avoid re-extraction
- Retrieval uses LLM-based relevance scoring (0-10 scale, returns only scores ≥5)
- All queries filter by `active: true` — invalidated memories are hidden from retrieval and extraction
- `invalidateMemory(id)` sets `active = false` (soft-delete for history preservation)
- All database operations wrapped in try/catch

### Planning Agent
- Implements `ToolProvider` — owns `create_plan` tool
- Uses Vercel AI SDK's `generateObject()` with claude-sonnet-4-20250514
- Generates structured workout plans with Zod schema validation
- Receives: user request, relevant memories (constraints/preferences/goals), optional date
- Returns: type, duration, description, explanation (why this plan was chosen)
- Specialized system prompt focused on workout planning and constraint awareness
- Groups memories by category in prompt (CONSTRAINTS, Goals, Preferences)
- Emphasizes respecting physical constraints and explaining alternatives
- Does NOT write to database — Orchestrator stashes generated plans as pending proposals in session state

### Chat Routes
- POST /api/chat - SSE streaming endpoint (accepts message + sessionId in JSON body, streams OrchestratorEvents)
  - Validation errors return JSON (before SSE headers are sent)
  - Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
  - Each event written as `data: {json}\n\n`
  - Stream closed in `finally` block after orchestrator completes
- DELETE /api/chat/sessions/:sessionId - Clear session history
- GET /api/chat/sessions - List active sessions

## Test Results
**Last tested:** 2026-02-17

Integration test (`test-orchestrator.ts`) validates:
- ✅ Memory extraction from user messages
- ✅ Memory persistence in PostgreSQL
- ✅ Cross-session memory retrieval (different session IDs)
- ✅ Constraint enforcement (knee injury mentioned in responses)
- ✅ Tool execution (get_workouts, create_plan, confirm_proposal)
- ✅ Agentic loop handling (multi-step tool usage)

**Test scenario:**
1. Session 1: User mentions knee injury → 2 memories extracted (constraint + goal)
2. Session 2: Different session asks for workout plan → Retrieved memories, Planning Agent generated 45-min low-impact cardio (pool running, stationary bike) respecting knee constraint, saved to database
3. Session 3: User schedules workout → Created workout with context-aware response mentioning knee

**Planning Agent validation:**
- Generated constraint-aware plan (avoided high-impact exercises)
- Provided detailed explanation of why pool running was chosen
- Respected physical limitation while maintaining training goals
- Successfully saved generated plan via Task Agent

## Current Status
- [x] Environment setup (Node.js, Postgres, Git)
- [x] Project initialized (backend + frontend)
- [x] Backend dependencies installed
- [x] TypeORM entities and database connection
- [x] Task Agent with CRUD operations
- [x] REST endpoints for testing
- [x] Memory Agent (extraction + retrieval)
- [x] Orchestrator with tool definitions (get_workouts, create_plan, confirm_proposal, update_memory, invalidate_memory)
- [x] Planning Agent (LLM-powered with constraint awareness and explanations)
- [x] Session Controller (in-memory conversation history per session)
- [x] Chat routes (POST /api/chat, session management)
- [x] Integration testing (test-orchestrator.ts and test-planning-agent.ts validate full flow)
- [x] SSE streaming endpoint (Orchestrator emits events via callback, chat route streams them)
- [x] SSE test script (test-sse.ts — boots server, sends two requests, logs streamed events)
- [x] Memory invalidation (orchestrator-driven via `invalidate_memory` tool, soft-delete with active flag)
- [x] React frontend with chat UI
- [x] User confirmation for domain actions (Decision 11: two-turn plan→confirm flow, guardrail, pending proposals in session state)
- [x] Dynamic tool registration (Decision 12: ToolProvider interface, registry with collision detection, orchestrator wrappers)
- [x] Session intent vs. durable facts filtering (linguistic test in Memory Agent extraction prompt and Orchestrator system prompt)
- [x] Memory expiry column (estimated_expiry: nullable date, defaults to null — Orchestrator will fill conversationally in piece 2)
