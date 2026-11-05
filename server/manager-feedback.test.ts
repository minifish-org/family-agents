import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Manager } from "./manager.js";
import { RuntimeManager } from "./runtime-manager.js";
import { Store } from "./store.js";
import type { AgentRuntime, RuntimeReply } from "./runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(progressDelayMs = 10_000) {
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
    new RuntimeManager({ pi: adapter, codex: other }), { progressDelayMs });
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
const csv = { data: Buffer.from('\uFEFF"Item","Amount"\r\n"Food",42\r\n').toString("base64"), mimeType: "text/csv", name: "家庭预算.csv" };

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

test("a slow reply sends one durable progress notice and stops typing after the final answer", async () => {
  const f = fixture(1), result = deferred<RuntimeReply>();
  f.adapter.run = async () => { f.calls.runs++; return result.promise; };
  let receiving: Promise<void> | undefined;
  try {
    receiving = f.manager.receive(f.event());
    await until(() => f.gateway.calls.some((call) => call.op === "send_message" && /still working/.test(call.args.text)));
    const progress = f.gateway.calls.find((call) => call.op === "send_message")!;
    assert.match(progress.args.text, /cancel/);
    assert.match(progress.args.txn_id, /^notice-/);
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing" && !call.args.typing).length, 0);
    result.resolve({ text: "Finished the analysis", images: [] });
    await receiving;
    await f.manager.receive(f.event());
    assert.equal(f.calls.runs, 1);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message" && /still working/.test(call.args.text)).length, 1);
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_message" && call.args.text === "Finished the analysis").length, 1);
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing").at(-1)!.args.typing, false);
  } finally { result.resolve({ text: "Closed", images: [] }); await receiving; await f.close(); }
});

test("model failure queues sanitized owner feedback with a stable delivery transaction and never reruns the failed prompt", async () => {
  const f = fixture();
  f.adapter.run = async () => { f.calls.runs++; throw new Error("Provider rejected fixture-private-key"); };
  f.gateway.failSend = true;
  try {
    await f.manager.receive(f.event());
    assert.equal(f.calls.runs, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
    const pending = f.store.outbox("a");
    assert.equal(pending.length, 1);
    assert.match(JSON.parse(pending[0].payload).text, /Provider rejected \[redacted\]/);
    assert.doesNotMatch(pending[0].payload, /fixture-private-key/);
    await f.manager.receive(f.event());
    assert.equal(f.calls.runs, 1);
    f.gateway.failSend = false;
    await f.manager.refreshRuntimeAgents();
    const attempts = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].args.txn_id, attempts[1].args.txn_id);
    assert.equal(attempts[1].args.room_id, f.event().room_id);
    assert.equal(f.store.outbox("a").length, 0);
    await f.manager.receive(f.event());
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
    receiving = f.manager.receive(f.event());
    await until(() => f.calls.runs === 1);
    await f.manager.receive(f.event("$cancel", "取消"));
    await receiving;
    finish.resolve({ text: "This late file must not be delivered", images: [], files: [csv] });
    await delay(2);
    assert.equal(f.calls.stops, 1);
    assert.equal(f.calls.runs, 1);
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$cancel'").get()!.state, "done");
    assert.equal(f.store.db.prepare("SELECT state FROM inbox WHERE event_id='$one'").get()!.state, "failed");
    assert.equal(f.gateway.calls.filter((call) => call.op === "send_file").length, 0);
    const notices = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(notices.length, 1);
    assert.match(notices[0].args.text, /Reply cancelled/);
    assert.equal(f.gateway.calls.filter((call) => call.op === "set_typing").at(-1)!.args.typing, false);
  } finally { finish.resolve({ text: "Closed", images: [] }); stopped.reject(new Error("Closed")); await receiving; await f.close(); }
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
