import type { OrchestratorEvent, MemoryData, WorkoutData } from '../types';

export async function sendMessage(
  message: string,
  sessionId: string,
  userId: string,
  onEvent: (event: OrchestratorEvent) => void
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, userId }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Request failed');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const json = trimmed.slice(5).trim();
      if (!json) continue;

      try {
        const event: OrchestratorEvent = JSON.parse(json);
        onEvent(event);
      } catch {
        // Skip malformed events
      }
    }
  }
}

export async function fetchMemories(userId: string): Promise<MemoryData[]> {
  const response = await fetch(`/api/memories?userId=${encodeURIComponent(userId)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch memories');
  }

  const data = await response.json();
  return data.memories;
}

export async function fetchWorkouts(userId: string): Promise<WorkoutData[]> {
  const today = new Date().toISOString().split('T')[0];
  const params = new URLSearchParams({
    userId,
    status: 'scheduled',
    startDate: today,
  });
  const response = await fetch(`/api/workouts?${params}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch workouts');
  }

  return response.json();
}
