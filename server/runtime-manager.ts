import type { AgentRuntime, RuntimeId } from "./runtime.js";
import { AppError } from "./store.js";

export function runtimeId(value: unknown): RuntimeId {
  if (value === undefined || value === "pi") return "pi";
  if (value === "codex") return "codex";
  throw new AppError(400, "Choose Pi Coding Agent or Codex App Server.");
}

/** Two installed adapters; switching and durable message admission belong to Manager. */
export class RuntimeManager {
  constructor(
    readonly adapters: Record<RuntimeId, AgentRuntime>,
    public selected: RuntimeId = "pi",
  ) {}
  get active() { return this.adapters[this.selected]; }
  get(id: unknown) { return this.adapters[runtimeId(id)]; }
  async close() {
    await Promise.allSettled(Object.values(this.adapters).map((runtime) => runtime.close()));
  }
}
