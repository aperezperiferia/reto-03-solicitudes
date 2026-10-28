export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  functionCalls?: Array<{ id: string; name: string; arguments: string }>;
};
export type ToolDefinition = { name: string; description: string; schema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: string };
export type LlmResponse = { content: string; toolCalls: ToolCall[] };
export interface LlmAdapter {
  enviar(systemPrompt: string, messages: ChatMessage[], tools: ToolDefinition[]): Promise<LlmResponse>;
}
