import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  constructor(dir: string) {
    super();
    this.homeDir = join(dir, "codex", "home");
    this.cwd = join(dir, "codex", "workspace");
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
  }
  async start() {}
  async setAccessToken(token?: string) {
    if (this.accessToken === token) return;
    this.accessToken = token; this.providerChanges.push(token); await this.close();
  }
  setRequestHandler(handler: FakeCodex["handler"]) { this.handler = handler; }
  async close() { this.closes++; }
  async request<T = unknown>(method: string, params: any = null): Promise<T> {
    this.calls.push({ method, params });
    let result: any = {};
    if (method === "account/read") result = { account: this.authenticated ? { type: this.accountType } : null, requiresOpenaiAuth: true };
    if (method === "model/list") result = { data: [{ id: "catalog-id", model: "codex-model", displayName: "Codex Model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "low", inputModalities: ["text", "image"], hidden: false }], nextCursor: null };
    if (method === "thread/start") result = { thread: { id: `thread-${++this.threadCounter}`, turns: [] } };
    if (method === "thread/resume") {
      if (this.rejectResume) throw new Error("Saved conversation unavailable.");
      result = { thread: { id: params.threadId, turns: [] } };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.turnCounter}`;
      await this.onTurn?.(params, id);
      result = { turn: { id, status: "inProgress" } };
    }
    if (method === "turn/interrupt") this.complete(params.threadId, params.turnId, "", "interrupted");
    if (method === "account/login/start") {
      this.authenticated = true;
      result = params.type === "chatgpt" ? { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/example" }
        : params.type === "chatgptDeviceCode" ? { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" }
        : { type: "apiKey" };
    }
    if (method === "account/logout") this.authenticated = false;
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
function fixture(options: { turnTimeoutMs?: number; interruptTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "family-codex-runtime-"));
  const client = new FakeCodex(dir), authentication = new FakeAuthentication(), runtime = new CodexRuntime(dir, { client, authentication, ...options });
  authentication.beforeCommit = (reason) => (runtime as any).beforeCredentialCommit(reason);
  return { dir, client, authentication, runtime, async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function waitFor(condition: () => boolean) {
  for (let count = 0; count < 100; count++) { if (condition()) return; await delay(1); }
  assert.fail("Expected protocol request did not arrive.");
}

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
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
    const start = f.client.calls.find((call) => call.method === "thread/start")!.params;
    assert.match(start.developerInstructions, /Agent A only/);
    assert.equal(start.config.web_search, "live");
    assert.equal(start.approvalPolicy, "on-request");
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
    assert.equal(f.client.turnCounter, 1, "never steer a turn whose cancellation is unconfirmed");
    f.client.complete("thread-1", "turn-1", "", "interrupted");
    f.client.onTurn = (params, id) => f.client.complete(params.threadId, id, "Recovered");
    assert.equal((await f.runtime.run({ id: "a" }, defaults, "Fresh")).text, "Recovered");
  } finally { await f.close(); }
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

test("legacy ChatGPT credentials require reconnect and never authorize new turns", async () => {
  const f = fixture();
  try {
    f.client.accountType = "chatgpt";
    const account = await f.runtime.account();
    assert.equal(account.authenticated, false); assert.equal(account.auth_method, "legacy");
    await assert.rejects(f.runtime.run({id: "a"}, defaults, "Never legacy"), /authentication/);
    assert.equal(f.client.turnCounter, 0);
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
