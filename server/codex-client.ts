import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import type { InitializeParams } from "./generated/codex/InitializeParams.js";
import type { InitializeResponse } from "./generated/codex/InitializeResponse.js";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type Options = {
  binary?: string;
  /** Override arguments for a test process; production uses the fixed safety configuration. */
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};
type RequestHandler = (method: string, params: any) => unknown | Promise<unknown>;

/** One restartable stdio app-server connection, shared by all Codex Agent threads. */
export class CodexClient extends EventEmitter {
  readonly homeDir: string;
  readonly cwd: string;
  private readonly isolatedHome: string;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private retiring?: Promise<void>;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private handler?: RequestHandler;
  private accessToken?: string;

  constructor(dataDir: string, private readonly options: Options = {}) {
    super();
    this.homeDir = resolve(dataDir, "codex", "home");
    this.cwd = resolve(dataDir, "codex", "workspace");
    this.isolatedHome = resolve(dataDir, "codex", "host-home");
    for (const directory of [this.homeDir, this.cwd, this.isolatedHome]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
  }

  setRequestHandler(handler: RequestHandler) {
    this.handler = handler;
  }

  /** The runtime drains turn leases before changing the provider's process credentials. */
  async setAccessToken(accessToken?: string) {
    if (accessToken === this.accessToken) return;
    this.accessToken = accessToken;
    await this.close();
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.retiring) await this.retiring;
    if (this.initialized && this.child) return;
    if (this.starting) return this.starting;
    const operation = this.launch();
    this.starting = operation;
    try {
      await operation;
    } finally {
      if (this.starting === operation) this.starting = undefined;
    }
  }

  private arguments() {
    const disabled = [
      "shell_tool", "shell_snapshot", "view_image", "browser_use", "browser_use_external",
      "computer_use", "image_generation", "apps", "plugins", "remote_plugin", "multi_agent",
      "hooks", "code_mode", "code_mode_host", "memories", "skill_search",
      "skill_mcp_dependency_install", "workspace_dependencies", "goals", "sleep_tool",
    ];
    return [
      "app-server", "--listen", "stdio://",
      "-c", 'sandbox_mode="read-only"',
      "-c", 'approval_policy="on-request"',
      "-c", 'web_search="live"',
      "-c", "project_doc_max_bytes=0",
      "-c", 'cli_auth_credentials_store="file"',
      "-c", 'shell_environment_policy.inherit="none"',
      ...disabled.flatMap((feature) => ["-c", `features.${feature}=false`]),
      "-c", "features.skip_host_skill_discovery=true",
      ...(this.accessToken ? [
        "-c", 'model_provider="openai_chatgpt_plan"',
        "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
        "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
        "-c", 'model_providers.openai_chatgpt_plan.env_key="FAMILY_CODEX_SIWC_TOKEN"',
        "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
        "-c", 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
        "-c", 'model_providers.openai_chatgpt_plan.supports_websockets=false',
      ] : ["-c", 'model_provider="openai"']),
    ];
  }

  private async launch() {
    // Do not inherit the desktop Codex account, plugins, MCP servers, or provider keys.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    env.HOME = this.isolatedHome;
    env.CODEX_HOME = this.homeDir;
    if (this.accessToken) env.FAMILY_CODEX_SIWC_TOKEN = this.accessToken;
    const child = spawn(this.options.binary ?? process.env.CODEX_BIN ?? "codex", this.options.args ?? this.arguments(), {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.initialized = false;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      // Image-bearing messages can be large, but protocol buffering must stay bounded.
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
        this.fail(child, new Error("Codex App Server exceeded the protocol message limit."));
        return;
      }
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        try {
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
          this.receive(child, message as Record<string, any>);
        } catch {
          this.fail(child, new Error("Codex App Server returned an invalid protocol message."));
          return;
        }
      }
    });
    // Native diagnostics may contain provider details. Drain stderr separately, never forward it.
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(child, new Error("Codex App Server connection was lost.")));
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.fail(child, new Error(error.code === "ENOENT"
        ? "Codex is not installed. Install the Codex CLI or set CODEX_BIN."
        : "Codex App Server could not start."));
    });
    child.once("exit", () => this.fail(child, new Error("Codex App Server disconnected. Send a new message to reconnect; the interrupted turn will not be replayed.")));
    const params: InitializeParams = {
      clientInfo: { name: "family_agents", title: "Family Agents", version: "2.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    try {
      await this.sendRequest<InitializeResponse>("initialize", params);
      if (this.child !== child) throw new Error("Codex App Server disconnected during initialization.");
      this.write(child, { method: "initialized" });
      this.initialized = true;
    } catch (error) {
      this.fail(child, error instanceof Error ? error : new Error("Codex initialization failed."));
      throw error;
    }
  }

  async request<T = unknown>(method: string, params: unknown = null): Promise<T> {
    await this.start();
    return this.sendRequest<T>(method, params);
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Codex App Server is disconnected."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out request may already have executed. Tear down the connection; never replay it.
        this.fail(child, new Error("Codex App Server request timed out. The operation was not retried."));
      }, this.options.requestTimeoutMs ?? 30_000);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write(child, { id, method, params });
      } catch {
        this.fail(child, new Error("Codex App Server connection was lost."));
      }
    });
  }

  private write(child: ChildProcessWithoutNullStreams, message: unknown) {
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(child: ChildProcessWithoutNullStreams, message: Record<string, any>) {
    if (typeof message.method === "string") {
      if (message.id !== undefined) void this.serverRequest(child, message);
      else this.emit("notification", message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      // Do not expose arbitrary native/provider error bodies containing credentials or reasoning.
      const error = new Error("Codex App Server rejected the request. Check its authentication and selected model.");
      Object.assign(error, { code: message.error.code });
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  private async serverRequest(child: ChildProcessWithoutNullStreams, message: Record<string, any>) {
    const { id, method, params } = message;
    let result: unknown;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")
      result = { decision: "decline" };
    else if (method === "item/permissions/requestApproval")
      result = { permissions: {}, scope: "turn" };
    else if (method === "execCommandApproval" || method === "applyPatchApproval")
      result = { decision: "denied" };
    else if (method === "item/tool/requestUserInput")
      result = { answers: {} };
    else if (method === "item/tool/call" && this.handler) {
      try {
        result = await this.handler(method, params);
      } catch {
        result = { success: false, contentItems: [{ type: "inputText", text: "This tool request is not supported." }] };
      }
      if (this.child === child) this.write(child, { id, result });
      return;
    } else {
      if (this.child === child) this.write(child, { id, error: { code: -32601, message: "This client does not support this server request." } });
      this.emit("approval-denied", params);
      return;
    }
    if (this.child === child) this.write(child, { id, result });
    this.emit("approval-denied", params);
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = undefined;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const retiring = this.terminate(child, false);
    this.retiring = retiring;
    void retiring.finally(() => {
      if (this.retiring === retiring) this.retiring = undefined;
    });
    this.emit("disconnect", error);
  }

  async close(): Promise<void> {
    if (this.stopping) return this.stopping;
    const operation = this.stop();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = undefined;
    }
  }

  private async stop() {
    if (this.retiring) await this.retiring;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex App Server was stopped."));
    }
    this.pending.clear();
    await this.terminate(child, true);
  }

  private terminate(child: ChildProcessWithoutNullStreams, graceful: boolean) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
        killTimer.unref();
      }, this.options.shutdownTimeoutMs ?? 3000);
      timer.unref();
      child.once("close", () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
      if (graceful) child.stdin.end();
      else child.kill("SIGTERM");
    });
  }
}
