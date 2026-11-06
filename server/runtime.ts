/** Application-facing runtime behavior. Native SDK/protocol objects stay in adapters. */
export type RuntimeId = "pi" | "codex";
export interface RuntimeDefaults {
  provider: string;
  model: string;
  thinking_level: string;
}
export interface RuntimeAgent {
  id: string;
  /** An application-derived Matrix thread key. An absent key selects the Agent's main session. */
  conversationId?: string;
  /** Earlier root text supplied as background for a new conversation's first turn. */
  initialContext?: string;
  instructions?: string;
  tools?: RuntimeTools;
}
export interface RuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface RuntimeFile {
  data: string;
  mimeType: string;
  name: string;
}
export interface RuntimeToolResult {
  text: string;
  files?: RuntimeFile[];
  images?: RuntimeImage[];
}
/** The application captures owner, room and message identity in this per-run closure. */
export interface RuntimeTools {
  definitions: RuntimeToolDefinition[];
  execute(name: string, args: unknown, context: { callId: string; signal: AbortSignal }): Promise<RuntimeToolResult>;
}
export interface RuntimeImage {
  type?: "image";
  data: string;
  mimeType: string;
  name?: string;
}
export interface RuntimeReply {
  text: string;
  images: RuntimeImage[];
  files?: RuntimeFile[];
  usedWebSearch?: boolean;
}
export interface RuntimeModel {
  provider: string;
  id: string;
  name: string;
  thinking_levels: readonly string[];
  available: boolean;
}
export interface AgentRuntime {
  initialize(): Promise<void>;
  validate(defaults: RuntimeDefaults): Promise<void>;
  models(): Promise<RuntimeModel[]>;
  selection(defaults: RuntimeDefaults): Promise<{
    thinking_level: string;
    thinking_levels: readonly string[];
  }>;
  initializeAgent(agent: RuntimeAgent, defaults: RuntimeDefaults): Promise<void>;
  run(agent: RuntimeAgent, defaults: RuntimeDefaults, text: string, images?: RuntimeImage[]): Promise<RuntimeReply>;
  stopAgent(id: string): Promise<void>;
  /** Release active sessions/processes while preserving credentials and conversation data. */
  deactivate(): Promise<void>;
  close(): Promise<void>;
  sanitizeError(error: unknown): string;
}
