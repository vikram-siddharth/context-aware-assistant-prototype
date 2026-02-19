/**
 * ToolProvider interface — implemented by each agent to register its tools.
 * The Orchestrator pulls tools from all providers at startup and builds a unified registry.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
  actionDescription: string;  // Human-readable description for SSE events
  execute: (input: any) => Promise<any>;
}

export interface ToolProvider {
  getTools(): ToolDefinition[];
}
