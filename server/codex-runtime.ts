import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { AppError } from "./store.js";
import { CodexClient } from "./codex-client.js";
import { ChatGptAuth } from "./chatgpt-auth.js";
import type { AgentRuntime, RuntimeAgent, RuntimeDefaults, RuntimeImage, RuntimeModel, RuntimeReply } from "./runtime.js";
import type { Model } from "./generated/codex/v2/Model.js";
import type { ModelListResponse } from "./generated/codex/v2/ModelListResponse.js";
import type { GetAccountResponse } from "./generated/codex/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "./generated/codex/v2/LoginAccountResponse.js";
import type { ThreadStartParams } from "./generated/codex/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/codex/v2/ThreadStartResponse.js";
import type { ThreadResumeParams } from "./generated/codex/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/codex/v2/ThreadResumeResponse.js";
import type { TurnStartParams } from "./generated/codex/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/codex/v2/TurnStartResponse.js";
import type { ThreadItem } from "./generated/codex/v2/ThreadItem.js";
import type { Turn } from "./generated/codex/v2/Turn.js";
import type { DynamicToolCallParams } from "./generated/codex/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./generated/codex/v2/DynamicToolCallResponse.js";

/** Structural transport boundary also allows deterministic protocol tests. */
export interface CodexConnection extends EventEmitter {
  readonly homeDir: string;
  readonly cwd: string;
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  setAccessToken(accessToken?: string): Promise<void>;
  setRequestHandler(handler: (method: string, params: any) => unknown | Promise<unknown>): void;
  close(): Promise<void>;
}
type Session = { threadId: string; instructions: string; cwd: string; submitted: boolean };
type Message = { text: string; phase?: string | null; completed: boolean };
type Active = {
  agentId: string;
  threadId: string;
  turnId?: string;
  early: Array<[string, any]>;
  messages: Map<string, Message>;
  inputImages: RuntimeImage[];
  outputImages: RuntimeImage[];
  done: Promise<RuntimeReply>;
  resolve: (reply: RuntimeReply) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
  approvalDenied: boolean;
  acknowledged: Promise<void>;
  acknowledge: () => void;
  terminal: Promise<void>;
  terminate: () => void;
};
type LoginState = { status: "pending" | "complete" | "error" | "cancelled"; loginId?: string; error?: string };
export interface ChatGptAuthentication extends EventEmitter {
  status(): { type: "chatgpt"; email?: string; subject: string; clientId: string; auth_method: "siwc"; reauthorizationRequired?: boolean } | null;
  registrations(): Array<{ id: string; email?: string; active?: boolean }>;
  version(): string;
  begin(options?: { newAccount?: boolean; registrationId?: string }): Promise<{ type: "chatgpt"; loginId: string; authUrl: string; redirectUri: string }>;
  submit(loginId: string, callbackUrl: string): Promise<void>;
  loginStatus(): { status: string; loginId?: string; error?: string; prompt?: string; redirectUri?: string; authUrl?: string } | undefined;
  accessToken(): Promise<string | undefined>;
  sanitizeError(error: unknown): string;
  logout(): Promise<{ revocationConfirmed: boolean }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
const assistantInstructions = "You are a helpful family assistant communicating privately through Matrix. Use native web search for current information when available. You have no shell, local-file, MCP, browser, or command execution tools. The send_image tool can only return an image attached to the current user message. Do not claim other access. Reply with the final answer. Cite sources with ordinary Markdown links containing the source URLs, because Matrix cannot resolve opaque citation markers. Keep private reasoning and tool diagnostics out of the answer.";
const directory = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
};

/** Codex owns conversation history, credentials, compaction, models, and web search. */
export class CodexRuntime implements AgentRuntime {
  readonly client: CodexConnection;
  readonly authentication: ChatGptAuthentication;
  onAuthenticationChanged?: () => void;
  private readonly agentsDir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session>>();
  private readonly active = new Map<string, Active>();
  private readonly pending = new Map<string, Promise<RuntimeReply>>();
  private readonly generations = new Map<string, number>();
  private readonly catalog = new Map<string, Model>();
  private readonly versionKey = randomBytes(32);
  private readonly submittedSecrets = new Set<string>();
  private readonly turnTimeoutMs: number;
  private readonly interruptTimeoutMs: number;
  private authQueue: Promise<unknown> = Promise.resolve();
  private authChanging = false;
  private preparing = 0;
  private revision = 0;
  private loginState?: LoginState;
  private admission: Promise<void> = Promise.resolve();
  private leases = 0;
  private idle: Promise<void> = Promise.resolve();
  private idleResolve?: () => void;
  private processToken?: string;
  private notificationPending = false;
  private closed = false;
  private deactivating = false;
  private deactivation?: Promise<void>;

  constructor(dataDir: string, options: { client?: CodexConnection; authentication?: ChatGptAuthentication; turnTimeoutMs?: number; interruptTimeoutMs?: number } = {}) {
    this.client = options.client ?? new CodexClient(dataDir);
    this.authentication = options.authentication ?? new ChatGptAuth(dataDir, {
      beforeCommit: (reason) => this.beforeCredentialCommit(reason),
    });
    this.authentication.on("changed", (reason: string) => {
      this.revision++;
      this.catalog.clear();
      if (reason === "login" || reason === "logout") this.notifyAuthenticationChanged();
    });
    this.agentsDir = resolve(dataDir, "codex", "agents");
    directory(this.agentsDir);
    this.turnTimeoutMs = options.turnTimeoutMs ?? 10 * 60_000;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 5000;
    this.client.on("notification", (method: string, params: any) => this.notification(method, params));
    const disconnected = () => {
      this.sessions.clear();
      for (const state of [...this.active.values()])
        this.finish(state, new AppError(503, "Codex App Server disconnected. The interrupted request was not replayed; send a new message to continue."));
    };
    this.client.on("disconnect", disconnected);
    this.client.on("exit", disconnected);
    this.client.on("approval-denied", (params: any) => {
      const state = this.active.get(params?.threadId);
      if (state && (!state.turnId || !params.turnId || state.turnId === params.turnId)) state.approvalDenied = true;
    });
    this.client.setRequestHandler((method, params) => this.toolCall(method, params));
  }

  async initialize() {
    if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
    try { await this.client.start(); }
    catch (error) { throw new AppError(503, this.sanitizeError(error)); }
    if (this.closed || this.deactivating) {
      await this.client.close();
      throw new AppError(503, "The Codex runtime is stopping.");
    }
  }

  private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.initialize();
    if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
    try { return await this.client.request<T>(method, params); }
    catch (error) { throw new AppError(error instanceof AppError ? error.status : 502, this.sanitizeError(error)); }
  }

  private authVersion() {
    const path = join(this.client.homeDir, "auth.json");
    return createHmac("sha256", this.versionKey)
      .update(String(this.revision)).update("\0").update(this.authentication.version())
      .update(existsSync(path) ? readFileSync(path) : "")
      .digest("hex");
  }

  private async lockAdmission() {
    const previous = this.admission.catch(() => {});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    this.admission = previous.then(() => held);
    await previous;
    return release;
  }

  private notifyAuthenticationChanged() {
    if (this.notificationPending) return;
    this.notificationPending = true;
    // Interactive API mutations still own authChanging when the credential event fires.
    // Recover desired Agents only after that mutation has released its guard.
    void this.authQueue.catch(() => {}).then(() => {
      this.notificationPending = false;
      if (!this.closed && !this.deactivating) this.onAuthenticationChanged?.();
    }).catch(() => { this.notificationPending = false; });
  }

  private async beforeCredentialCommit(reason: "login" | "refresh" | "logout") {
    // Saving a refreshed token is safe while old turns use their pinned process token.
    // Admission below drains those turns before installing the replacement in a process.
    if (reason === "refresh") return;
    const release = await this.lockAdmission();
    const changing = this.authChanging;
    this.authChanging = true;
    try {
      await this.idle;
      if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
      await this.client.close();
      await this.client.setAccessToken(undefined);
      this.processToken = undefined;
      this.sessions.clear();
      return () => { this.authChanging = changing; release(); };
    } catch (error) {
      this.authChanging = changing;
      release();
      throw error;
    }
  }

  private async acquireLease(): Promise<() => void> {
    for (;;) {
      if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
      // Never hold admission while waiting for the credential store: login commits take
      // that store first, then admission, and must be able to drain an older turn.
      const token = await this.authentication.accessToken();
      const version = this.authentication.version();
      const unlock = await this.lockAdmission();
      try {
        if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
        if (version !== this.authentication.version()) continue;
        if (this.authChanging) throw new AppError(409, "Codex authentication is changing. Try again shortly.");
        if (token !== this.processToken) {
          await this.idle;
          if (version !== this.authentication.version()) continue;
          if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
          await this.client.setAccessToken(token);
          this.processToken = token;
          this.sessions.clear();
        }
        await this.initialize();
        if (!this.leases) this.idle = new Promise<void>((resolve) => { this.idleResolve = resolve; });
        this.leases++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (!--this.leases) { this.idleResolve?.(); this.idleResolve = undefined; }
        };
      } finally { unlock(); }
    }
  }

  async account() {
    const direct = this.authentication.status();
    let account: { type: string; email?: string | null; planType?: string } | null = direct
      ? { type: "chatgpt", ...(direct.email ? { email: direct.email } : {}) } : null;
    let authenticated = !!direct && !direct.reauthorizationRequired;
    let auth_method: "siwc" | "apiKey" | "legacy" | null = direct ? "siwc" : null;
    if (!direct) {
      const result = await this.request<GetAccountResponse>("account/read", { refreshToken: false });
      const value = result.account;
      if (value?.type === "apiKey") { account = { type: value.type }; authenticated = true; auth_method = "apiKey"; }
      else if (value?.type === "chatgpt") {
        account = { type: value.type, email: value.email, planType: value.planType };
        auth_method = "legacy";
      }
    }
    const login = this.loginState ?? this.authentication.loginStatus();
    return {
      version: this.authVersion(), authenticated, account, auth_method,
      registrations: this.authentication.registrations(),
      ...(auth_method === "legacy" ? { legacy: true, message: "Reconnect using Continue with ChatGPT to use the new authorization." } : {}),
      ...(direct?.reauthorizationRequired ? { message: "ChatGPT authorization must be renewed. Continue with ChatGPT to reconnect." } : {}),
      ...(login ? { login: { ...login } } : {}),
    };
  }

  private mutateAuth<T>(version: string, operation: () => Promise<T>): Promise<T> {
    const next = this.authQueue.catch(() => {}).then(async () => {
      if (this.closed || this.deactivating) throw new AppError(503, "The Codex runtime is stopping.");
      if (version !== this.authVersion()) throw new AppError(409, "Codex authentication changed. Reload before saving.");
      if (this.active.size || this.preparing || this.leases) throw new AppError(409, "Wait for active Agent turns before changing Codex authentication.");
      this.authChanging = true;
      try {
        const result = await operation();
        this.revision++;
        this.catalog.clear();
        return result;
      } catch (error) {
        throw new AppError(error instanceof AppError ? error.status : 400, this.sanitizeError(error));
      } finally { this.authChanging = false; }
    });
    this.authQueue = next;
    return next;
  }

  login(body: { type: "apiKey" | "chatgpt"; apiKey?: string; version: string; newAccount?: boolean; registrationId?: string }) {
    return this.mutateAuth(body.version, async () => {
      if (this.authentication.loginStatus()?.status === "pending") throw new AppError(409, "Complete or cancel the current ChatGPT sign in first.");
      if (body.type === "chatgpt") {
        this.loginState = undefined;
        return this.authentication.begin({ newAccount: body.newAccount, registrationId: body.registrationId });
      }
      if (body.type !== "apiKey") throw new AppError(400, "Choose an API key or Continue with ChatGPT.");
      if (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 16384) throw new AppError(400, "Enter a valid API key.");
      this.submittedSecrets.add(body.apiKey);
      await this.client.setAccessToken(undefined);
      this.processToken = undefined;
      this.sessions.clear();
      const result = await this.request<LoginAccountResponse>("account/login/start", { type: "apiKey", apiKey: body.apiKey });
      // Keep the previous SIWC account usable until the API-key write has succeeded.
      if (this.authentication.status()) await this.authentication.logout();
      this.loginState = { status: "complete" };
      this.notifyAuthenticationChanged();
      return result;
    });
  }

  submitLogin(body: { loginId: string; callbackUrl: string; version: string }) {
    return this.mutateAuth(body.version, async () => {
      await this.authentication.submit(body.loginId, body.callbackUrl);
      return { ok: true };
    });
  }

  logout(version: string) {
    return this.mutateAuth(version, async () => {
      await this.authentication.cancel();
      const result = await this.authentication.logout();
      await this.client.setAccessToken(undefined);
      this.processToken = undefined;
      this.sessions.clear();
      await this.request("account/logout");
      this.loginState = { status: "cancelled" };
      return { ok: true, ...result,
        ...(!result.revocationConfirmed ? { warning: "Local sign out completed. Remote revocation could not be confirmed; manage access in ChatGPT settings." } : {}) };
    });
  }

  cancelLogin(version: string) {
    return this.mutateAuth(version, async () => {
      await this.authentication.cancel();
      return { ok: true };
    });
  }

  async models(): Promise<RuntimeModel[]> {
    const release = await this.acquireLease();
    try { return await this.readModels(); } finally { release(); }
  }

  private async readModels(): Promise<RuntimeModel[]> {
    const account = await this.account();
    const found = new Map<string, Model>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await this.request<ModelListResponse>("model/list", { cursor, limit: 100, includeHidden: false });
      for (const model of page.data) if (!model.hidden) found.set(model.model, model);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new AppError(502, "Codex returned an invalid model catalog cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.catalog.clear();
    for (const [id, model] of found) this.catalog.set(id, model);
    return [...found.values()].map((model) => ({
      provider: "codex", id: model.model, name: model.displayName,
      thinking_levels: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      available: account.authenticated,
    }));
  }

  async selection(defaults: RuntimeDefaults) {
    await this.models();
    const model = this.selectedModel(defaults);
    const levels = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    return {
      thinking_level: levels.includes(defaults.thinking_level) ? defaults.thinking_level : levels.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : levels[0] ?? "",
      thinking_levels: levels,
    };
  }

  private selectedModel(defaults: RuntimeDefaults) {
    const model = this.catalog.get(defaults.model);
    if (defaults.provider !== "codex" || !model) throw new AppError(400, "Choose an available Codex model in Settings.");
    return model;
  }

  async validate(defaults: RuntimeDefaults) {
    const release = await this.acquireLease();
    try { await this.validateCurrent(defaults); } finally { release(); }
  }

  private async validateCurrent(defaults: RuntimeDefaults) {
    const models = await this.readModels();
    if (!models.some((model) => model.available)) throw new AppError(400, "Configure Codex authentication in Settings first.");
    this.selectedModel(defaults);
  }

  private agentDirectory(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AppError(400, "Invalid Agent ID.");
    const path = join(this.agentsDir, id);
    directory(path);
    return path;
  }

  private async loadAgent(agent: RuntimeAgent, defaults: RuntimeDefaults): Promise<Session> {
    const existing = this.sessions.get(agent.id);
    const instructions = agent.instructions ?? "";
    if (existing?.instructions === instructions) return existing;
    const dir = this.agentDirectory(agent.id), cwd = join(dir, "workspace"), mapping = join(dir, "thread.json");
    directory(cwd);
    const saved = this.readMapping(agent.id);
    let threadId = existing?.submitted ? existing.threadId : saved?.submitted ? saved.threadId : undefined;
    const common = {
      cwd, model: defaults.model, modelProvider: this.processToken ? "openai_chatgpt_plan" : "openai", approvalPolicy: "on-request", sandbox: "read-only",
      developerInstructions: [assistantInstructions, instructions].filter(Boolean).join("\n\n"),
      config: { web_search: "live", project_doc_max_bytes: 0 },
    } as const;
    let response: ThreadStartResponse | ThreadResumeResponse;
    if (threadId) {
      const params: ThreadResumeParams = { ...common, threadId };
      response = await this.request<ThreadResumeResponse>("thread/resume", params);
      if (response.thread.id !== threadId) throw new AppError(502, "Codex resumed a different conversation. No message was sent.");
      if (response.thread.status?.type === "active") {
        const turn = response.thread.turns.findLast((turn) => turn.status === "inProgress");
        if (!turn) throw new AppError(409, "Codex reports an active conversation without its turn ID. Wait before retrying this Agent.");
        const state = this.active.get(threadId) ?? this.createActive(agent.id, threadId, []);
        state.turnId = turn.id;
        state.acknowledge();
        await this.interrupt(state);
      }
    } else {
      const params: ThreadStartParams = {
        ...common, ephemeral: false, allowProviderModelFallback: false,
        dynamicTools: [{
          type: "function", name: "send_image",
          description: "Send one image attached to the current message back to its owner. attachment_index is zero-based. Cannot read files or fetch URLs.",
          inputSchema: { type: "object", properties: { attachment_index: { type: "integer", minimum: 0 } }, required: ["attachment_index"], additionalProperties: false },
        }],
      };
      response = await this.request<ThreadStartResponse>("thread/start", params);
      threadId = response.thread.id;
      if (typeof threadId !== "string" || !threadId) throw new AppError(502, "Codex did not create a conversation.");
      this.saveMapping(agent.id, threadId, false);
    }
    const session = { threadId, instructions, cwd, submitted: !!(existing?.submitted || saved?.submitted) };
    if ([...this.sessions.entries()].some(([id, other]) => id !== agent.id && other.threadId === threadId))
      throw new AppError(400, "Two Agents have the same saved Codex conversation. Restore the correct mapping before continuing.");
    this.sessions.set(agent.id, session);
    return session;
  }

  private readMapping(id: string): { threadId: string; submitted: boolean } | undefined {
    const path = join(this.agentDirectory(id), "thread.json");
    if (!existsSync(path)) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.version !== 1 || typeof saved.threadId !== "string" || !saved.threadId) throw new Error();
      return { threadId: saved.threadId, submitted: saved.submitted !== false };
    } catch { throw new AppError(400, "The saved Codex conversation mapping is invalid. Restore its backup before continuing."); }
  }

  private saveMapping(id: string, threadId: string, submitted: boolean) {
    const path = join(this.agentDirectory(id), "thread.json"), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, threadId, submitted }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  private ensureAgent(agent: RuntimeAgent, defaults: RuntimeDefaults) {
    const previous = this.loading.get(agent.id);
    if (previous) return previous;
    const loading = this.loadAgent(agent, defaults);
    this.loading.set(agent.id, loading);
    void loading.finally(() => { if (this.loading.get(agent.id) === loading) this.loading.delete(agent.id); }).catch(() => {});
    return loading;
  }

  async initializeAgent(agent: RuntimeAgent, defaults: RuntimeDefaults) {
    this.preparing++;
    let release: (() => void) | undefined;
    try {
      release = await this.acquireLease();
      await this.validateCurrent(defaults);
      // Native Codex does not materialize an empty thread's rollout until its first turn.
      // Defer new threads so switching an unused Agent never tries to resume missing history.
      if (this.readMapping(agent.id)?.submitted || this.sessions.get(agent.id)?.submitted)
        await this.ensureAgent(agent, defaults);
      else directory(join(this.agentDirectory(agent.id), "workspace"));
    } finally { release?.(); this.preparing--; }
  }

  run(agent: RuntimeAgent, defaults: RuntimeDefaults, text: string, images: RuntimeImage[] = []): Promise<RuntimeReply> {
    const generation = this.generations.get(agent.id) ?? 0;
    const operation = (this.pending.get(agent.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.preparing++;
      let state: Active | undefined;
      let release: (() => void) | undefined;
      try {
        release = await this.acquireLease();
        await this.validateCurrent(defaults);
        const session = await this.ensureAgent(agent, defaults);
        if (generation !== (this.generations.get(agent.id) ?? 0)) throw new AppError(409, "The Agent request was cancelled.");
        if (this.active.has(session.threadId)) throw new AppError(409, "This Agent already has an active Codex turn.");
        const model = this.selectedModel(defaults);
        if (images.length && !model.inputModalities.includes("image")) throw new AppError(400, "The selected Codex model does not support image input.");
        // A turn can finish before turn/start's response is read. Register before sending it.
        state = this.createActive(agent.id, session.threadId, images);
        const levels = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
        const params: TurnStartParams = {
          threadId: session.threadId, model: defaults.model, cwd: session.cwd,
          approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
          effort: levels.includes(defaults.thinking_level) ? defaults.thinking_level : levels.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : levels[0] ?? null,
          input: [
            { type: "text", text: text || (images.length ? "Please describe this image." : ""), text_elements: [] },
            ...images.map((image) => ({ type: "image" as const, url: `data:${image.mimeType};base64,${image.data}` })),
          ],
        };
        if (!session.submitted) {
          // Persist before submitting: a process failure must not forget an uncertain execution.
          this.saveMapping(agent.id, session.threadId, true);
          session.submitted = true;
        }
        const response = await this.request<TurnStartResponse>("turn/start", params);
        if (!response.turn.id) throw new AppError(502, "Codex did not start a turn.");
        state.turnId = response.turn.id;
        state.acknowledge();
        if (state.cancelled) await this.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
        for (const [method, notification] of state.early.splice(0)) this.handleTurnNotification(state, method, notification);
        if (this.active.get(state.threadId) === state && response.turn.status !== "inProgress") this.completed(state, response.turn);
        if (this.active.get(state.threadId) === state) {
          state.timer = setTimeout(() => { void this.interrupt(state!, "Codex took too long to finish. The request was cancelled; send a new message to continue.").catch(() => {}); }, this.turnTimeoutMs);
          state.timer.unref();
        }
      } catch (error) {
        if (state) this.finish(state, new AppError(error instanceof AppError ? error.status : 400, this.sanitizeError(error)));
        else { release?.(); throw error; }
      } finally { this.preparing--; }
      try { return await state!.done; } finally {
        // An unconfirmed interrupt rejects the caller but still owns the native turn.
        // Keep its process lease until Codex reports the actual terminal event.
        if (state && this.active.get(state.threadId) === state)
          void state.terminal.then(() => release?.());
        else release?.();
      }
    }).catch((error) => { throw new AppError(error instanceof AppError ? error.status : 400, this.sanitizeError(error)); });
    this.pending.set(agent.id, operation);
    void operation.finally(() => { if (this.pending.get(agent.id) === operation) this.pending.delete(agent.id); }).catch(() => {});
    return operation;
  }

  private notification(method: string, params: any) {
    if (method === "account/updated") this.revision++;
    const state = this.active.get(params?.threadId);
    if (!state) return;
    if (!state.turnId) {
      if (state.early.length < 10_000) state.early.push([method, params]);
      else this.finish(state, new AppError(502, "Codex sent too many events before acknowledging the turn."));
      return;
    }
    this.handleTurnNotification(state, method, params);
  }

  private handleTurnNotification(state: Active, method: string, params: any) {
    if (this.active.get(state.threadId) !== state || (params?.turnId ?? params?.turn?.id) !== state.turnId) return;
    if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const message = state.messages.get(params.itemId) ?? { text: "", completed: false };
      if (!message.completed) message.text += params.delta;
      state.messages.set(params.itemId, message);
    }
    if (method === "item/started" || method === "item/completed") this.item(state, params.item, method === "item/completed");
    if (method === "error" && !params.willRetry)
      // Keep the active slot until turn/completed so a new request cannot steer failed work.
      state.reject(new AppError(400, this.sanitizeError(params.error?.message ?? "The Codex request failed.")));
    if (method === "turn/completed") this.completed(state, params.turn);
  }

  private item(state: Active, item: ThreadItem, completed: boolean) {
    if (item?.type !== "agentMessage") return;
    const prior = state.messages.get(item.id);
    state.messages.set(item.id, {
      text: completed ? item.text : prior?.text || item.text,
      phase: item.phase, completed,
    });
  }

  private completed(state: Active, turn: Turn) {
    if (turn.status !== "completed" || state.cancelled) {
      this.finish(state, new AppError(400, state.cancelled || turn.status === "interrupted"
        ? "The Agent request was cancelled. Send a new message to continue."
        : this.sanitizeError(turn.error?.message ?? "The Codex request failed.")));
      return;
    }
    for (const item of turn.items ?? []) this.item(state, item, true);
    const final = [...state.messages.values()].filter((message) => message.phase !== "commentary");
    const text = final.map((message) => message.text).filter(Boolean).join("\n\n");
    const limitation = state.approvalDenied ? "This request required an operation that the service cannot approve. Shell, file changes, and external tool access are unavailable." : "";
    this.finish(state, undefined, { text: [text, limitation].filter(Boolean).join("\n\n"), images: [...state.outputImages] });
  }

  private finish(state: Active, error?: Error, reply?: RuntimeReply) {
    if (this.active.get(state.threadId) !== state) return;
    clearTimeout(state.timer);
    this.active.delete(state.threadId);
    state.acknowledge();
    state.terminate();
    if (error) state.reject(error);
    else state.resolve(reply ?? { text: "", images: [] });
  }

  private async toolCall(method: string, params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const fail = (text: string): DynamicToolCallResponse => ({ success: false, contentItems: [{ type: "inputText", text }] });
    if (method !== "item/tool/call" || params?.tool !== "send_image" || params.namespace) return fail("This tool is unavailable.");
    const state = this.active.get(params.threadId);
    if (!state || state.cancelled || (state.turnId && state.turnId !== params.turnId)) return fail("The Agent turn is no longer active.");
    // Tool requests may race the turn/start response. Correlate before attaching side effects.
    if (!state.turnId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([state.acknowledged, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.interruptTimeoutMs); timer.unref(); })]);
      } finally { clearTimeout(timer); }
    }
    if (this.active.get(params.threadId) !== state || state.cancelled || state.turnId !== params.turnId)
      return fail("The Agent turn is no longer active.");
    const args = params.arguments as { attachment_index?: unknown } | null;
    const index = args?.attachment_index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || !state.inputImages[index]) return fail("That image attachment is not present in the current message.");
    const image = state.inputImages[index];
    if (!state.outputImages.includes(image)) state.outputImages.push(image);
    return { success: true, contentItems: [{ type: "inputText", text: "Image queued for delivery to the owner." }] };
  }

  private async interrupt(state: Active, message = "The Agent request was cancelled.") {
    state.cancelled = true;
    if (!state.turnId) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
      await Promise.race([
        state.terminal,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(503, "Codex has not confirmed cancellation. Wait before retrying this Agent.")), this.interruptTimeoutMs); timer.unref(); }),
      ]);
    } catch (error) {
      // Retain the active slot until the terminal event arrives; turn/start would otherwise steer it.
      state.reject(new AppError(503, message + " Codex has not confirmed cancellation."));
      throw error;
    } finally { clearTimeout(timer); }
  }

  private createActive(agentId: string, threadId: string, images: RuntimeImage[]): Active {
    let resolve!: Active["resolve"], reject!: Active["reject"], acknowledge!: () => void, terminate!: () => void;
    const done = new Promise<RuntimeReply>((yes, no) => { resolve = yes; reject = no; });
    const acknowledged = new Promise<void>((yes) => { acknowledge = yes; });
    const terminal = new Promise<void>((yes) => { terminate = yes; });
    void done.catch(() => {});
    const state: Active = { agentId, threadId, early: [], messages: new Map(), inputImages: images, outputImages: [], done, resolve, reject, acknowledged, acknowledge, terminal, terminate, cancelled: false, approvalDenied: false };
    this.active.set(threadId, state);
    return state;
  }

  async stopAgent(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const state = [...this.active.values()].find((item) => item.agentId === id);
    if (state) await this.interrupt(state);
    await this.pending.get(id)?.catch(() => {});
    this.sessions.delete(id);
  }

  async deactivate() {
    if (this.deactivation) return this.deactivation;
    this.deactivating = true;
    const operation = this.deactivateInternal();
    this.deactivation = operation;
    try { await operation; }
    finally { this.deactivating = false; this.deactivation = undefined; }
  }

  private async deactivateInternal() {
    await this.authQueue.catch(() => {});
    await this.authentication.cancel().catch(() => {});
    for (const id of this.pending.keys()) this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const state of this.active.values()) {
      state.cancelled = true;
      if (state.turnId) void this.client.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
    }
    await this.client.close();
    for (const state of [...this.active.values()]) this.finish(state, new AppError(409, "The Agent runtime was deactivated."));
    await Promise.allSettled([...this.pending.values(), ...this.loading.values()]);
    // A start already waiting for process retirement must also be settled before shutdown ends.
    await this.client.close();
    this.sessions.clear();
  }

  async close() {
    this.closed = true;
    await this.deactivate();
    await this.authentication.close();
  }

  sanitizeError(error: unknown): string {
    let message = this.authentication.sanitizeError(error);
    const secrets = new Set(this.submittedSecrets);
    if (this.processToken) secrets.add(this.processToken);
    try {
      const collect = (value: unknown) => {
        if (typeof value === "string" && value.length >= 6 && value !== "chatgpt" && value !== "apiKey") secrets.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      for (const path of [join(this.client.homeDir, "auth.json"), resolve(this.client.homeDir, "..", "siwc", "credentials.json")])
        if (existsSync(path)) collect(JSON.parse(readFileSync(path, "utf8")));
    } catch { /* Authentication may not have been configured yet. */ }
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) message = message.split(secret).join("[redacted]");
    return message.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  }
}
