import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexRuntime, type CodexConnection, type ChatGptAuthentication } from "./codex-runtime.js";

class FakeCodex extends EventEmitter implements CodexConnection {
  readonly homeDir: string;
  readonly cwd: string;
  calls: Array<{ method: string; params: any }> = [];
  handler!: (method: string, params: any) => unknown | Promise<unknown>;
  onTurn?: (params: any, id: string) => unknown | Promise<unknown>;
  authenticated = true;
  accountType: "apiKey" | "chatgpt" = "apiKey";
  accessToken?: string;
  providerChanges: Array<string | undefined> = [];
  rejectResume = false;
  closes = 0;
  turnCounter = 0;
  threadCounter = 0;
  readonly loadedThreads = new Set<string>();
  private loadedCredential?: string;
  constructor(dir: string) {
    super();
    this.homeDir = join(dir, "codex", "home");
    this.cwd = join(dir, "codex", "workspace");
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    writeFileSync(join(this.homeDir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-original-key" }));
    this.loadedCredential = readFileSync(join(this.homeDir, "auth.json"), "utf8");
  }
  async start() {
    const path = join(this.homeDir, "auth.json");
    const serialized = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const saved = serialized ? JSON.parse(serialized) : undefined;
    if (serialized !== this.loadedCredential) this.authenticated = !!saved;
    this.loadedCredential = serialized;
    if (saved) this.accountType = saved.auth_mode === "chatgpt" ? "chatgpt" : "apiKey";
  }
  async setAccessToken(token?: string) {
    if (this.accessToken === token) return;
    this.accessToken = token; this.providerChanges.push(token); await this.close();
  }
  setRequestHandler(handler: FakeCodex["handler"]) { this.handler = handler; }
  async close() { this.closes++; this.loadedThreads.clear(); }
  async request<T = unknown>(method: string, params: any = null): Promise<T> {
    this.calls.push({ method, params });
    let result: any = {};
    if (method === "account/read") result = { account: this.authenticated ? { type: this.accountType } : null, requiresOpenaiAuth: true };
    if (method === "model/list") result = { data: [{ id: "catalog-id", model: "codex-model", displayName: "Codex Model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "low", inputModalities: ["text", "image"], hidden: false }], nextCursor: null };
    if (method === "thread/start") result = { thread: { id: `thread-${++this.threadCounter}`, turns: [] } };
    if (method === "thread/fork") result = { thread: { id: `thread-${++this.threadCounter}`, turns: [] }, modelProvider: params.modelProvider };
    if (method === "thread/resume") {
      if (this.rejectResume) throw new Error("Saved conversation unavailable.");
      result = { thread: { id: params.threadId, turns: [] } };
    }
    if (result.thread) this.loadedThreads.add(result.thread.id);
    if (method === "thread/unsubscribe") result = { status: this.loadedThreads.delete(params.threadId) ? "unsubscribed" : "notLoaded" };
    if (method === "thread/loaded/list") result = { data: [...this.loadedThreads] };
    if (method === "turn/start") {
      const id = `turn-${++this.turnCounter}`;
      await this.onTurn?.(params, id);
      result = { turn: { id, status: "inProgress" } };
    }
    if (method === "turn/interrupt") this.complete(params.threadId, params.turnId, "", "interrupted");
    if (method === "account/login/start") {
      if (params.type === "apiKey") {
        this.authenticated = true;
        this.accountType = "apiKey";
        writeFileSync(join(this.homeDir, "auth.json"), JSON.stringify({auth_mode: "apikey", OPENAI_API_KEY: params.apiKey}));
      }
      result = params.type === "chatgpt" ? { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/example" }
        : params.type === "chatgptDeviceCode" ? { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" }
        : { type: "apiKey" };
    }
    if (method === "account/logout") { this.authenticated = false; if (existsSync(join(this.homeDir, "auth.json"))) unlinkSync(join(this.homeDir, "auth.json")); }
    return result as T;
  }
  notify(method: string, params: any) { this.emit("notification", method, params); }
  complete(threadId: string, turnId: string, text: string, status = "completed") {
    this.notify("turn/completed", { threadId, turn: { id: turnId, status, items: text ? [{ type: "agentMessage", id: "answer", text, phase: "final_answer" }] : [], error: status === "failed" ? { message: "Provider unavailable" } : null } });
  }
}
class FakeAuthentication extends EventEmitter implements ChatGptAuthentication {
  token?: string;
  revision = 0;
  beforeCommit?: (reason: "login" | "logout") => Promise<void | (() => void)>;
  state?: { status: string; loginId?: string; authUrl?: string; redirectUri?: string; prompt?: string };
  status() { return this.token ? { type: "chatgpt" as const, email: "fixture@example.org", subject: "subject", clientId: "client", auth_method: "siwc" as const } : null; }
  registrations() { return this.token ? [{id: "saved-account", email: "fixture@example.org", active: true}] : []; }
  version() { return String(this.revision); }
  async accessToken() { return this.token; }
  sanitizeError(error: unknown) { return error instanceof Error ? error.message : String(error); }
  async begin() {
    this.state = { status: "pending", loginId: "login-1", authUrl: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client", redirectUri: "http://127.0.0.1:1455/auth/callback", prompt: "callback_url" };
    return { type: "chatgpt" as const, loginId: "login-1", authUrl: this.state.authUrl!, redirectUri: this.state.redirectUri! };
  }
  async submit(loginId: string, callbackUrl: string) {
    assert.equal(loginId, "login-1"); assert.match(callbackUrl, /auth\/callback/);
    const release = await this.beforeCommit?.("login");
    try { this.token = "fixture-siwc-access-token"; this.revision++; this.state = {status: "complete", loginId}; this.emit("changed", "login"); }
    finally { release?.(); }
  }
  loginStatus() { return this.state; }
  async logout() {
    const release = await this.beforeCommit?.("logout");
    try { this.token = undefined; this.revision++; this.emit("changed", "logout"); return {revocationConfirmed: true}; }
    finally { release?.(); }
  }
  async cancel() { if (this.state?.status === "pending") this.state = {...this.state, status: "cancelled"}; }
  async close() { await this.cancel(); }
}
const defaults = { provider: "codex", model: "codex-model", thinking_level: "ultra" };
const generatedPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
function fixture(options: { turnTimeoutMs?: number; interruptTimeoutMs?: number; loginTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "family-codex-runtime-"));
  const client = new FakeCodex(dir), authentication = new FakeAuthentication(), runtime = new CodexRuntime(dir, { client, authentication, ...options });
  authentication.beforeCommit = (reason) => (runtime as any).beforeCredentialCommit(reason);
  return { dir, client, authentication, runtime, async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitFor(condition: () => boolean) {
  for (let count = 0; count < 100; count++) { if (condition()) return; await delay(1); }
  assert.fail("Expected protocol request did not arrive.");
}

test("native generated images survive early completion and are delivered once per item", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, turnId) => {
      const item = { type: "imageGeneration", id: "generated-1", status: "completed", result: generatedPng, revisedPrompt: null, generationId: null, failure: null };
      f.client.notify("item/completed", { threadId: params.threadId, turnId, item });
      f.client.notify("item/completed", { threadId: params.threadId, turnId, item });
      f.client.notify("turn/completed", { threadId: params.threadId, turn: { id: turnId, status: "completed", items: [item] } });
    };
    const reply = await f.runtime.run({ id: "a" }, defaults, "Draw a small image.");
    assert.equal(reply.images.length, 1);
    assert.equal(reply.images[0].data, generatedPng);
    assert.equal(reply.images[0].mimeType, "image/png");
  } finally { await f.close(); }
});

test("generated image events obey active turn ownership, cancellation, and SIWC availability", async () => {
  const f = fixture();
  try {
    const a = f.runtime.run({ id: "a" }, defaults, "Draw A.");
    const b = f.runtime.run({ id: "b" }, defaults, "Draw B.");
    await waitFor(() => f.client.calls.filter((call) => call.method === "turn/start").length === 2);
    const calls = f.client.calls.filter((call) => call.method === "turn/start");
    const image = { type: "imageGeneration", id: "generated", status: "completed", result: generatedPng };
    f.client.notify("item/completed", { threadId: calls[0].params.threadId, turnId: "turn-2", item: image });
    f.client.notify("item/completed", { threadId: calls[1].params.threadId, turnId: "turn-2", item: image });
    await f.runtime.stopAgent("b");
    await assert.rejects(b, /cancelled/);
    f.client.notify("item/completed", { threadId: calls[1].params.threadId, turnId: "turn-2", item: image });
    f.client.complete(calls[0].params.threadId, "turn-1", "No image for A.");
    assert.deepEqual((await a).images, []);
    const account = await f.runtime.account();
    await f.runtime.login({ type: "chatgpt", version: account.version });
    await f.runtime.submitLogin({ version: (await f.runtime.account()).version, loginId: "login-1", callbackUrl: "http://127.0.0.1:1455/auth/callback" });
    f.client.onTurn = (params, turnId) => {
      f.client.notify("item/completed", { threadId: params.threadId, turnId, item: image });
      f.client.complete(params.threadId, turnId, "The selected connection has no native image generation.");
    };
    assert.deepEqual((await f.runtime.run({ id: "a" }, defaults, "Draw again.")).images, []);
  } finally { await f.close(); }
});

test("invalid generated bytes and untrusted artifact paths never become outbound images", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, turnId) => {
      for (const item of [
        { type: "imageGeneration", id: "invalid", status: "completed", result: Buffer.from("private text").toString("base64") },
        { type: "imageGeneration", id: "private-path", status: "completed", fileId: "file", savedPath: join(f.client.homeDir, "auth.json") },
      ]) f.client.notify("item/completed", { threadId: params.threadId, turnId, item });
      f.client.complete(params.threadId, turnId, "Finished.");
    };
    const reply = await f.runtime.run({ id: "a" }, defaults, "Draw something.");
    assert.deepEqual(reply.images, []);
    assert.match(reply.text, /could not be delivered/);
    assert.doesNotMatch(reply.text, /auth.json|fixture-original-key/);
  } finally { await f.close(); }
});

test("a reply bounds generated-image count without dropping earlier valid images", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, turnId) => {
      for (let index = 0; index < 5; index++) f.client.notify("item/completed", {
        threadId: params.threadId, turnId,
        item: { type: "imageGeneration", id: `image-${index}`, status: "completed", result: generatedPng },
      });
      f.client.complete(params.threadId, turnId, "Generated images.");
    };
    const reply = await f.runtime.run({ id: "a" }, defaults, "Create several images.");
    assert.equal(reply.images.length, 4);
    assert.match(reply.text, /could not be delivered/);
  } finally { await f.close(); }
});

test("Codex models and reasoning levels use native metadata without Pi assumptions", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.runtime.models(), [{ provider: "codex", id: "codex-model", name: "Codex Model", thinking_levels: ["low", "ultra"], available: true }]);
    assert.deepEqual(await f.runtime.selection({ ...defaults, thinking_level: "max" }), { thinking_level: "low", thinking_levels: ["low", "ultra"] });
    await assert.rejects(f.runtime.validate({ ...defaults, model: "invented" }), /available Codex model/);
    f.client.authenticated = false;
    await assert.rejects(f.runtime.validate(defaults), /authentication/);
  } finally { await f.close(); }
});

test("early streaming completion returns final text only and preserves image input and citations", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, id) => {
      f.client.notify("item/agentMessage/delta", { threadId: params.threadId, turnId: id, itemId: "answer", delta: "partial" });
      f.client.notify("item/completed", { threadId: params.threadId, turnId: id, item: { type: "reasoning", id: "private", summary: ["secret"] } });
      f.client.notify("item/completed", { threadId: params.threadId, turnId: id, item: { type: "agentMessage", id: "commentary", text: "Internal progress", phase: "commentary" } });
      f.client.complete(params.threadId, id, "Final [source](https://example.org)");
    };
    const reply = await f.runtime.run({ id: "a", instructions: "Agent A only" }, defaults, "What is this?", [{ data: "aGVsbG8=", mimeType: "image/png" }]);
    assert.equal(reply.text, "Final [source](https://example.org)");
    const turn = f.client.calls.find((call) => call.method === "turn/start")!.params;
    assert.deepEqual(turn.input[1], { type: "image", url: "data:image/png;base64,aGVsbG8=" });
    assert.equal(turn.permissions, "family_agent");
    assert.equal(turn.sandboxPolicy, undefined);
    const start = f.client.calls.find((call) => call.method === "thread/start")!.params;
    assert.match(start.developerInstructions, /Agent A only/);
    assert.equal(start.config.web_search, "live");
    assert.equal(start.approvalPolicy, "on-request");
    assert.equal(start.permissions, "family_agent");
    assert.deepEqual(start.runtimeWorkspaceRoots, [start.cwd]);
    assert.equal(start.dynamicTools[0].name, "send_image");
    const mapping = join(f.dir, "codex", "agents", "a", "thread.json");
    assert.equal(statSync(mapping).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(mapping, "utf8")).threadId, "thread-1");
  } finally { await f.close(); }
});

test("persistent Codex threads resume after deactivation and never silently replace missing history", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "First reply");
    await f.runtime.run({ id: "a", instructions: "First" }, defaults, "First message");
    await f.runtime.deactivate();
    await f.runtime.initializeAgent({ id: "a", instructions: "Updated" }, defaults);
    const resume = f.client.calls.find((call) => call.method === "thread/resume")!.params;
    assert.equal(resume.threadId, "thread-1");
    assert.match(resume.developerInstructions, /Updated/);
    await f.runtime.deactivate();
    f.client.rejectResume = true;
    await assert.rejects(f.runtime.initializeAgent({ id: "a" }, defaults), /unavailable/);
    assert.equal(f.client.calls.filter((call) => call.method === "thread/start").length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "codex", "agents", "a", "thread.json"), "utf8")).threadId, "thread-1");
  } finally { await f.close(); }
});

test("Matrix threads keep separate Codex history while the Agent's main conversation survives", async () => {
  const f = fixture();
  const main = { id: "a" };
  const budget = { ...main, conversationId: "1".repeat(64), initialContext: "Earlier root context: Budget" };
  const travel = { ...main, conversationId: "2".repeat(64), initialContext: "Earlier root context: Travel" };
  try {
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Answer");
    await f.runtime.run(main, defaults, "Main topic");
    await f.runtime.run(budget, defaults, "What about groceries?");
    await f.runtime.run(travel, defaults, "What about hotels?");
    assert.deepEqual([...f.client.loadedThreads].sort(), ["thread-1", "thread-3"]);
    await f.runtime.run(budget, defaults, "Compare with last month");
    assert.deepEqual([...f.client.loadedThreads].sort(), ["thread-1", "thread-2"]);

    await f.runtime.stopAgent(main.id);
    assert.equal(f.client.loadedThreads.size, 0);
    await f.runtime.deactivate();
    await f.runtime.initializeAgent(main, defaults);
    assert.deepEqual([...f.client.loadedThreads], ["thread-1"]);
    await f.runtime.run(travel, defaults, "Compare with flights");
    await f.runtime.run(main, defaults, "Continue main topic");
    const turns = f.client.calls.filter((call) => call.method === "turn/start");
    assert.deepEqual(turns.map(({ params }) => [params.threadId, params.input[0].text]), [
      ["thread-1", "Main topic"],
      ["thread-2", "Earlier root context: Budget\n\nWhat about groceries?"],
      ["thread-3", "Earlier root context: Travel\n\nWhat about hotels?"],
      ["thread-2", "Compare with last month"],
      ["thread-3", "Compare with flights"],
      ["thread-1", "Continue main topic"],
    ]);
    const agentDir = join(f.dir, "codex", "agents", main.id);
    assert.equal(JSON.parse(readFileSync(join(agentDir, "thread.json"), "utf8")).threadId, "thread-1");
    for (const [conversation, nativeThread] of [[budget, "thread-2"], [travel, "thread-3"]] as const) {
      const dir = join(agentDir, "threads", conversation.conversationId);
      const mapping = join(dir, "thread.json");
      assert.equal(statSync(mapping).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(mapping, "utf8")).threadId, nativeThread);
      assert.ok(turns.filter(({ params }) => params.threadId === nativeThread).every(({ params }) => params.cwd === join(dir, "workspace")));
    }
    assert.equal(f.client.threadCounter, 3);
  } finally { await f.close(); }
});

test("stopping an Agent cancels queued Matrix threads and releases the active one before fresh work", async () => {
  const f = fixture();
  const active = { id: "a", conversationId: "1".repeat(64) };
  const sibling = { ...active, conversationId: "2".repeat(64) };
  try {
    const interrupted = assert.rejects(f.runtime.run(active, defaults, "Active topic"), /cancelled/);
    const cancelled = assert.rejects(f.runtime.run(sibling, defaults, "Previously queued topic"), /cancelled/);
    await waitFor(() => f.client.turnCounter === 1);
    assert.equal(f.client.threadCounter, 1);
    const stopping = f.runtime.stopAgent(active.id);
    const fresh = f.runtime.run(sibling, defaults, "Fresh topic after Stop");
    await Promise.all([interrupted, cancelled, stopping]);
    await waitFor(() => f.client.turnCounter === 2);
    assert.deepEqual([...f.client.loadedThreads], ["thread-2"]);
    f.client.complete("thread-2", "turn-2", "Fresh reply");
    assert.equal((await fresh).text, "Fresh reply");
    assert.deepEqual(f.client.calls.filter((call) => call.method === "turn/start")
      .map(({ params }) => params.input[0].text), ["Active topic", "Fresh topic after Stop"]);
  } finally { await f.close(); }
});

test("concurrent Agents isolate turns and only return attachments from the requesting turn", async () => {
  const f = fixture();
  try {
    const image = { data: "aGVsbG8=", mimeType: "image/png" };
    const a = f.runtime.run({ id: "a" }, defaults, "A", [image]);
    const b = f.runtime.run({ id: "b" }, defaults, "B");
    await waitFor(() => f.client.turnCounter === 2);
    const turns = f.client.calls.filter((call) => call.method === "turn/start");
    const threadA = turns[0].params.threadId, threadB = turns[1].params.threadId;
    f.client.notify("item/agentMessage/delta", { threadId: threadA, turnId: "foreign-turn", itemId: "wrong", delta: "Leaked" });
    const tool = await f.client.handler("item/tool/call", { threadId: threadA, turnId: "turn-1", namespace: null, tool: "send_image", arguments: { attachment_index: 0 } }) as any;
    assert.equal(tool.success, true);
    const foreign = await f.client.handler("item/tool/call", { threadId: threadB, turnId: "turn-1", namespace: null, tool: "send_image", arguments: { attachment_index: 0 } }) as any;
    assert.equal(foreign.success, false);
    f.client.complete(threadB, "turn-2", "B answer");
    f.client.complete(threadA, "turn-1", "A answer");
    assert.deepEqual(await a, { text: "A answer", images: [image] });
    assert.deepEqual(await b, { text: "B answer", images: [] });
  } finally { await f.close(); }
});

test("stopping one Agent interrupts only its turn while another Agent completes", async () => {
  const f = fixture();
  try {
    const a = f.runtime.run({ id: "a" }, defaults, "A");
    const rejected = assert.rejects(a, /cancelled/);
    const b = f.runtime.run({ id: "b" }, defaults, "B");
    await waitFor(() => f.client.turnCounter === 2);
    await f.runtime.stopAgent("a");
    await rejected;
    assert.deepEqual(f.client.calls.find((call) => call.method === "turn/interrupt")!.params, { threadId: "thread-1", turnId: "turn-1" });
    assert.equal(f.client.closes, 0);
    f.client.complete("thread-2", "turn-2", "Still running");
    assert.equal((await b).text, "Still running");
  } finally { await f.close(); }
});

test("Codex crashes fail active turns and reconnect only for fresh input without replay", async () => {
  const f = fixture();
  try {
    const old = f.runtime.run({ id: "a" }, defaults, "Old");
    const failed = assert.rejects(old, /not replayed/);
    await waitFor(() => f.client.turnCounter === 1);
    f.client.emit("disconnect", new Error("Crash"));
    await failed;
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Fresh answer");
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "Fresh")).text, "Fresh answer");
    assert.equal(f.client.calls.filter((call) => call.method === "turn/start").length, 2);
    assert.equal(f.client.calls.filter((call) => call.method === "thread/resume").length, 1);
  } finally { await f.close(); }
});

test("authentication rejects stale writes, keeps provider secrets private, and uses app-owned SIWC", async () => {
  const f = fixture();
  try {
    const account = await f.runtime.account();
    await f.runtime.login({ type: "apiKey", apiKey: "sk-secret-key-do-not-show", version: account.version });
    await assert.rejects(f.runtime.logout(account.version), { status: 409 });
    assert.equal(f.runtime.sanitizeError("Bad key sk-secret-key-do-not-show"), "Bad key [redacted]");
    let fresh = await f.runtime.account();
    await f.runtime.login({ type: "chatgpt", version: fresh.version });
    assert.equal((await f.runtime.account()).login?.status, "pending");
    fresh = await f.runtime.account();
    await f.runtime.submitLogin({loginId: "login-1", callbackUrl: "http://127.0.0.1:1455/auth/callback?code=fixture", version: fresh.version});
    assert.equal((await f.runtime.account()).login?.status, "complete");
    assert.equal((await f.runtime.account()).auth_method, "siwc");
    assert.equal(f.client.calls.filter((call) => call.method === "account/login/start" && call.params.type !== "apiKey").length, 0);
    fresh = await f.runtime.account();
    const turn = f.runtime.run({ id: "a" }, defaults, "Busy");
    const failed = assert.rejects(turn, /cancelled/);
    await waitFor(() => f.client.turnCounter === 1);
    await assert.rejects(f.runtime.logout(fresh.version), { status: 409 });
    await f.runtime.stopAgent("a");
    await failed;
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({ tokens: { access_token: "private-access-token" } }));
    assert.equal(f.runtime.sanitizeError("Oops private-access-token"), "Oops [redacted]");
  } finally { await f.close(); }
});

test("failed turns reject their caller and denied approvals report a service limitation", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "", "failed");
    await assert.rejects(f.runtime.run({ id: "a" }, defaults, "Fail"), /Provider unavailable/);
    f.client.onTurn = (params, id) => {
      f.client.emit("approval-denied", { threadId: params.threadId, turnId: id });
      f.client.complete(params.threadId, id, "Answer");
    };
    assert.match((await f.runtime.run({ id: "a" }, defaults, "Needs permission")).text, /cannot approve/);
  } finally { await f.close(); }
});

test("a dynamic image tool can arrive before turn/start acknowledgement", async () => {
  const f = fixture();
  try {
    let tool: Promise<any> | undefined;
    f.client.onTurn = (params, id) => {
      tool = Promise.resolve(f.client.handler("item/tool/call", { threadId: params.threadId, turnId: id, namespace: null, tool: "send_image", arguments: { attachment_index: 0 } }));
      void tool.then(() => f.client.complete(params.threadId, id, "Returned attachment"));
    };
    const image = { data: "aGVsbG8=", mimeType: "image/png" };
    const result = await f.runtime.run({ id: "a" }, defaults, "Return the image", [image]);
    assert.equal((await tool).success, true);
    assert.deepEqual(result.images, [image]);
  } finally { await f.close(); }
});

test("a rejected interrupt fails the caller and retains the turn slot until completion", async () => {
  const f = fixture();
  try {
    const nativeRequest = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "turn/interrupt") throw new Error("Cancellation unavailable");
      return nativeRequest<T>(method, params);
    };
    const turn = f.runtime.run({ id: "a" }, defaults, "Start");
    const failed = assert.rejects(turn, /not confirmed cancellation/);
    await waitFor(() => f.client.turnCounter === 1);
    await assert.rejects(f.runtime.stopAgent("a"), /Cancellation unavailable/);
    await failed;
    await assert.rejects(f.runtime.run({ id: "a" }, defaults, "Unsafe retry"), /already has an active/);
    await assert.rejects(f.runtime.run({ id: "a", conversationId: "1".repeat(64) }, defaults, "Unsafe sibling"), /already has an active/);
    assert.equal(f.client.turnCounter, 1, "never steer a turn whose cancellation is unconfirmed");
    f.client.complete("thread-1", "turn-1", "", "interrupted");
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Recovered");
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "Fresh")).text, "Recovered");
  } finally { await f.close(); }
});

test("a Stop before turn acknowledgement bounds the cancellation wait without releasing the turn", async () => {
  const f = fixture({ interruptTimeoutMs: 5 });
  let acknowledge!: () => void;
  const delayed = new Promise<void>((resolve) => { acknowledge = resolve; });
  try {
    f.client.onTurn = () => delayed;
    const nativeRequest = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "turn/interrupt") return {} as T;
      return nativeRequest<T>(method, params);
    };
    const failed = assert.rejects(f.runtime.run({ id: "a" }, defaults, "Start"), /not confirmed cancellation/);
    await waitFor(() => f.client.turnCounter === 1);
    const stopping = assert.rejects(f.runtime.stopAgent("a"), /active Codex turn/);
    acknowledge();
    await Promise.all([failed, stopping, delay(30)]);
    await assert.rejects(f.runtime.run({ id: "a", conversationId: "1".repeat(64) }, defaults, "Unsafe sibling"), /already has an active/);
    f.client.complete("thread-1", "turn-1", "", "interrupted");
  } finally { acknowledge(); await f.close(); }
});

test("turn timeouts cancel without replaying the prompt", async () => {
  const f = fixture({ turnTimeoutMs: 5 });
  try {
    const request = f.runtime.run({ id: "a" }, defaults, "Too slow");
    await Promise.all([assert.rejects(request, /cancelled/), delay(30)]);
    assert.equal(f.client.calls.filter((call) => call.method === "turn/start").length, 1);
    assert.equal(f.client.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  } finally { await f.close(); }
});

test("an actually active resumed thread is interrupted before fresh input", async () => {
  const f = fixture();
  try {
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "First reply");
    await f.runtime.run({ id: "a" }, defaults, "First message");
    await f.runtime.deactivate();
    const nativeRequest = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/resume") return { thread: { id: "thread-1", status: { type: "active", activeFlags: [] }, turns: [{ id: "old-turn", status: "inProgress" }] } } as T;
      return nativeRequest<T>(method, params);
    };
    await f.runtime.initializeAgent({ id: "a" }, defaults);
    assert.deepEqual(f.client.calls.find((call) => call.method === "turn/interrupt")!.params, { threadId: "thread-1", turnId: "old-turn" });
    assert.equal(f.client.turnCounter, 1);
  } finally { await f.close(); }
});

test("unused Agents defer thread creation until first input because empty native threads have no rollout", async () => {
  const f = fixture();
  try {
    await f.runtime.initializeAgent({ id: "a" }, defaults);
    await f.runtime.deactivate();
    await f.runtime.initializeAgent({ id: "a" }, defaults);
    assert.equal(f.client.threadCounter, 0);
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Created on first turn");
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "First")).text, "Created on first turn");
    assert.equal(f.client.threadCounter, 1);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "codex", "agents", "a", "thread.json"), "utf8")).submitted, true);
  } finally { await f.close(); }
});

test("cached native ChatGPT credentials require explicit selection before authorizing turns", async () => {
  const f = fixture();
  try {
    f.client.accountType = "chatgpt";
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-native-token"}}));
    const account = await f.runtime.account();
    const beforeCapabilityRead = f.client.calls.length;
    assert.equal(f.runtime.nativeWebSearchAvailable(), false);
    assert.equal(f.client.calls.length, beforeCapabilityRead, "capability checks must not acquire a nested model lease");
    assert.equal(account.authenticated, false); assert.equal(account.auth_method, "siwc");
    assert.equal(account.connections.codex.configured, true);
    await assert.rejects(f.runtime.run({id: "a"}, defaults, "Never legacy"), /authentication/);
    assert.equal(f.client.turnCounter, 0);
    await f.runtime.selectAuthMethod({method: "codex", version: (await f.runtime.account()).version});
    assert.equal((await f.runtime.account()).auth_method, "codex");
    assert.equal((await f.runtime.account()).authenticated, true);
    assert.equal(f.runtime.nativeWebSearchAvailable(), true);
  } finally { await f.close(); }
});

test("briefing search evidence requires completed nonempty structured results rather than a search attempt", async () => {
  const f = fixture();
  try {
    let results: unknown = null;
    f.client.onTurn = (params, turnId) => {
      f.client.notify("item/started", { threadId: params.threadId, turnId, item: { type: "webSearch", id: "search", results: [{ shouldNotCount: true }] } });
      f.client.notify("item/completed", { threadId: params.threadId, turnId, item: { type: "webSearch", id: "search", results } });
      f.client.complete(params.threadId, turnId, "Search handled.");
    };
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "Denied search")).usedWebSearch, undefined);
    results = [];
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "No results")).usedWebSearch, undefined);
    results = [{ url: "https://example.org/current-news", title: "Current source" }];
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "Search succeeded")).usedWebSearch, true);
  } finally { await f.close(); }
});

test("deactivation waits for preparation and never resurrects the native process", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starting = false;
  f.client.start = async () => { starting = true; await gate; };
  try {
    const turn = f.runtime.run({ id: "a" }, defaults, "Preparing");
    const failed = assert.rejects(turn, /stopping/);
    await waitFor(() => starting);
    const deactivation = f.runtime.deactivate();
    await waitFor(() => f.client.closes >= 1);
    release();
    await deactivation;
    await failed;
    assert.equal(f.client.calls.length, 0, "preparation must stop before sending any native request");
    assert.ok(f.client.closes >= 2, "any startup already in progress is settled before deactivation ends");
  } finally { release(); await f.close(); }
});

test("empty unsubmitted thread mappings are safely replaced while submitted history remains protected", async () => {
  const f = fixture();
  try {
    const dir = join(f.dir, "codex", "agents", "a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "thread.json"), JSON.stringify({ version: 1, threadId: "empty-native-thread", submitted: false }));
    f.client.rejectResume = true;
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Fresh conversation");
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "First input")).text, "Fresh conversation");
    assert.equal(f.client.calls.filter((call) => call.method === "thread/resume").length, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "thread.json"), "utf8")).submitted, true);
  } finally { await f.close(); }
});


test("SIWC refresh drains existing turn leases before restarting and resuming native threads", async () => {
  const f = fixture();
  try {
    f.authentication.token = "first-access-token";
    const first = f.runtime.run({id: "a"}, defaults, "First");
    await waitFor(() => f.client.turnCounter === 1);
    assert.equal(f.client.accessToken, "first-access-token");
    const closes = f.client.closes;
    f.authentication.token = "rotated-access-token"; f.authentication.revision++;
    const second = f.runtime.run({id: "b"}, defaults, "Second");
    await delay(5);
    assert.equal(f.client.turnCounter, 1); assert.equal(f.client.closes, closes);
    f.client.complete("thread-1", "turn-1", "First done"); await first;
    await waitFor(() => f.client.turnCounter === 2);
    assert.equal(f.client.accessToken, "rotated-access-token");
    assert.equal(f.client.closes, closes + 1);
    f.client.complete("thread-2", "turn-2", "Second done"); await second;
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Resumed");
    await f.runtime.run({id: "a"}, defaults, "Resume");
    const resume = f.client.calls.find((call) => call.method === "thread/resume");
    assert.equal(resume?.params.threadId, "thread-1"); assert.equal(resume?.params.modelProvider, "openai_chatgpt_plan");
    assert.equal(f.client.calls.filter((call) => call.method === "turn/start").length, 3, "no old turn was replayed");
  } finally { await f.close(); }
});

test("committed SIWC authorization notifies Manager without exposing the access token", async () => {
  const f = fixture(); let changes = 0;
  f.runtime.onAuthenticationChanged = () => { changes++; };
  try {
    let account = await f.runtime.account();
    await f.runtime.login({type: "chatgpt", version: account.version});
    account = await f.runtime.account();
    assert.equal(account.login?.prompt, "callback_url");
    await f.runtime.submitLogin({loginId: "login-1", callbackUrl: "http://127.0.0.1:1455/auth/callback?code=x", version: account.version});
    await delay(1);
    assert.equal(changes, 1);
    assert.equal((await f.runtime.account()).auth_method, "siwc");
    assert.doesNotMatch(JSON.stringify(await f.runtime.account()), /fixture-siwc-access-token/);
  } finally { await f.close(); }
});


test("token replacement waits for both Agents while stop can interrupt an existing turn", async () => {
  const f = fixture();
  try {
    f.authentication.token = "first-access-token";
    const first = f.runtime.run({id: "a"}, defaults, "First");
    const cancelled = assert.rejects(first, /cancelled/);
    const second = f.runtime.run({id: "b"}, defaults, "Second");
    await waitFor(() => f.client.turnCounter === 2);
    f.authentication.token = "new-access-token"; f.authentication.revision++;
    const third = f.runtime.run({id: "c"}, defaults, "Third");
    await delay(5);
    await f.runtime.stopAgent("a"); await cancelled;
    assert.equal(f.client.turnCounter, 2, "the other Agent still owns its process lease");
    assert.equal(f.client.accessToken, "first-access-token");
    f.client.complete("thread-2", "turn-2", "Second complete"); await second;
    await waitFor(() => f.client.turnCounter === 3);
    assert.equal(f.client.accessToken, "new-access-token");
    f.client.complete("thread-3", "turn-3", "Third complete"); await third;
    assert.equal(f.client.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  } finally { await f.close(); }
});

test("stopping during a queued token replacement cannot resurrect the child process", async () => {
  const f = fixture();
  try {
    f.authentication.token = "first-access-token";
    const first = f.runtime.run({id: "a"}, defaults, "First");
    const cancelled = assert.rejects(first, /cancelled/);
    await waitFor(() => f.client.turnCounter === 1);
    f.authentication.token = "new-access-token"; f.authentication.revision++;
    const queued = f.runtime.run({id: "b"}, defaults, "Queued");
    const stopped = assert.rejects(queued, /stopping/);
    await delay(5); await f.runtime.deactivate(); await cancelled; await stopped;
    assert.deepEqual(f.client.providerChanges, ["first-access-token"]);
    assert.equal(f.client.turnCounter, 1);
  } finally { await f.close(); }
});

test("automatic SIWC completion drains an old turn and notifies recovery after its guard is released", async () => {
  const f = fixture();
  const guards: boolean[] = [];
  f.runtime.onAuthenticationChanged = () => { guards.push((f.runtime as any).authChanging); };
  try {
    await f.runtime.login({type: "chatgpt", version: (await f.runtime.account()).version});
    const first = f.runtime.run({id: "a"}, defaults, "Finishing with existing key");
    await waitFor(() => f.client.turnCounter === 1);
    const completion = f.authentication.submit("login-1", "http://127.0.0.1:1455/auth/callback?code=x");
    const queued = f.runtime.run({id: "b"}, defaults, "Use new authorization");
    await delay(5);
    assert.equal(f.client.turnCounter, 1);
    f.client.complete("thread-1", "turn-1", "Old turn complete"); await first; await completion;
    await waitFor(() => f.client.turnCounter === 2);
    assert.deepEqual(guards, [false]);
    assert.equal(f.client.accessToken, "fixture-siwc-access-token");
    f.client.complete("thread-2", "turn-2", "New turn complete"); await queued;
  } finally { await f.close(); }
});

test("API-key success clears a stale SIWC login error and logout keeps it cleared", async () => {
  const f = fixture();
  try {
    f.authentication.state = {status: "error", loginId: "older-attempt"};
    let account = await f.runtime.account();
    await f.runtime.login({type: "apiKey", apiKey: "fixture-api-key", version: account.version});
    account = await f.runtime.account();
    assert.equal(account.login?.status, "complete"); assert.equal(account.auth_method, "apiKey");
    await f.runtime.logout(account.version);
    assert.equal((await f.runtime.account()).login?.status, "cancelled");
  } finally { await f.close(); }
});

test("all three connections coexist and sign out removes only the selected credentials", async () => {
  const f = fixture();
  try {
    const native = {auth_mode: "chatgpt", tokens: {access_token: "fixture-native-access", refresh_token: "fixture-native-refresh"}};
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify(native));
    f.authentication.token = "fixture-retained-siwc-token";
    let account = await f.runtime.account();
    assert.equal(account.selected_auth_method, "siwc");
    assert.equal(account.connections.codex.configured, true);
    assert.equal(existsSync(join(f.client.homeDir, "auth.json")), false, "SIWC processes cannot use a hidden native grant");
    f.authentication.state = {status: "error", loginId: "stale-attempt"};
    await f.runtime.selectAuthMethod({method: "codex", version: account.version});
    assert.equal((await f.runtime.account()).login?.status, "complete");
    assert.equal(f.authentication.token, "fixture-retained-siwc-token");
    const rotated = {...native, tokens: {...native.tokens, refresh_token: "fixture-rotated-native-refresh"}};
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify(rotated));
    await f.runtime.login({type: "apiKey", apiKey: "fixture-new-api-key", version: (await f.runtime.account()).version});
    account = await f.runtime.account();
    assert.equal(account.auth_method, "apiKey");
    assert.deepEqual(Object.values(account.connections).map((connection) => connection.configured), [true, true, true]);
    assert.equal(f.authentication.token, "fixture-retained-siwc-token");
    await f.runtime.selectAuthMethod({method: "codex", version: account.version});
    assert.deepEqual(JSON.parse(readFileSync(join(f.client.homeDir, "auth.json"), "utf8")), rotated);
    await f.runtime.selectAuthMethod({method: "siwc", version: (await f.runtime.account()).version});
    await f.runtime.logout((await f.runtime.account()).version);
    account = await f.runtime.account();
    assert.equal(account.selected_auth_method, "siwc"); assert.equal(account.authenticated, false);
    assert.deepEqual(Object.values(account.connections).map((connection) => connection.configured), [false, true, true]);
    await f.runtime.selectAuthMethod({method: "codex", version: account.version});
    await f.runtime.logout((await f.runtime.account()).version);
    account = await f.runtime.account();
    assert.equal(account.selected_auth_method, "codex"); assert.equal(account.authenticated, false);
    assert.deepEqual(Object.values(account.connections).map((connection) => connection.configured), [false, false, true]);
    await f.runtime.selectAuthMethod({method: "apiKey", version: account.version});
    await f.runtime.logout((await f.runtime.account()).version);
    account = await f.runtime.account();
    assert.equal(account.selected_auth_method, "apiKey"); assert.equal(account.authenticated, false);
    assert.deepEqual(Object.values(account.connections).map((connection) => connection.configured), [false, false, false]);
    assert.equal(statSync(join(f.dir, "codex", "auth-connections")).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.dir, "codex", "auth-connections", "state.json")).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(account), /fixture-.*(?:token|refresh|key)/);
  } finally { await f.close(); }
});

test("saved authentication selection survives restart despite other configured connections", async () => {
  const f = fixture(); let restarted: CodexRuntime | undefined;
  try {
    f.authentication.token = "fixture-siwc-token";
    await f.runtime.account();
    await f.runtime.login({type: "apiKey", apiKey: "fixture-selected-api-key", version: (await f.runtime.account()).version});
    await f.runtime.close();
    restarted = new CodexRuntime(f.dir, {client: f.client, authentication: f.authentication});
    const account = await restarted.account();
    assert.equal(account.selected_auth_method, "apiKey");
    assert.equal(account.connections.siwc.configured, true);
    assert.equal(account.authenticated, true);
    assert.equal(statSync(join(f.dir, "codex", "auth-connections", "apiKey.json")).mode & 0o777, 0o600);
  } finally { await restarted?.close(); await f.close(); }
});

test("native browser completion is correlated before acknowledgement and switches after its queue clears", async () => {
  const f = fixture(); const guards: boolean[] = [];
  f.runtime.onAuthenticationChanged = () => {guards.push((f.runtime as any).authChanging);};
  try {
    f.authentication.token = "fixture-preserved-siwc-token";
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: any): Promise<T> => {
      const result = await request<T>(method, params);
      if (method === "account/login/start" && params.type === "chatgpt") {
        assert.equal(existsSync(join(f.client.homeDir, "auth.json")), false, "pending native login has no old managed grant to rotate");
        writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-new-native-token"}}));
        f.client.authenticated = true;
        f.client.notify("account/login/completed", {loginId: "foreign", success: false, error: "wrong flow"});
        f.client.notify("account/login/completed", {loginId: "login-1", success: true, error: null});
      }
      return result;
    };
    const result = await f.runtime.login({type: "codex", version: (await f.runtime.account()).version});
    assert.equal(result.method, "codex");
    await waitFor(() => (f.runtime as any).loginState?.status === "complete");
    await delay(1);
    const account = await f.runtime.account();
    assert.equal(account.auth_method, "codex"); assert.equal(account.authenticated, true);
    assert.equal(account.login?.method, "codex"); assert.equal(account.login?.status, "complete");
    assert.equal(f.authentication.token, "fixture-preserved-siwc-token");
    assert.deepEqual(guards, [false]);
    assert.equal(statSync(join(f.dir, "codex", "auth-connections", "codex.json")).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test("native device sign in blocks turns, rejects callback paste, and cancellation restores even notFound races", async () => {
  const f = fixture();
  try {
    const original = readFileSync(join(f.client.homeDir, "auth.json"), "utf8");
    await f.runtime.login({type: "codexDeviceCode", version: (await f.runtime.account()).version});
    let account = await f.runtime.account();
    assert.equal(account.login?.method, "codex");
    assert.equal((account.login as any).userCode, "TEST-CODE");
    assert.equal((account.login as any).verificationUrl, "https://auth.openai.com/codex/device");
    await assert.rejects(f.runtime.run({id: "a"}, defaults, "Must wait"), /Complete or cancel native Codex sign in/);
    await assert.rejects(f.runtime.submitLogin({loginId: "login-1", callbackUrl: "http://127.0.0.1:1455/auth/callback?code=x", version: account.version}), /browser or device/);
    f.client.notify("account/login/completed", {loginId: "unrelated", success: true});
    await delay(1); assert.equal((await f.runtime.account()).login?.status, "pending");
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "late-native-token"}}));
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: any): Promise<T> => {
      if (method === "account/login/cancel") {
        f.client.notify("account/login/completed", {loginId: "login-1", success: true});
        return {status: "notFound"} as T;
      }
      return request<T>(method, params);
    };
    await f.runtime.cancelLogin((await f.runtime.account()).version);
    await delay(1);
    account = await f.runtime.account();
    assert.equal(account.selected_auth_method, "apiKey"); assert.equal(account.login?.status, "cancelled");
    assert.equal(readFileSync(join(f.client.homeDir, "auth.json"), "utf8"), original);
    assert.equal(account.connections.codex.configured, false);
  } finally { await f.close(); }
});

test("native login timeout, SDK crash, and deactivation restore the previous native checkpoint", async () => {
  for (const failure of ["timeout", "disconnect", "deactivate"] as const) {
    const f = fixture({loginTimeoutMs: failure === "timeout" ? 5 : 1000});
    try {
      const original = readFileSync(join(f.client.homeDir, "auth.json"), "utf8");
      await f.runtime.login({type: "codex", version: (await f.runtime.account()).version});
      writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "uncommitted-native-token"}}));
      if (failure === "disconnect") f.client.emit("disconnect", new Error("SDK exited"));
      else if (failure === "deactivate") await f.runtime.deactivate();
      await waitFor(() => (f.runtime as any).loginState?.status !== "pending");
      assert.equal(readFileSync(join(f.client.homeDir, "auth.json"), "utf8"), original);
      const account = await f.runtime.account();
      assert.equal(account.selected_auth_method, "apiKey");
      assert.equal(account.connections.codex.configured, false);
      assert.equal(account.login?.status, failure === "deactivate" ? "cancelled" : "error");
      if (failure === "timeout") assert.equal(f.client.calls.some((call) => call.method === "account/login/cancel"), true);
    } finally { await f.close(); }
  }
});

test("failed native start restores credentials and leaves no background callback process", async () => {
  const f = fixture();
  try {
    const original = readFileSync(join(f.client.homeDir, "auth.json"), "utf8");
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: any): Promise<T> => {
      if (method === "account/login/start") {
        writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-uncommitted-token"}}));
        throw new Error("Invalid reply containing fixture-uncommitted-token");
      }
      return request<T>(method, params);
    };
    await assert.rejects(f.runtime.login({type: "codex", version: (await f.runtime.account()).version}), /Invalid reply containing \[redacted\]/);
    assert.equal(readFileSync(join(f.client.homeDir, "auth.json"), "utf8"), original);
    assert.equal((await f.runtime.account()).selected_auth_method, "apiKey");
    assert.equal((f.runtime as any).nativeLogin, undefined);
    assert.ok(f.client.closes >= 2);
  } finally { await f.close(); }
});

test("failed saved connection selection restores the previous working provider without falling back", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-cached-native-token"}}));
    f.authentication.token = "fixture-active-siwc-token";
    const account = await f.runtime.account();
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: unknown): Promise<T> => method === "account/read" ? {account: null, requiresOpenaiAuth: true} as T : request<T>(method, params);
    await assert.rejects(f.runtime.selectAuthMethod({method: "codex", version: account.version}), /no longer authenticated/);
    assert.equal((await f.runtime.account()).selected_auth_method, "siwc");
    assert.equal((await f.runtime.account()).authenticated, true);
    assert.equal(f.authentication.token, "fixture-active-siwc-token");
    assert.equal(f.client.accessToken, undefined);
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "SIWC still works");
    assert.equal((await f.runtime.run({id: "a"}, defaults, "Continue")).text, "SIWC still works");
    assert.equal(f.client.accessToken, "fixture-active-siwc-token");
  } finally { await f.close(); }
});

test("search authorization failures keep SIWC selected and never replay with cached native credentials", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-native-cache"}}));
    f.authentication.token = "fixture-active-siwc-token";
    f.client.onTurn = (params, id) => {
      f.client.notify("turn/completed", {threadId: params.threadId, turn: {id, status: "failed", items: [], error: {message: "Search 401: hardened_oauth_rule_missing"}}});
    };
    await assert.rejects(f.runtime.run({id: "a"}, defaults, "News"), /hardened_oauth_rule_missing/);
    assert.equal((await f.runtime.account()).selected_auth_method, "siwc");
    assert.equal((await f.runtime.account()).connections.codex.configured, true);
    assert.equal(f.client.turnCounter, 1);
    assert.equal(f.client.calls.some((call) => call.method === "account/login/start"), false);
  } finally { await f.close(); }
});

test("an explicit provider switch forks saved native history without replaying prior user messages", async () => {
  const f = fixture();
  try {
    f.authentication.token = "fixture-siwc-token";
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Reply");
    await f.runtime.run({id: "a"}, defaults, "First message");
    await f.runtime.login({type: "apiKey", apiKey: "fixture-native-key", version: (await f.runtime.account()).version});
    const request = f.client.request.bind(f.client);
    f.client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "thread/resume") throw Object.assign(new Error("Provider differs"), {reason: "modelProviderMismatch"});
      return request<T>(method, params);
    };
    await f.runtime.run({id: "a"}, defaults, "Second message");
    const fork = f.client.calls.find((call) => call.method === "thread/fork")!;
    assert.equal(fork.params.threadId, "thread-1"); assert.equal(fork.params.modelProvider, "openai");
    assert.equal(f.client.turnCounter, 2);
    assert.deepEqual(f.client.calls.filter((call) => call.method === "turn/start").map((call) => call.params.input[0].text), ["First message", "Second message"]);
    const mapping = JSON.parse(readFileSync(join(f.dir, "codex", "agents", "a", "thread.json"), "utf8"));
    assert.equal(mapping.threadId, "thread-2"); assert.equal(mapping.submitted, true);
  } finally { await f.close(); }
});

test("native and API-key setup work when the selected SIWC credential cannot refresh", async () => {
  for (const type of ["codex", "apiKey"] as const) {
    const f = fixture();
    try {
      f.authentication.token = "fixture-expired-siwc-token";
      f.authentication.accessToken = async () => {throw new Error("SIWC reauthorization required");};
      let account = await f.runtime.account();
      await assert.rejects(f.runtime.models(), /reauthorization required/);
      await f.runtime.login({type, apiKey: "fixture-recovery-key", version: account.version});
      if (type === "codex") {
        assert.equal((await f.runtime.account()).selected_auth_method, "siwc");
        writeFileSync(join(f.client.homeDir, "auth.json"), JSON.stringify({auth_mode: "chatgpt", tokens: {access_token: "fixture-recovery-native-token"}}));
        f.client.notify("account/login/completed", {loginId: "login-1", success: true});
        await waitFor(() => (f.runtime as any).loginState?.status === "complete");
      }
      account = await f.runtime.account();
      assert.equal(account.selected_auth_method, type);
      assert.equal(account.authenticated, true);
      assert.equal(f.authentication.token, "fixture-expired-siwc-token");
    } finally {await f.close();}
  }
});

test("a rejected SIWC commit keeps the selected native credentials usable", async () => {
  const f = fixture();
  try {
    const original = readFileSync(join(f.client.homeDir, "auth.json"), "utf8");
    await f.runtime.login({type: "chatgpt", version: (await f.runtime.account()).version});
    f.authentication.submit = async () => {
      const release = await f.authentication.beforeCommit?.("login");
      try {throw new Error("SIWC credential commit rejected");} finally {release?.();}
    };
    await assert.rejects(f.authentication.submit("login-1", "http://127.0.0.1:1455/auth/callback?code=x"), /commit rejected/);
    assert.equal(readFileSync(join(f.client.homeDir, "auth.json"), "utf8"), original);
    assert.equal((await f.runtime.account()).selected_auth_method, "apiKey");
    assert.equal((await f.runtime.account()).authenticated, true);
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Native remains available");
    assert.equal((await f.runtime.run({id: "a"}, defaults, "Continue")).text, "Native remains available");
  } finally {await f.close();}
});

test("model discovery never takes a second admission lease while SIWC completion drains its first lease", async () => {
  const f = fixture();
  try {
    await f.runtime.login({type: "chatgpt", version: (await f.runtime.account()).version});
    const readAccount = (f.runtime as any).readAccount.bind(f.runtime);
    let completion: Promise<void> | undefined;
    (f.runtime as any).readAccount = async (leased: boolean) => {
      if (leased && !completion) {
        completion = f.authentication.submit("login-1", "http://127.0.0.1:1455/auth/callback?code=x");
        await delay(1);
        assert.equal((f.runtime as any).authChanging, true);
      }
      return readAccount(leased);
    };
    const models = await f.runtime.models();
    assert.equal(models[0].available, true);
    await completion;
    assert.equal((await f.runtime.account()).selected_auth_method, "siwc");
  } finally {await f.close();}
});
