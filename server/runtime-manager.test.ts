import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Store } from "./store.js";
import { Manager } from "./manager.js";
import { RuntimeManager } from "./runtime-manager.js";
import { createApp } from "./app.js";
import type { AgentRuntime, RuntimeDefaults } from "./runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function runtime(name: string) {
  const calls = { runs: [] as string[], starts: [] as string[], deactivations: 0 };
  const adapter: AgentRuntime = {
    initialize: async () => {}, validate: async () => {}, models: async () => [],
    selection: async () => ({ thinking_level: "medium", thinking_levels: ["medium"] }),
    initializeAgent: async (a) => { calls.starts.push(a.id); },
    run: async (_a, _s, text) => { calls.runs.push(text); return { text: `${name}: ${text}`, images: [] }; },
    stopAgent: async () => {}, deactivate: async () => { calls.deactivations++; },
    close: async () => {}, sanitizeError: (e) => e instanceof Error ? e.message : String(e),
  };
  return { adapter, calls };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "family-runtimes-")), store = new Store(dir);
  const owner = store.addPerson("@owner:example.org", "Owner");
  store.db.prepare("INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('a',?,'@bot:example.org','Bot','Running')").run(owner.id);
  store.saveSettings({ ...store.settings(), homeserver: "https://matrix.example.org", provider: "pi-provider", model: "pi-model" });
  const pi = runtime("Pi"), codex = runtime("Codex");
  const gateway = Object.assign(new EventEmitter(), {
    ready: true, calls: [] as Array<{op: string; args: any}>,
    async start() {}, async close() {},
    async request(op: string, args: any) {
      this.calls.push({op, args});
      return { is_direct: true, encrypted: true, members: [owner.matrix_id, "@bot:example.org"] };
    },
  });
  const manager = new Manager(store, {sanitizeError: pi.adapter.sanitizeError} as any, gateway as any,
    new RuntimeManager({pi: pi.adapter, codex: codex.adapter}));
  const event = (id: string) => ({ agent_id: "a", event_id: id, room_id: "!dm:example.org", sender: owner.matrix_id,
    body: id, is_direct: true, members: [owner.matrix_id, "@bot:example.org"] });
  const next = () => ({ ...store.settings(), runtime: "codex" as const, provider: "codex", model: "dynamic-model", thinking_level: "medium" });
  return { dir, store, pi, codex, gateway, manager, event, next,
    close: async () => { await manager.close(); rmSync(dir, {recursive: true, force: true}); } };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) { if (check()) return; await setImmediate(); }
  throw new Error("Expected runtime transition did not start.");
}

test("switch drains active turns, admits/deduplicates queued messages, and leaves Matrix clients intact", async () => {
  const f = fixture(), entered = deferred(), finish = deferred();
  const piPath = join(f.dir, "agents", "a", "sessions");
  mkdirSync(piPath, {recursive: true}); writeFileSync(join(piPath, "session"), "preserved Pi conversation");
  f.pi.adapter.run = async (_a, _s, text) => {
    f.pi.calls.runs.push(text); entered.resolve(); await finish.promise;
    return {text: "Completed Pi reply", images: []};
  };
  try {
    const first = f.manager.receive(f.event("$one")); await entered.promise;
    const switching = f.manager.settingsSerial.run("global-settings", () => f.manager.configure(f.next()));
    await until(() => f.manager.transitioning);
    await f.manager.receive(f.event("$two"));
    await f.manager.receive(f.event("$two"));
    assert.equal(f.store.pending("a").length, 1);
    assert.equal(f.codex.calls.runs.length, 0);
    finish.resolve(); await first; await switching; await f.manager.serial.drain();
    assert.deepEqual(f.pi.calls.runs, ["$one"]);
    assert.deepEqual(f.codex.calls.runs, ["$two"]);
    assert.equal(f.store.settings().runtime, "codex");
    assert.equal(f.store.pending("a").length, 0);
    assert.equal(f.gateway.calls.filter((c) => c.op === "send_message").length, 2);
    assert.equal(f.gateway.calls.filter((c) => c.op === "start" || c.op === "stop").length, 0);
    assert.equal(readFileSync(join(piPath, "session"), "utf8"), "preserved Pi conversation");
    const piDefaults = f.store.runtimeDefaults("pi") as RuntimeDefaults;
    await f.manager.configure({...f.store.settings(), ...piDefaults, runtime: "pi"});
    assert.equal(f.manager.runtimes.selected, "pi");
    assert.equal(f.store.settings().model, "pi-model");
  } finally { finish.resolve(); await f.close(); }
});

test("target session failure retains previous selection and working runtime", async () => {
  const f = fixture();
  f.codex.adapter.initializeAgent = async () => { throw new Error("Saved thread cannot be resumed."); };
  try {
    const before = f.store.settings();
    await assert.rejects(f.manager.configure(f.next()), /Saved thread cannot be resumed/);
    assert.deepEqual(f.store.settings(), before);
    assert.equal(f.manager.runtimes.selected, "pi");
    assert.equal(f.pi.calls.deactivations, 0);
    await f.manager.receive(f.event("$fresh"));
    assert.deepEqual(f.pi.calls.runs, ["$fresh"]);
    assert.equal(f.gateway.calls.filter((c) => c.op === "stop").length, 0);
  } finally { await f.close(); }
});

test("bounded switching cancels an uncertain execution without replaying it", async () => {
  const f = fixture(), entered = deferred(), active = deferred<{text: string; images: []}>();
  f.pi.adapter.run = async (_a, _s, text) => { f.pi.calls.runs.push(text); entered.resolve(); return active.promise; };
  f.pi.adapter.deactivate = async () => { f.pi.calls.deactivations++; active.reject(new Error("Turn cancelled.")); };
  try {
    const first = f.manager.receive(f.event("$uncertain")); await entered.promise;
    await f.manager.configure(f.next(), 5); await first;
    assert.equal(f.pi.calls.deactivations, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$uncertain'").get()!.state, "failed");
    await f.manager.receive(f.event("$uncertain"));
    await f.manager.receive(f.event("$new"));
    assert.deepEqual(f.codex.calls.runs, ["$new"]);
  } finally { active.reject(new Error("closed")); await f.close(); }
});

test("settings API rejects stale switches before touching a runtime", async () => {
  const f = fixture();
  let validations = 0; f.codex.adapter.validate = async () => { validations++; };
  try {
    const app = createApp(f.manager);
    const response = await app.request("/api/settings", {method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...f.next(), version: 999})});
    assert.equal(response.status, 409); assert.equal(validations, 0);
    assert.equal(f.store.settings().runtime, "pi");
  } finally { await f.close(); }
});

test("combined server/runtime changes isolate old inbox and outbox before queues resume", async () => {
  const f = fixture();
  try {
    f.store.enqueue("a", "$old-server", "!old:example.org", f.event("$old-server"));
    f.store.addOutbox("a", "!old:example.org", {text: "Old server reply"});
    await f.manager.configure({...f.next(), homeserver: "https://new.example.org"});
    await f.manager.serial.drain();
    assert.equal(f.store.pending("a").length, 0);
    assert.equal(f.store.outbox("a").length, 0);
    assert.equal(f.pi.calls.runs.length + f.codex.calls.runs.length, 0);
    assert.equal(f.gateway.calls.filter((c) => c.op === "send_message").length, 0);
    const starts = f.gateway.calls.filter((c) => c.op === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.homeserver, "https://new.example.org");
  } finally { await f.close(); }
});

test("Gateway restoration waits until target runtime activation is committed", async () => {
  const f = fixture(), preparing = deferred(), ready = deferred();
  f.codex.adapter.initializeAgent = async (a) => { f.codex.calls.starts.push(a.id); preparing.resolve(); await ready.promise; };
  try {
    const switching = f.manager.configure(f.next()); await preparing.promise;
    const restoration = f.manager.restore();
    await setImmediate();
    assert.equal(f.gateway.calls.filter((c) => c.op === "start").length, 0);
    assert.equal(f.pi.calls.starts.length, 0);
    ready.resolve(); await switching; await restoration;
    assert.equal(f.pi.calls.starts.length, 0);
    assert.ok(f.codex.calls.starts.length >= 2);
    assert.equal(f.manager.runtimes.selected, "codex");
  } finally { ready.resolve(); await f.close(); }
});

test("authentication recovery starts missing Matrix clients and preserves existing devices", async () => {
  const f = fixture();
  try {
    f.manager.runtimes.selected = "codex";
    f.store.saveSettings(f.next());
    f.store.status("a", "Error", "Sign in with ChatGPT again.");
    f.store.db.prepare("INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('b',?,'@second:example.org','Second','Error')")
      .run(f.store.people()[0].id);
    await f.manager.refreshRuntimeAgents();
    assert.equal(f.store.agent("a").status, "Running");
    assert.equal(f.store.agent("b").status, "Running");
    const starts = f.gateway.calls.filter((call) => call.op === "start");
    assert.deepEqual(starts.map((call) => call.args.agent_id), ["b"]);
    assert.equal(f.gateway.calls.filter((call) => call.op === "stop").length, 0);
    f.codex.adapter.initializeAgent = async () => { throw new Error("Sign in with ChatGPT again."); };
    await f.manager.refreshRuntimeAgents();
    assert.equal(f.store.agent("a").status, "Error");
    assert.match(f.store.agent("a").error ?? "", /Sign in/);
    assert.equal(f.gateway.calls.filter((call) => call.op === "stop").length, 0);
  } finally { await f.close(); }
});
