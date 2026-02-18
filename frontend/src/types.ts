export type OrchestratorEvent = {
  type: 'thinking' | 'action' | 'result' | 'error';
  content: string;
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
