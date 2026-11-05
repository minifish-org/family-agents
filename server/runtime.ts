/** Application-facing runtime behavior. Native SDK/protocol objects stay in adapters. */
export type RuntimeId = "pi" | "codex";
export interface RuntimeDefaults {
  provider: string;
  model: string;
  thinking_level: string;
}
export interface RuntimeAgent {
  id: string;
  instructions?: string;
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
