export type OrchestratorEvent = {
  type: 'thinking' | 'action' | 'result' | 'error';
  content: string;
};

export type MemoryData = {
  id: string;
  fact: string;
  category: 'constraint' | 'preference' | 'goal';
  persistence: 'permanent' | 'long_term' | 'short_term';
  estimated_expiry: string | null;
  created_at: string;
};

export type ReasoningStepData = {
  type: 'thinking' | 'action';
  content: string;
};

export type Message = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: ReasoningStepData[];
};
