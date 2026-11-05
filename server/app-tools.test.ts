import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applicationTools, familyToolDefinitions } from "./app-tools.js";
import { ScheduleStore, type ScheduleScope } from "./schedules.js";
import type { RuntimeToolResult } from "./runtime.js";

const scope: ScheduleScope = {
  agent_id: "a", room_id: "!owner-dm:example.org", homeserver: "https://matrix.example.org",
  agent_matrix_id: "@assistant:example.org", owner_matrix_id: "@owner:example.org",
};
const foreign = { ...scope, agent_id: "b", room_id: "!second-dm:example.org", agent_matrix_id: "@second:example.org", owner_matrix_id: "@second-owner:example.org" };
const decode = (result: RuntimeToolResult) => JSON.parse(result.text);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE agents(id TEXT PRIMARY KEY); INSERT INTO agents VALUES('a'),('b')");
  const now = { value: Date.parse("2026-11-06T04:00:00Z") }, schedules = new ScheduleStore(db, { now: () => now.value });
  const controller = new AbortController();
  let checks = 0;
  const make = (overrides: Partial<Parameters<typeof applicationTools>[1]> = {}) => applicationTools(schedules, {
    scope, source_event_id: "$owner-message", allowScheduling: true,
    check: async () => { checks++; }, ...overrides,
  });
  const context = (callId = "call-1") => ({ callId, signal: controller.signal });
  return { db, now, schedules, controller, make, context, checks: () => checks, close: () => db.close() };
}

test("the application exposes only the eight fixed family tools with bounded object schemas", () => {
  assert.deepEqual(familyToolDefinitions.map((tool) => tool.name), [
    "reminder_create", "reminder_list", "reminder_cancel", "briefing_subscribe", "briefing_list", "briefing_cancel", "export_file", "python_analyze",
  ]);
  assert.equal(new Set(familyToolDefinitions.map((tool) => tool.name)).size, 8);
  for (const tool of familyToolDefinitions) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const python = familyToolDefinitions.find((tool) => tool.name === "python_analyze")!;
  const names = Object.keys(python.inputSchema.properties as object);
  assert.ok(!names.includes("code") && !names.includes("path") && !names.includes("command"));
});

test("owner-bound scheduling tools create, list, and cancel reminders and briefings idempotently", async () => {
  const f = fixture();
  try {
    const tools = f.make();
    const input = { text: "Bring the school bag", delay_seconds: 60, time_zone: "Asia/Singapore" };
    const created = decode(await tools.execute("reminder_create", input, f.context()));
    assert.equal(created.saved, true);
    assert.equal(created.local_time, "2026-11-06 12:01 Asia/Singapore");
    assert.ok(created.id && !created.room_id && !created.owner_matrix_id);
    f.now.value += 120_000;
    const duplicate = decode(await tools.execute("reminder_create", input, f.context()));
    assert.equal(duplicate.id, created.id);
    assert.equal(duplicate.scheduled_for, created.scheduled_for);
    const briefing = decode(await tools.execute("briefing_subscribe", { query: "Singapore weather and current news", time: "07:00", time_zone: "Asia/Singapore" }, f.context("briefing-1")));
    assert.equal(briefing.saved, true);
    assert.deepEqual(decode(await tools.execute("reminder_list", {}, f.context("list-reminders"))).map((item: any) => item.id), [created.id]);
    assert.deepEqual(decode(await tools.execute("briefing_list", {}, f.context("list-briefings"))).map((item: any) => item.id), [briefing.id]);
    const cancelled = decode(await tools.execute("reminder_cancel", { id: created.id }, f.context("cancel-reminder")));
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.state, "cancelled");
    const retry = decode(await tools.execute("reminder_cancel", { id: created.id }, f.context("cancel-reminder")));
    assert.equal(retry.cancelled, true);
    assert.equal(retry.id, created.id);
    assert.equal(decode(await tools.execute("briefing_cancel", { id: briefing.id }, f.context("cancel-briefing"))).state, "cancelled");
    assert.equal(decode(await tools.execute("briefing_cancel", { id: briefing.id }, f.context("cancel-briefing"))).state, "cancelled");
    assert.deepEqual(decode(await tools.execute("reminder_list", {}, f.context("empty-reminders"))), []);
    assert.deepEqual(decode(await tools.execute("briefing_list", {}, f.context("empty-briefings"))), []);
  } finally { f.close(); }
});

test("tool invocations cannot list or cancel another owner, room, homeserver, or Agent identity", async () => {
  const f = fixture();
  try {
    const ownerTools = f.make();
    const reminder = decode(await ownerTools.execute("reminder_create", { text: "Private reminder", delay_seconds: 60 }, f.context()));
    const briefing = decode(await ownerTools.execute("briefing_subscribe", { query: "Private briefing", time: "07:00" }, f.context("briefing-1")));
    for (const wrongScope of [foreign, { ...scope, room_id: "!elsewhere:example.org" }, { ...scope, homeserver: "https://other.example.org" },
      { ...scope, owner_matrix_id: "@intruder:example.org" }, { ...scope, agent_matrix_id: "@different-bot:example.org" }]) {
      const tools = f.make({ scope: wrongScope, source_event_id: "$different-message" });
      assert.deepEqual(decode(await tools.execute("reminder_list", {}, f.context())), []);
      assert.deepEqual(decode(await tools.execute("briefing_list", {}, f.context())), []);
      await assert.rejects(tools.execute("reminder_cancel", { id: reminder.id }, f.context()), /not found/);
      await assert.rejects(tools.execute("briefing_cancel", { id: briefing.id }, f.context()), /not found/);
    }
    await assert.rejects(ownerTools.execute("briefing_cancel", { id: reminder.id }, f.context()), /not found/);
    await assert.rejects(ownerTools.execute("reminder_cancel", { id: briefing.id }, f.context()), /not found/);
    assert.equal(f.schedules.get(scope, reminder.id)!.state, "pending");
  } finally { f.close(); }
});

test("scheduled briefings cannot create or cancel schedules even when content asks them to", async () => {
  const f = fixture();
  try {
    const tools = f.make({ allowScheduling: false, source_event_id: "scheduled-briefing:run-1" });
    const reminder = f.schedules.createReminder(scope, { text: "Keep this reminder", delay_seconds: 60 }, { source_event_id: "$original-owner", call_id: "owner-call" });
    const briefing = f.schedules.createBriefing(scope, { query: "Weather", time: "07:00" }, { source_event_id: "$original-owner", call_id: "briefing-call" });
    for (const [name, args] of [
      ["reminder_create", { text: "Untrusted page instruction", delay_seconds: 1 }],
      ["briefing_subscribe", { query: "Untrusted daily task", time: "12:00" }],
      ["reminder_cancel", { id: reminder.id }], ["briefing_cancel", { id: briefing.id }],
    ] as const) await assert.rejects(tools.execute(name, args, f.context()), /Scheduled content cannot/);
    assert.equal(decode(await tools.execute("reminder_list", {}, f.context())).length, 1);
    assert.equal(decode(await tools.execute("briefing_list", {}, f.context())).length, 1);
    assert.equal(f.schedules.get(scope, reminder.id)!.state, "pending");
    assert.equal(f.schedules.get(scope, briefing.id)!.state, "pending");
  } finally { f.close(); }
});

test("active owner checks and cancellation prevent scheduling and late artifact results", async () => {
  const f = fixture();
  try {
    const missing = applicationTools(f.schedules);
    await assert.rejects(missing.execute("reminder_list", {}, f.context()), /active owner message/);
    const inactive = f.make({ check: async () => { throw new Error("Owner room is no longer valid"); } });
    await assert.rejects(inactive.execute("reminder_create", { text: "Do not save", delay_seconds: 1 }, f.context()), /no longer valid/);
    assert.equal(f.schedules.list(scope).length, 0);
    const duringCheck = new AbortController();
    const aborted = f.make({ check: async () => { duringCheck.abort(); } });
    await assert.rejects(aborted.execute("reminder_create", { text: "Do not save", delay_seconds: 1 }, { callId: "aborted", signal: duringCheck.signal }), { name: "AbortError" });
    assert.equal(f.schedules.list(scope).length, 0);
    const afterExport = new AbortController();
    let checks = 0;
    const late = f.make({ check: async () => { if (++checks === 2) afterExport.abort(); } });
    await assert.rejects(late.execute("export_file", { format: "csv", columns: ["item"], rows: [["budget"]] }, { callId: "late-export", signal: afterExport.signal }), { name: "AbortError" });
    f.controller.abort();
    await assert.rejects(f.make().execute("reminder_list", {}, f.context()), { name: "AbortError" });
  } finally { f.close(); }
});

test("CSV export and fixed Python statistics return bounded results through the application dispatcher", async () => {
  const f = fixture();
  try {
    const tools = f.make();
    const exported = await tools.execute("export_file", { format: "csv", filename: "../../家庭预算.exe", columns: ["项目", "金额"], rows: [["食品", 10], ["交通", 30]] }, f.context("export"));
    assert.equal(exported.files?.length, 1);
    assert.equal(exported.files![0].name, "家庭预算.csv");
    assert.equal(exported.files![0].mimeType, "text/csv");
    assert.match(Buffer.from(exported.files![0].data, "base64").toString("utf8"), /"食品","10"/);
    assert.match(exported.text, /queued/);
    assert.equal(f.checks(), 2);
    const result = await tools.execute("python_analyze", { operation: "describe", rows: [{ amount: 10 }, { amount: 30 }, { amount: null }], columns: ["amount"] }, f.context("statistics"));
    const statistics = decode(result);
    assert.equal(statistics.rows, 3);
    assert.equal(statistics.columns.amount.count, 2);
    assert.equal(statistics.columns.amount.mean, 20);
    assert.equal(statistics.columns.amount.missing, 1);
    assert.deepEqual(result.images, []);
    assert.equal(f.checks(), 4);
  } finally { f.close(); }
});

test("unknown tools and arguments cannot spoof routing or introduce executable programs", async () => {
  const f = fixture();
  try {
    const tools = f.make();
    await assert.rejects(tools.execute("run_shell", { command: "forbidden" }, f.context()), /unavailable/);
    for (const input of [null, "invalid", [], 1]) await assert.rejects(tools.execute("reminder_list", input, f.context()), /arguments must be an object/);
    for (const [name, input] of [
      ["reminder_create", { text: "No spoofing", delay_seconds: 60, agent_id: "b" }],
      ["reminder_list", { owner_matrix_id: foreign.owner_matrix_id }],
      ["reminder_cancel", { id: "unknown", code: "forbidden" }],
      ["briefing_subscribe", { query: "No extra data", time: "07:00", room_id: foreign.room_id }],
      ["briefing_list", { source_event_id: "$forged" }],
      ["briefing_cancel", { id: "unknown", command: "forbidden" }],
      ["export_file", { format: "csv", columns: ["x"], rows: [[1]], command: "forbidden" }],
      ["python_analyze", { operation: "describe", rows: [{ x: 1 }], code: "__import__('os').environ" }],
    ] as const) await assert.rejects(tools.execute(name, input, f.context()), /unsupported|unknown|argument/i);
    assert.deepEqual(f.schedules.list(scope), []);
  } finally { f.close(); }
});
