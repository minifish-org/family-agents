import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { Manager } from "./manager.js";
import { RuntimeManager } from "./runtime-manager.js";
import { Store } from "./store.js";
import type { AgentRuntime, RuntimeAgent, RuntimeReply } from "./runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "family-manager-feedback-"));
  const store = new Store(directory), owner = store.addPerson("@owner:example.org", "Owner");
  store.db.prepare("INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('a',?,'@bot:example.org','Bot','Running')").run(owner.id);
  store.saveSettings({ ...store.settings(), homeserver: "https://matrix.example.org", provider: "fixture", model: "fixture-model" });
  const calls = { runs: 0, stops: 0 };
  const sanitizeError = (value: unknown) => (value instanceof Error ? value.message : String(value)).replaceAll("fixture-private-key", "[redacted]");
  const adapter: AgentRuntime = {
    initialize: async () => {}, validate: async () => {}, models: async () => [],
    selection: async () => ({ thinking_level: "off", thinking_levels: ["off"] }),
    initializeAgent: async () => {},
    run: async () => { calls.runs++; return { text: "Reply", images: [] }; },
    stopAgent: async () => { calls.stops++; }, deactivate: async () => {}, close: async () => {}, sanitizeError,
  };
  const gateway = Object.assign(new EventEmitter(), {
    ready: true, safe: true, failSend: false,
    calls: [] as Array<{ op: string; args: any }>,
    async start() {}, async close() {},
    async request(op: string, args: any) {
      this.calls.push({ op, args });
      if (op === "validate_room" && !this.safe) throw new Error("This room is no longer an encrypted owner-only direct message.");
      if (this.failSend && ["send_message", "send_media", "send_file"].includes(op)) throw new Error("Temporary delivery failure.");
      return { is_direct: true, encrypted: true, members: [owner.matrix_id, "@bot:example.org"] };
    },
  });
  const other: AgentRuntime = { ...adapter, close: async () => {} };
  const manager = new Manager(store, { ready: Promise.resolve(), sanitizeError } as any, gateway as any,
    new RuntimeManager({ pi: adapter, codex: other }));
  const event = (event_id = "$one", body = "Please help") => ({
    agent_id: "a", event_id, room_id: "!dm:example.org", sender: owner.matrix_id, body,
    is_direct: true, members: [owner.matrix_id, "@bot:example.org"],
  });
  return { directory, store, owner, adapter, calls, gateway, manager, event,
    async close() { await manager.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  for (let index = 0; index < 150; index++) { if (check()) return; await delay(2); }
  assert.fail("The expected Manager operation did not arrive.");
}
async function settle() {
  await nextTurn();
}
const csv = { data: Buffer.from('\uFEFF"Item","Amount"\r\n"Food",42\r\n').toString("base64"), mimeType: "text/csv", name: "家庭预算.csv" };
const png = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAnkAAAAASUVORK5CYII=", mimeType: "image/png" };

// Fixtures never start a Matrix client or use application data outside their private temporary directory.
test("a reply starts and stops owner-room typing without producing unnecessary progress messages", async () => {
  const f = fixture();
  try {
    await f.manager.receive(f.event());
    assert.deepEqual(f.gateway.calls.filter((call) => call.op === "set_typing").map((call) => call.args.typing), [true, false]);
    assert.ok(f.gateway.calls.filter((call) => call.op === "set_typing").every((call) => call.args.room_id === f.event().room_id && call.args.agent_id === "a"));
    assert.deepEqual(f.gateway.calls.filter((call) => call.op === "send_message").map((call) => call.args.text), ["Reply"]);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "done");
  } finally { await f.close(); }
});

test("threaded owner turns use stable, distinct conversation keys and return text and attachments to their thread", async () => {
  const f = fixture();
  const agents: RuntimeAgent[] = [];
  f.adapter.run = async (agent) => {
    agents.push(agent);
    return { text: "**Reply**", images: [png], files: [csv] };
  };
  try {
    await f.manager.receive(f.event("$main"));
    await f.manager.receive({ ...f.event("$budget-one"), thread_root_id: "$budget", thread_root_body: "Household budget" });
    await f.manager.receive({ ...f.event("$travel-one"), thread_root_id: "$travel" });
    await f.manager.receive({ ...f.event("$budget-two"), thread_root_id: "$budget" });
    assert.deepEqual(agents.map((agent) => agent.id), ["a", "a", "a", "a"]);
    assert.equal(agents[0].conversationId, undefined);
    assert.match(agents[1].conversationId!, /^[0-9a-f]{64}$/);
    assert.notEqual(agents[2].conversationId, agents[1].conversationId);
    assert.equal(agents[3].conversationId, agents[1].conversationId);
    assert.match(agents[1].initialContext!, /untrusted background.*\nThread starter: "Household budget"/);
    assert.equal(agents[0].initialContext, undefined);

    const sent = f.gateway.calls.filter(({ op }) => ["send_message", "send_media", "send_file"].includes(op));
    const expectedRoutes = [[undefined, undefined], ["$budget", "$budget-one"], ["$travel", "$travel-one"], ["$budget", "$budget-two"]];
    assert.deepEqual(sent.map(({ op, args }) => [op, args.thread_root_id, args.reply_to_event_id]),
      expectedRoutes.flatMap((route) => ["send_message", "send_media", "send_file"].map((op) => [op, ...route])));
  } finally { await f.close(); }
});

test("a slow reply stays silent until the final answer and stops typing before delivery", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = fixture(), result = deferred<RuntimeReply>();
  const event = { ...f.event(), thread_root_id: "$budget" };
  f.adapter.run = async () => { f.calls.runs++; return result.promise; };
  let receiving: Promise<void> | undefined;
  try {
    receiving = f.manager.receive(event);
    await settle();
    assert.equal(f.calls.runs, 1);
    t.mock.timers.tick(24_001);
    await settle();
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    assert.equal(f.store.outbox("a").length, 0);
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing" && !call.args.typing).length, 0);
    result.resolve({ text: "**Finished the analysis**", images: [] });
    await receiving;
    await f.manager.receive(event);
    assert.equal(f.calls.runs, 1);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 1);
    const replies = f.gateway.calls.filter((call) => call.op === "send_message" && call.args.text === "**Finished the analysis**");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].args.markdown, true);
    assert.equal(replies[0].args.thread_root_id, "$budget");
    assert.equal(replies[0].args.reply_to_event_id, "$one");
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing").at(-1)!.args.typing, false);
    assert.ok(f.gateway.calls.findIndex((call) => call.op === "set_typing" && !call.args.typing) < f.gateway.calls.indexOf(replies[0]));
  } finally { t.mock.timers.reset(); result.resolve({ text: "Closed", images: [] }); await receiving; await f.close(); }
});

test("typing cleanup drains a delayed start and finishes before delivery or the next queued turn", async () => {
  const f = fixture(), first = deferred<RuntimeReply>(), start = deferred<void>(), stop = deferred<void>();
  const request = f.gateway.request.bind(f.gateway), completed: boolean[] = [];
  let starts = 0, stops = 0;
  f.gateway.request = async (op, args) => {
    const result = await request(op, args);
    if (op === "set_typing") {
      if (args.typing && ++starts === 1) await start.promise;
      if (!args.typing && ++stops === 1) await stop.promise;
      completed.push(args.typing);
    }
    return result;
  };
  f.adapter.run = async () => ++f.calls.runs === 1 ? first.promise : { text: "Second", images: [] };
  const receiving = [f.manager.receive(f.event("$first"))];
  try {
    await until(() => f.calls.runs === 1);
    receiving.push(f.manager.receive(f.event("$second")));
    await until(() => f.gateway.calls.some(({ op, args }) => op === "ack_event" && args.event_id === "$second"));
    first.resolve({ text: "First", images: [] });
    await settle();
    assert.equal(stops, 0, "The final stop waits for the in-flight start.");
    assert.equal(f.calls.runs, 1);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    start.resolve();
    await until(() => stops === 1);
    assert.equal(f.calls.runs, 1, "The next turn waits for the preceding stop acknowledgement.");
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    stop.resolve();
    await Promise.all(receiving);
    assert.deepEqual(completed, [true, false, true, false]);
    assert.deepEqual(f.gateway.calls.filter((call) => call.op === "send_message").map((call) => call.args.text), ["First", "Second"]);
  } finally {
    first.resolve({ text: "", images: [] }); start.resolve(); stop.resolve();
    await Promise.allSettled(receiving); await f.close();
  }
});

test("typing refreshes coalesce while pending and cannot restart typing after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = fixture(), result = deferred<RuntimeReply>(), initial = deferred<void>(), refresh = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  let starts = 0;
  f.gateway.request = async (op, args) => {
    const response = await request(op, args);
    if (op === "set_typing" && args.typing) await (++starts === 1 ? initial.promise : refresh.promise);
    return response;
  };
  f.adapter.run = async () => { f.calls.runs++; return result.promise; };
  const receiving = f.manager.receive(f.event());
  try {
    await settle();
    assert.equal(starts, 1);
    t.mock.timers.tick(40_000);
    await settle();
    assert.equal(starts, 1, "Refresh ticks cannot overlap an outstanding typing request.");
    initial.resolve();
    await settle();
    t.mock.timers.tick(8000);
    await settle();
    assert.equal(starts, 2);
    result.resolve({ text: "Finished", images: [] });
    await settle();
    t.mock.timers.tick(40_000);
    await settle();
    assert.equal(starts, 2);
    assert.equal(f.gateway.calls.filter(({ op, args }) => op === "set_typing" && !args.typing).length, 0);
    refresh.resolve();
    await receiving;
    const typing = f.gateway.calls.filter((call) => call.op === "set_typing");
    assert.deepEqual(typing.map((call) => call.args.typing), [true, true, false]);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing").length, typing.length);
  } finally {
    t.mock.timers.reset(); initial.resolve(); refresh.resolve(); result.resolve({ text: "", images: [] });
    await receiving; await f.close();
  }
});

test("a model failure waits for typing cleanup before delivering its error", async () => {
  const f = fixture(), stop = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  let stopping = false;
  f.gateway.request = async (op, args) => {
    const response = await request(op, args);
    if (op === "set_typing" && !args.typing) { stopping = true; await stop.promise; }
    return response;
  };
  f.adapter.run = async () => { throw new Error("The model is unavailable."); };
  const receiving = f.manager.receive(f.event());
  try {
    await until(() => stopping);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    stop.resolve();
    await receiving;
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing" && !call.args.typing).length, 1);
    assert.match(f.gateway.calls.find((call) => call.op === "send_message")!.args.text, /model is unavailable/);
  } finally { stop.resolve(); await receiving; await f.close(); }
});

test("cancellation stops typing before the model acknowledges interruption", async () => {
  const f = fixture(), result = deferred<RuntimeReply>(), stopped = deferred<void>();
  f.adapter.run = async () => { f.calls.runs++; return result.promise; };
  f.adapter.stopAgent = async () => { f.calls.stops++; await stopped.promise; result.reject(new Error("Interrupted")); };
  const receiving = f.manager.receive(f.event());
  let cancelling: Promise<void> | undefined;
  try {
    await until(() => f.calls.runs === 1);
    cancelling = f.manager.receive(f.event("$cancel", "取消"));
    await until(() => f.calls.stops === 1);
    await until(() => f.gateway.calls.some(({ op, args }) => op === "set_typing" && !args.typing));
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    stopped.resolve();
    await Promise.all([receiving, cancelling]);
    assert.equal(f.gateway.calls.filter(({ op, args }) => op === "set_typing" && !args.typing).length, 1);
    assert.match(f.gateway.calls.find((call) => call.op === "send_message")!.args.text, /Reply cancelled/);
  } finally { stopped.resolve(); result.resolve({ text: "", images: [] }); await Promise.allSettled([receiving, cancelling]); await f.close(); }
});

test("a completed model reply remains cancellable while typing cleanup is pending", async () => {
  const f = fixture(), stop = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  let stopping = false;
  f.gateway.request = async (op, args) => {
    const response = await request(op, args);
    if (op === "set_typing" && !args.typing) { stopping = true; await stop.promise; }
    return response;
  };
  const receiving = f.manager.receive(f.event());
  let cancelling: Promise<void> | undefined;
  try {
    await until(() => stopping);
    assert.equal(f.calls.runs, 1);
    cancelling = f.manager.receive(f.event("$cancel", "cancel"));
    await until(() => f.calls.stops === 1);
    stop.resolve();
    await Promise.all([receiving, cancelling]);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
    const sent = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(sent.length, 1);
    assert.match(sent[0].args.text, /Reply cancelled/);
    assert.equal(f.gateway.calls.filter(({ op, args }) => op === "set_typing" && !args.typing).length, 1);
  } finally { stop.resolve(); await Promise.allSettled([receiving, cancelling]); await f.close(); }
});

test("shutdown aborts a completed model reply while typing cleanup is pending", async () => {
  const f = fixture(), stop = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  let stopping = false, gatewayClosed = false;
  f.gateway.request = async (op, args) => {
    const response = await request(op, args);
    if (op === "set_typing" && !args.typing) { stopping = true; await stop.promise; }
    return response;
  };
  f.gateway.close = async () => { gatewayClosed = true; };
  const receiving = f.manager.receive(f.event());
  let closing: Promise<void> | undefined;
  try {
    await until(() => stopping);
    assert.equal(f.calls.runs, 1);
    closing = f.manager.close();
    await settle();
    assert.equal(gatewayClosed, false);
    stop.resolve();
    await Promise.all([receiving, closing]);
    assert.equal(gatewayClosed, true);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message").length, 0);
    assert.equal(f.gateway.calls.filter(({ op, args }) => op === "set_typing" && !args.typing).length, 1);
  } finally {
    stop.resolve(); await Promise.allSettled([receiving, closing]);
    if (closing) rmSync(f.directory, { recursive: true, force: true });
    else await f.close();
  }
});

test("shutdown waits for pending typing cleanup before closing the Gateway", async () => {
  const f = fixture(), result = deferred<RuntimeReply>(), start = deferred<void>(), stop = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  let stopping = false, gatewayClosed = false;
  f.gateway.request = async (op, args) => {
    const response = await request(op, args);
    if (op === "set_typing") {
      if (args.typing) await start.promise;
      else { stopping = true; await stop.promise; }
    }
    return response;
  };
  f.gateway.close = async () => { gatewayClosed = true; };
  f.adapter.run = async () => { f.calls.runs++; return result.promise; };
  f.adapter.close = async () => { result.reject(new Error("Service stopped.")); };
  const receiving = f.manager.receive(f.event());
  let closing: Promise<void> | undefined;
  try {
    await until(() => f.calls.runs === 1);
    closing = f.manager.close();
    await settle();
    assert.equal(stopping, false);
    assert.equal(gatewayClosed, false);
    start.resolve();
    await until(() => stopping);
    assert.equal(gatewayClosed, false);
    stop.resolve();
    await Promise.all([receiving, closing]);
    assert.equal(gatewayClosed, true);
    assert.deepEqual(f.gateway.calls.filter((call) => call.op === "set_typing").map((call) => call.args.typing), [true, false]);
  } finally {
    start.resolve(); stop.resolve(); result.resolve({ text: "", images: [] });
    await Promise.allSettled([receiving, closing]);
    if (closing) rmSync(f.directory, { recursive: true, force: true });
    else await f.close();
  }
});

test("model failure queues sanitized owner feedback with a stable delivery transaction and never reruns the failed prompt", async () => {
  const f = fixture();
  const event = { ...f.event(), thread_root_id: "$budget" };
  f.adapter.run = async () => { f.calls.runs++; throw new Error("Provider rejected fixture-private-key"); };
  f.gateway.failSend = true;
  try {
    await f.manager.receive(event);
    assert.equal(f.calls.runs, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
    const pending = f.store.outbox("a");
    assert.equal(pending.length, 1);
    assert.match(JSON.parse(pending[0].payload).text, /Provider rejected \[redacted\]/);
    assert.doesNotMatch(pending[0].payload, /fixture-private-key/);
    await f.manager.receive(event);
    assert.equal(f.calls.runs, 1);
    f.gateway.failSend = false;
    await f.manager.refreshRuntimeAgents();
    const attempts = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].args.txn_id, attempts[1].args.txn_id);
    assert.equal(attempts[1].args.room_id, f.event().room_id);
    assert.equal(attempts[1].args.thread_root_id, "$budget");
    assert.equal(attempts[1].args.reply_to_event_id, "$one");
    assert.equal(f.store.outbox("a").length, 0);
    await f.manager.receive(event);
    assert.equal(f.calls.runs, 1);
  } finally { await f.close(); }
});

test("an invalid attachment sends one owner-visible rejection while duplicate events retain neither bytes nor extra notices", async () => {
  const f = fixture();
  try {
    const bad = { ...f.event("$bad"), media: { data: "private-upload-bytes", mime_type: "image/svg+xml" } };
    await f.manager.receive(bad); await f.manager.receive(bad);
    const row = f.store.db.prepare("SELECT state,payload FROM inbox WHERE event_id='$bad'").get()!;
    assert.equal(row.state, "rejected");
    assert.doesNotMatch(String(row.payload), /private-upload-bytes/);
    assert.equal(f.calls.runs, 0);
    const notices = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(notices.length, 1);
    assert.match(notices[0].args.text, /couldn't process this attachment/);
    assert.equal(f.gateway.calls.filter((call) => call.op === "ack_event").length, 2);
  } finally { await f.close(); }
});

test("Matrix cancel interrupts an active reply and rejects files that arrive after cancellation", async () => {
  const f = fixture(), finish = deferred<RuntimeReply>(), stopped = deferred<RuntimeReply>();
  f.adapter.run = async () => { f.calls.runs++; return Promise.race([finish.promise, stopped.promise]); };
  f.adapter.stopAgent = async () => { f.calls.stops++; stopped.reject(new Error("Interrupted")); };
  let receiving: Promise<void> | undefined;
  try {
    receiving = f.manager.receive({ ...f.event(), thread_root_id: "$budget" });
    await until(() => f.calls.runs === 1);
    await f.manager.receive({ ...f.event("$wrong-cancel", "取消"), thread_root_id: "$travel" });
    assert.equal(f.calls.stops, 0);
    await f.manager.receive({ ...f.event("$cancel", "取消"), thread_root_id: "$budget" });
    await receiving;
    finish.resolve({ text: "This late file must not be delivered", images: [], files: [csv] });
    await delay(2);
    assert.equal(f.calls.stops, 1);
    assert.equal(f.calls.runs, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$cancel'").get()!.state, "done");
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_file").length, 0);
    const notices = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(notices.length, 2);
    assert.match(notices[0].args.text, /no active reply/);
    assert.equal(notices[0].args.thread_root_id, "$travel");
    assert.match(notices[1].args.text, /Reply cancelled/);
    assert.equal(notices[1].args.thread_root_id, "$budget");
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing").at(-1)!.args.typing, false);
  } finally { finish.resolve({ text: "Closed", images: [] }); stopped.reject(new Error("Closed")); await receiving; await f.close(); }
});

test("a delayed cancellation acknowledgement cannot interrupt a newer turn in the same thread", async () => {
  const f = fixture(), first = deferred<RuntimeReply>(), second = deferred<RuntimeReply>();
  const ackWaiting = deferred<void>(), ack = deferred<void>();
  const request = f.gateway.request.bind(f.gateway);
  f.gateway.request = async (op, args) => {
    if (op === "ack_event" && args.event_id === "$cancel") {
      ackWaiting.resolve();
      await ack.promise;
    }
    return request(op, args);
  };
  f.adapter.run = async () => ++f.calls.runs === 1 ? first.promise : second.promise;
  const event = (id: string, body?: string) => ({ ...f.event(id, body), thread_root_id: "$budget" });
  const receiving = [f.manager.receive(event("$first"))];
  try {
    await until(() => f.calls.runs === 1);
    receiving.push(f.manager.receive(event("$second")), f.manager.receive(event("$cancel", "cancel")));
    await ackWaiting.promise;
    first.resolve({ text: "First", images: [] });
    await until(() => f.calls.runs === 2);
    ack.resolve();
    await receiving[2];
    second.resolve({ text: "Second", images: [] });
    await Promise.all(receiving);
    assert.equal(f.calls.stops, 0);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$second'").get()!.state, "done");
    assert.equal(f.gateway.calls.filter(({ op, args }) => op === "send_message" && /no active reply/.test(args.text)).length, 1);
  } finally {
    ack.resolve(); first.resolve({ text: "", images: [] }); second.resolve({ text: "", images: [] });
    await Promise.allSettled(receiving);
    await f.close();
  }
});

test("exported files use the encrypted-file Gateway route with a fresh room check and stable transaction", async () => {
  const f = fixture();
  f.adapter.run = async () => { f.calls.runs++; return { text: "The report is ready", images: [], files: [csv] }; };
  try {
    await f.manager.receive(f.event());
    const sent = f.gateway.calls.find((call) => call.op === "send_file")!;
    assert.ok(sent);
    assert.deepEqual({ data: sent.args.data, mime_type: sent.args.mime_type, filename: sent.args.filename }, { data: csv.data, mime_type: csv.mimeType, filename: csv.name });
    assert.equal(sent.args.room_id, f.event().room_id);
    assert.ok(sent.args.txn_id);
    const index = f.gateway.calls.indexOf(sent);
    assert.equal(f.gateway.calls[index - 1].op, "validate_room");
    await f.manager.receive(f.event());
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_file").length, 1);
    assert.equal(f.calls.runs, 1);
  } finally { await f.close(); }
});

test("a routing change after model completion holds file delivery and retries only the stored file", async () => {
  const f = fixture();
  f.adapter.run = async () => { f.calls.runs++; f.gateway.safe = false; return { text: "", images: [], files: [csv] }; };
  try {
    await f.manager.receive(f.event());
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_file").length, 0);
    const pending = f.store.outbox("a");
    assert.equal(pending.length, 1);
    const txn = pending[0].id;
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "done");
    f.gateway.safe = true;
    await f.manager.refreshRuntimeAgents();
    const files = f.gateway.calls.filter((call) => call.op === "send_file");
    assert.equal(files.length, 1);
    assert.equal(files[0].args.txn_id, txn);
    assert.equal(f.calls.runs, 1);
  } finally { await f.close(); }
});

test("invalid runtime file metadata and encoding cannot produce an outbound attachment", async () => {
  const bad = [
    { ...csv, name: "../../private.csv" }, { ...csv, mimeType: "application/x-executable" }, { ...csv, data: "Zh==" },
    { ...csv, mimeType: "application/pdf", name: "report.pdf" },
    { ...csv, mimeType: "application/pdf", name: "report.csv", data: Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64") },
    { ...csv, data: Buffer.from([0xff, 0xfe]).toString("base64") },
    { ...csv, name: "C:report.csv" },
    { ...csv, name: "report\u202e.csv" },
  ];
  for (const file of bad) {
    const f = fixture();
    f.adapter.run = async () => ({ text: "Do not publish this success claim", images: [], files: [file] });
    try {
      await f.manager.receive(f.event());
      assert.equal(f.gateway.calls.filter((call) => call.op === "send_file").length, 0);
      assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
      assert.ok(f.gateway.calls.some((call) => call.op === "send_message" && /file|CSV|PDF|export/i.test(call.args.text)));
      assert.ok(!f.gateway.calls.some((call) => call.op === "send_message" && call.args.text === "Do not publish this success claim"));
    } finally { await f.close(); }
  }
});
