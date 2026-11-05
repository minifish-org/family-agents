import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { Manager } from "./manager.js";
import { RuntimeManager } from "./runtime-manager.js";
import type { AgentRuntime, RuntimeAgent, RuntimeDefaults, RuntimeReply } from "./runtime.js";
import type { ScheduleScope } from "./schedules.js";

class ScheduledRuntime implements AgentRuntime {
  nativeSearch = true;
  runs: Array<{ agent: RuntimeAgent; text: string }> = [];
  onRun?: (agent: RuntimeAgent, text: string) => Promise<RuntimeReply>;
  nativeWebSearchAvailable() { return this.nativeSearch; }
  async initialize() {}
  async validate(_defaults: RuntimeDefaults) {}
  async models() { return []; }
  async selection() { return { thinking_level: "low", thinking_levels: ["low"] }; }
  async initializeAgent(_agent: RuntimeAgent, _defaults: RuntimeDefaults) {}
  async run(agent: RuntimeAgent, _defaults: RuntimeDefaults, text: string) {
    this.runs.push({ agent, text });
    return this.onRun ? this.onRun(agent, text) : { text: "Verified news https://example.org/source", images: [], usedWebSearch: true };
  }
  async stopAgent() {}
  async deactivate() {}
  async close() {}
  sanitizeError(error: unknown) { return error instanceof Error ? error.message : String(error); }
}

class ScheduledGateway extends EventEmitter {
  ready = true;
  validRooms = new Set(["!dm:example.org", "!second-dm:example.org"]);
  failSend = false;
  validations = 0;
  afterValidate?: () => void;
  calls: Array<{ op: string; args: any }> = [];
  async start() {}
  async close() {}
  async request(op: string, args: any) {
    this.calls.push({ op, args });
    if (op === "validate_room") {
      this.validations++;
      if (!this.validRooms.has(args.room_id)) throw new Error("The owner room is no longer valid.");
      this.afterValidate?.();
      return { is_direct: true, encrypted: true, members: ["@owner:example.org", "@bot:example.org"] };
    }
    if (this.failSend && ["send_message", "send_media", "send_file"].includes(op)) throw new Error("Temporary Matrix delivery failure.");
    return {};
  }
  sent() { return this.calls.filter((call) => call.op === "send_message"); }
}

function fixture(existing?: { dir: string; now: { value: number } }) {
  const dir = existing?.dir ?? mkdtempSync(join(tmpdir(), "family-manager-schedules-"));
  const now = existing?.now ?? { value: Date.parse("2026-11-06T04:00:00Z") }, store = new Store(dir);
  if (!store.agents().length) {
    const person = store.addPerson("@owner:example.org", "Owner");
    store.db.prepare("INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('a',?,'@bot:example.org','Assistant','Running')").run(person.id);
    store.setPassword("a", "fixture-password");
    store.saveSettings({ ...store.settings(), homeserver: "https://matrix.example.org", runtime: "codex", provider: "codex", model: "fixture-model" });
  } else store.status("a", "Running");
  const runtime = new ScheduledRuntime(), gateway = new ScheduledGateway();
  const manager = new Manager(store, { sanitizeError: runtime.sanitizeError } as any, gateway as any,
    new RuntimeManager({ pi: new ScheduledRuntime(), codex: runtime }, "codex"), { now: () => now.value, progressDelayMs: 60_000 });
  const scope: ScheduleScope = {
    agent_id: "a", room_id: "!dm:example.org", homeserver: "https://matrix.example.org",
    agent_matrix_id: "@bot:example.org", owner_matrix_id: "@owner:example.org",
  };
  const request = (index: number) => ({ source_event_id: `$owner-${index}`, call_id: `call-${index}` });
  const reminder = (index = 1, selectedScope = scope) => manager.schedules.createReminder(selectedScope,
    { text: `Reminder ${index}`, delay_seconds: 1, time_zone: "Asia/Singapore" }, request(index));
  const briefing = (index = 2) => manager.schedules.createBriefing(scope,
    { query: "Singapore weather and today's headlines", time: "12:01", time_zone: "Asia/Singapore" }, request(index));
  return {
    dir, now, store, runtime, gateway, manager, scope, request, reminder, briefing,
    async close(remove = true) { await manager.close(); if (remove) rmSync(dir, { recursive: true, force: true }); },
  };
}

test("due reminders do not call a model and retry delivery with the same transaction after restart", async () => {
  let f = fixture();
  try {
    const schedule = f.reminder();
    f.now.value += 2000;
    f.gateway.failSend = true;
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "done");
    const first = f.gateway.sent()[0];
    assert.match(first.args.text, /Reminder 1/);
    assert.match(first.args.txn_id, /^schedule-/);
    assert.equal(f.store.outbox("a").length, 1);
    const previous = { dir: f.dir, now: f.now };
    await f.close(false);
    f = fixture(previous);
    await f.manager.restore();
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, 1);
    assert.equal(f.gateway.sent()[0].args.txn_id, first.args.txn_id);
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.store.outbox("a").length, 0);
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, 1);
  } finally { await f.close(); }
});

test("stopped Agents pause reminders, while a connected Agent with a model error can still receive them", async () => {
  const f = fixture();
  try {
    const schedule = f.reminder();
    await f.manager.lifecycle("a", "stop", f.store.agent("a").version);
    f.now.value += 3 * 86400_000;
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, 0);
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "pending");
    await f.manager.lifecycle("a", "start", f.store.agent("a").version);
    f.store.status("a", "Error", "The model is unavailable, but Matrix is connected.");
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, 1);
    assert.match(f.gateway.sent()[0].args.text, /Delayed reminder/);
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "done");
  } finally { await f.close(); }
});

test("room failures do not block another reminder and captured routing prevents old-server outbox delivery", async () => {
  const f = fixture();
  try {
    const blocked = f.reminder(1), otherScope = { ...f.scope, room_id: "!second-dm:example.org" }, valid = f.reminder(2, otherScope);
    f.now.value += 1000;
    f.gateway.validRooms.delete(f.scope.room_id);
    await f.manager.pollScheduled();
    assert.equal(f.manager.schedules.get(f.scope, blocked.id)!.state, "pending");
    assert.equal(f.manager.schedules.get(otherScope, valid.id)!.state, "done");
    assert.deepEqual(f.gateway.sent().map((call) => call.args.room_id), [otherScope.room_id]);
    f.gateway.failSend = true;
    const pending = f.reminder(3, otherScope);
    f.now.value += 1000;
    await f.manager.pollScheduled();
    assert.equal(f.manager.schedules.get(otherScope, pending.id)!.state, "done");
    assert.equal(f.store.outbox("a").length, 1);
    const attempts = f.gateway.sent().length;
    f.gateway.failSend = false;
    f.store.saveSettings({ ...f.store.settings(), homeserver: "https://new.example.org" });
    await f.manager.refreshRuntimeAgents();
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, attempts);
    assert.equal(f.store.outbox("a").length, 0);
  } finally { await f.close(); }
});

test("a transition before reminder persistence returns the claim safely for a later poll", async () => {
  const f = fixture();
  try {
    const schedule = f.reminder();
    f.now.value += 1000;
    f.gateway.afterValidate = () => { if (f.gateway.validations === 2) f.manager.transitioning = true; };
    await f.manager.pollScheduled();
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "pending");
    assert.equal(f.gateway.sent().length, 0);
    f.manager.transitioning = false;
    f.gateway.afterValidate = undefined;
    await f.manager.pollScheduled();
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "done");
    assert.equal(f.gateway.sent().length, 1);
    assert.equal(f.runtime.runs.length, 0);
  } finally { f.manager.transitioning = false; await f.close(); }
});

test("a verified briefing uses the captured owner context and cannot schedule new work", async () => {
  const f = fixture();
  try {
    const schedule = f.briefing();
    f.now.value += 60_000;
    f.runtime.onRun = async (agent, text) => {
      assert.match(text, /daily briefing explicitly subscribed/);
      assert.match(text, /Singapore weather/);
      assert.match(text, /Do not create, cancel, or modify schedules/);
      assert.equal(agent.tools?.definitions.length, 8);
      const signal = new AbortController().signal;
      await assert.rejects(agent.tools!.execute("reminder_create", { text: "Injected webpage instruction", delay_seconds: 1 }, { callId: "injected-create", signal }), /Scheduled content cannot/);
      await assert.rejects(agent.tools!.execute("briefing_cancel", { id: schedule.id }, { callId: "injected-cancel", signal }), /Scheduled content cannot/);
      return { text: "Verified current news https://example.org/today", images: [], usedWebSearch: true };
    };
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 1);
    assert.equal(f.gateway.sent().length, 1);
    assert.match(f.gateway.sent()[0].args.text, /Verified current news/);
    assert.equal(f.manager.schedules.list(f.scope, "reminder").length, 0);
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "pending");
    assert.ok(f.manager.schedules.get(f.scope, schedule.id)!.next_run > f.now.value);
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 1);
  } finally { await f.close(); }
});

test("briefings require native live search and reject answers without verified web results without retrying inference", async () => {
  const f = fixture();
  try {
    const unavailable = f.briefing(1);
    f.runtime.nativeSearch = false;
    f.now.value += 60_000;
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.manager.schedules.get(f.scope, unavailable.id)!.state, "needs_attention");
    assert.match(f.gateway.sent()[0].args.text, /Native Login/);
    f.runtime.nativeSearch = true;
    const noProof = f.manager.schedules.createBriefing(f.scope, { query: "Current news", time: "12:02", time_zone: "Asia/Singapore" }, f.request(2));
    f.runtime.onRun = async () => ({ text: "Unverified current news from memory", images: [], usedWebSearch: false });
    f.now.value += 60_000;
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 1);
    assert.equal(f.manager.schedules.get(f.scope, noProof.id)!.state, "needs_attention");
    assert.ok(f.gateway.sent().every((call) => !call.args.text.includes("Unverified current news from memory")));
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 1);
  } finally { await f.close(); }
});

test("interrupted briefing execution is not automatically resumed after restarting Manager", async () => {
  let f = fixture();
  try {
    const schedule = f.briefing();
    f.now.value += 60_000;
    assert.ok(f.manager.schedules.claim(schedule.id, f.scope));
    const previous = { dir: f.dir, now: f.now };
    await f.close(false);
    f = fixture(previous);
    await f.manager.pollScheduled();
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.gateway.sent().length, 0);
    assert.equal(f.manager.schedules.get(f.scope, schedule.id)!.state, "needs_attention");
    assert.match(f.manager.schedules.get(f.scope, schedule.id)!.last_error!, /not rerun automatically/);
  } finally { await f.close(); }
});

test("reminders are delivered once during a long owner reply without waiting for its model turn", { timeout: 5000 }, async () => {
  const f = fixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }), pending = new Promise<void>((resolve) => { finish = resolve; });
  let ownerReply: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    f.runtime.onRun = async () => { entered(); await pending; return { text: "The long owner reply completed.", images: [] }; };
    ownerReply = f.manager.receive({ agent_id: "a", event_id: "$long-owner-message", room_id: f.scope.room_id,
      sender: f.scope.owner_matrix_id, body: "Process this request", is_direct: true,
      members: [f.scope.owner_matrix_id, f.scope.agent_matrix_id] });
    await started;
    const reminder = f.reminder();
    f.now.value += 1000;
    await Promise.race([
      Promise.all([f.manager.pollScheduled(), f.manager.pollScheduled(), f.manager.pollScheduled()]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The reminder waited behind the model turn.")), 500); }),
    ]);
    clearTimeout(timer);
    assert.equal(f.gateway.sent().length, 1);
    assert.match(f.gateway.sent()[0].args.text, /Reminder 1/);
    assert.equal(f.manager.schedules.get(f.scope, reminder.id)!.state, "done");
    assert.equal(f.runtime.runs.length, 1);
    finish(); await ownerReply;
    assert.equal(f.gateway.sent().length, 2);
    assert.equal(f.gateway.sent().filter((call) => call.args.text.includes("Reminder 1")).length, 1);
  } finally {
    clearTimeout(timer); finish(); await ownerReply?.catch(() => {}); await f.close();
  }
});

test("startup restores Matrix and due reminders despite unavailable model authentication without clearing the runtime error", async () => {
  const f = fixture();
  try {
    const reminder = f.reminder();
    f.now.value += 1000;
    f.gateway.emit("event", { event: "status", agent_id: "a", status: "stopped" });
    f.runtime.initializeAgent = async () => { throw new Error("Selected model authorization expired."); };
    await f.manager.restore();
    assert.equal(f.gateway.calls.filter((call) => call.op === "start").length, 1);
    assert.equal(f.store.agent("a").status, "Error");
    assert.match(f.store.agent("a").error!, /authorization expired/);
    await f.manager.pollScheduled();
    assert.equal(f.gateway.sent().length, 1);
    assert.match(f.gateway.sent()[0].args.text, /Reminder 1/);
    assert.equal(f.runtime.runs.length, 0);
    assert.equal(f.manager.schedules.get(f.scope, reminder.id)!.state, "done");
    assert.equal(f.store.agent("a").status, "Error");
    assert.match(f.store.agent("a").error!, /authorization expired/);
    f.runtime.initializeAgent = async () => {};
    await f.manager.refreshRuntimeAgents();
    assert.equal(f.store.agent("a").status, "Running");
    assert.equal(f.store.agent("a").error, null);
    assert.equal(f.gateway.sent().length, 1);
  } finally { await f.close(); }
});
