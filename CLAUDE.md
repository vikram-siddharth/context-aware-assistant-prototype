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
- Memory extraction is best-effort (try/catch everything) — runs in parallel with retrieval via `Promise.all`
- Memory deduplication happens during extraction — pass existing active memories to the LLM and ask it to extract only new facts
- Memory invalidation is orchestrator-driven — the orchestrator LLM uses the `invalidate_memory` tool when it notices a contradiction between the user's message and a stored memory
- Memory invalidation uses soft-delete (active = false) — invalidated memories stay in the database for history
- The Planning Agent generates plans but does not write to storage — the Orchestrator saves plans via the Task Agent
- The UI must never show tool names, raw JSON, SQL, embeddings, or prompt scaffolding

## Database Schema
### Workout (transactional domain state)
id, type, duration, date, description (nullable), status (scheduled/completed/cancelled), created_at, updated_at

### Memory (persistent memory)
id, fact, category (constraint/preference/goal), persistence (permanent/long_term/short_term), active (boolean, default true), created_at

## Implementation Notes

### Orchestrator
- Uses Anthropic SDK directly (@anthropic-ai/sdk) for full control over tool definitions
- Implements agentic loop to handle multi-step tool usage (max 5 iterations)
- Tool definitions use proper Anthropic `input_schema` format with explicit `type: 'object'`
- Tools: `create_workout`, `get_workouts`, `create_plan`, `invalidate_memory`
- Runs memory retrieval and extraction in parallel via `Promise.all`
- `processMessage()` returns `{ response: string }`
- Accepts optional `onEvent` callback (`EventCallback`) for SSE streaming
- Exports `OrchestratorEvent` type: `{ type: 'thinking' | 'action' | 'result' | 'error', content: string }`
- Emits human-readable events at each stage (memory recall, tool execution, final response)
- `rephraseFact()` converts raw DB facts to natural second-person English (e.g. "Has a knee injury" → "I remember you have a knee injury")
- `describeToolAction()` maps tool names to user-friendly descriptions (no tool names or JSON exposed)
- `buildSystemPrompt()` includes memory IDs in the user context section and instructs the LLM to use `invalidate_memory` when it detects contradictions
- 400ms delay between rapid events so the UI can render them; final result event has no delay

### Session Controller
- In-memory Map storing conversation history by session ID
- Uses AI SDK's CoreMessage type for message format compatibility
- Methods: addMessage, getHistory, clearSession, getActiveSessions, hasSession

### Memory Agent
- Extraction is best-effort, never throws errors — returns `ExtractionResult { newMemories, conflicts }`
- Conflict detection during extraction is supplementary — the primary mechanism is the orchestrator's `invalidate_memory` tool
- Exports `MemoryConflict` type: `{ existingMemoryId, existingFact, existingCategory, newInfo, reason }`
- Deduplication: passes existing active memories (with IDs) to LLM to avoid re-extraction
- Retrieval uses LLM-based relevance scoring (0-10 scale, returns only scores ≥5)
- All queries filter by `active: true` — invalidated memories are hidden from retrieval and extraction
- `invalidateMemory(id)` sets `active = false` (soft-delete for history preservation)
- All database operations wrapped in try/catch

### Planning Agent
- Uses Vercel AI SDK's `generateObject()` with claude-sonnet-4-20250514
- Generates structured workout plans with Zod schema validation
- Receives: user request, relevant memories (constraints/preferences/goals), optional date
- Returns: type, duration, description, explanation (why this plan was chosen)
- Specialized system prompt focused on workout planning and constraint awareness
- Groups memories by category in prompt (CONSTRAINTS, Goals, Preferences)
- Emphasizes respecting physical constraints and explaining alternatives
- Does NOT write to database — Orchestrator saves generated plans via Task Agent

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
- ✅ Tool execution (create_workout, get_workouts, create_plan)
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
- [x] Orchestrator with tool definitions (create_workout, get_workouts, create_plan, invalidate_memory)
- [x] Planning Agent (LLM-powered with constraint awareness and explanations)
- [x] Session Controller (in-memory conversation history per session)
- [x] Chat routes (POST /api/chat, session management)
- [x] Integration testing (test-orchestrator.ts and test-planning-agent.ts validate full flow)
- [x] SSE streaming endpoint (Orchestrator emits events via callback, chat route streams them)
- [x] SSE test script (test-sse.ts — boots server, sends two requests, logs streamed events)
- [x] Memory invalidation (orchestrator-driven via `invalidate_memory` tool, soft-delete with active flag)
- [x] React frontend with chat UI
