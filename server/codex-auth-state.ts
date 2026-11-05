import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppError } from "./store.js";

export type CodexAuthMethod = "siwc" | "codex" | "apiKey";
export type CodexAccount = { type: string; email?: string | null; planType?: string };
type SavedState = { version: 1; selected: CodexAuthMethod; accounts: Partial<Record<CodexAuthMethod, CodexAccount>> };
export type NativeAuthCheckpoint = { native?: Buffer; codex?: Buffer; apiKey?: Buffer };

/** Only copies opaque native credentials. OAuth and token refresh remain native. */
export class CodexAuthState {
  readonly directory: string;
  readonly nativePath: string;
  private state?: SavedState;
  constructor(dataDir: string, homeDir: string) {
    this.directory = join(dataDir, "codex", "auth-connections");
    this.nativePath = join(homeDir, "auth.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }
  private atomic(path: string, bytes: string | Buffer) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o600); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private path(method: "codex" | "apiKey") { return join(this.directory, `${method}.json`); }
  private nativeMethod(): "codex" | "apiKey" | undefined {
    if (!existsSync(this.nativePath)) return;
    try {
      const value = JSON.parse(readFileSync(this.nativePath, "utf8"));
      if (value.auth_mode === "apikey" || value.auth_mode === "apiKey" || value.OPENAI_API_KEY) return "apiKey";
      if (value.auth_mode === "chatgpt" || value.tokens) return "codex";
    } catch { throw new AppError(503, "The native Codex credential file could not be read."); }
  }
  initialize(siwcConfigured: boolean) {
    if (this.state) return;
    const statePath = join(this.directory, "state.json");
    if (existsSync(statePath)) {
      try {
        const value = JSON.parse(readFileSync(statePath, "utf8"));
        if (value.version !== 1 || !["siwc", "codex", "apiKey"].includes(value.selected)) throw new Error();
        this.state = { version: 1, selected: value.selected, accounts: value.accounts ?? {} };
      } catch { throw new AppError(503, "The saved Codex authentication selection could not be read."); }
      return;
    }
    const native = this.nativeMethod();
    if (native) this.atomic(this.path(native), readFileSync(this.nativePath));
    // Existing SIWC stays selected. Cached native ChatGPT never activates implicitly.
    this.state = { version: 1, selected: siwcConfigured ? "siwc" : native === "apiKey" ? "apiKey" : "siwc", accounts: {} };
    this.save();
  }
  get selected() { return this.state!.selected; }
  configured(method: "codex" | "apiKey") { return existsSync(this.path(method)); }
  account(method: CodexAuthMethod) { return this.state!.accounts[method]; }
  setAccount(method: CodexAuthMethod, account: CodexAccount) { this.state!.accounts[method] = account; this.save(); }
  select(method: CodexAuthMethod) {
    const next: SavedState = {...this.state!, selected: method};
    this.atomic(join(this.directory, "state.json"), JSON.stringify(next));
    this.state = next;
  }
  private save() { this.atomic(join(this.directory, "state.json"), JSON.stringify(this.state)); }
  /** Call only after the native process has stopped and its execution leases drained. */
  snapshot() {
    const method = this.nativeMethod();
    if (method) this.atomic(this.path(method), readFileSync(this.nativePath));
  }
  /** Call only while the native process is stopped. */
  restore(method: "codex" | "apiKey") {
    if (!this.configured(method)) throw new AppError(400, "Sign in to this Codex connection before using it.");
    this.atomic(this.nativePath, readFileSync(this.path(method)));
  }
  clearNativeFile() { if (existsSync(this.nativePath)) unlinkSync(this.nativePath); }
  remove(method: "codex" | "apiKey") {
    const path = this.path(method);
    if (existsSync(path)) unlinkSync(path);
    delete this.state!.accounts[method];
    this.save();
  }
  checkpoint(): NativeAuthCheckpoint {
    const read = (path: string) => existsSync(path) ? readFileSync(path) : undefined;
    return { native: read(this.nativePath), codex: read(this.path("codex")), apiKey: read(this.path("apiKey")) };
  }
  restoreCheckpoint(checkpoint: NativeAuthCheckpoint) {
    for (const [path, bytes] of [[this.nativePath, checkpoint.native], [this.path("codex"), checkpoint.codex], [this.path("apiKey"), checkpoint.apiKey]] as const) {
      if (bytes) this.atomic(path, bytes);
      else if (existsSync(path)) unlinkSync(path);
    }
  }
  secretPaths() { return [this.nativePath, this.path("codex"), this.path("apiKey")]; }
}
