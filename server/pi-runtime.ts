import type { AgentRuntime, RuntimeAgent, RuntimeDefaults, RuntimeImage } from "./runtime.js";
import { PiService } from "./pi.js";

/** Keep Pi's native provider, auth, tool and session implementation intact. */
export class PiRuntime implements AgentRuntime {
  constructor(readonly service: PiService) {}
  async initialize() { await this.service.ready; }
  async validate(defaults: RuntimeDefaults) {
    await this.initialize();
    await this.service.validate(defaults);
  }
  models() { return this.service.models(); }
  async selection(defaults: RuntimeDefaults) {
    await this.initialize();
    return {
      thinking_level: this.service.clampThinking(defaults.provider, defaults.model, defaults.thinking_level),
      thinking_levels: this.service.thinkingLevels(defaults.provider, defaults.model),
    };
  }
  initializeAgent(agent: RuntimeAgent, defaults: RuntimeDefaults) {
    return this.service.initializeAgent(agent, defaults);
  }
  run(agent: RuntimeAgent, defaults: RuntimeDefaults, text: string, images?: RuntimeImage[]) {
    return this.service.run(agent, defaults, text, images);
  }
  stopAgent(id: string) { return this.service.stopAgent(id); }
  deactivate() { return this.service.deactivate(); }
  close() { return this.service.close(); }
  sanitizeError(error: unknown) { return this.service.sanitizeError(error); }
}
