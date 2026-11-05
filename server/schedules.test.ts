import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore, nextDailyTime, scheduleReceipt, type ScheduleScope } from "./schedules.js";

const owner: ScheduleScope = {
  agent_id: "a", room_id: "!owner-dm:example.org", homeserver: "https://matrix.example.org",
  agent_matrix_id: "@assistant:example.org", owner_matrix_id: "@owner:example.org",
};
const second = { ...owner, agent_id: "b", room_id: "!second-dm:example.org", agent_matrix_id: "@second:example.org", owner_matrix_id: "@second-owner:example.org" };
const request = (number: number) => ({ source_event_id: `$event-${number}`, call_id: `call-${number}` });
const clock = () => ({ value: Date.parse("2026-11-06T04:00:00Z") });
function open(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO agents VALUES('a'),('b'); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,text TEXT NOT NULL)");
  return db;
}
function fixture() {
  const db = open(), now = clock(), schedules = new ScheduleStore(db, { now: () => now.value });
  return { db, now, schedules, close() { db.close(); } };
}

test("reminders persist exact deadlines and local confirmations with idempotent tool calls", () => {
  const f = fixture();
  try {
    const original = f.schedules.createReminder(owner, { text: "Bring the school bag", delay_seconds: 60 }, request(1));
    assert.equal(original.next_run, f.now.value + 60_000);
    assert.equal(original.next_run_local, "2026-11-06 12:01 Asia/Singapore");
    f.now.value += 120_000;
    const retry = f.schedules.createReminder(owner, { text: "Bring the school bag", delay_seconds: 60 }, request(1));
    assert.equal(retry.id, original.id);
    assert.equal(retry.next_run, original.next_run);
    assert.throws(() => f.schedules.createReminder(owner, { text: "Different instruction", delay_seconds: 60 }, request(1)), /different details/);
    const absolute = f.schedules.createReminder(owner, { text: "Pay the bill", at: "2026-11-07T19:00:00+08:00", time_zone: "Asia/Singapore" }, request(2));
    assert.equal(absolute.next_run, Date.parse("2026-11-07T11:00:00Z"));
    const receipt = scheduleReceipt(absolute);
    assert.equal(receipt.scheduled_for, "2026-11-07T11:00:00.000Z");
    assert.equal(receipt.local_time, "2026-11-07 19:00 Asia/Singapore");
    assert.ok(!("room_id" in receipt) && !("source_event_id" in receipt));
  } finally { f.close(); }
});

test("schedule input validation rejects ambiguous, invalid, past, oversized, and excessive requests", () => {
  const f = fixture();
  try {
    for (const values of [
      { at: "2026-11-07T19:00:00" }, { at: "2027-02-30T19:00:00+08:00" }, { at: "2026-11-07T25:00:00Z" },
      { at: "2026-11-05T19:00:00Z" }, { at: "2030-11-07T19:00:00Z" }, { delay_seconds: 0 }, { delay_seconds: 1.5 },
      { delay_seconds: 365 * 86400 + 1 }, {}, { delay_seconds: 1, at: "2026-11-07T19:00:00Z" },
    ]) assert.throws(() => f.schedules.createReminder(owner, { text: "Reminder", ...values }, request(1)));
    assert.throws(() => f.schedules.createReminder(owner, { text: "Reminder", delay_seconds: 1, time_zone: "CST" }, request(1)), /IANA/);
    assert.throws(() => f.schedules.createReminder(owner, { text: "Reminder", delay_seconds: 1, time_zone: "Invalid/Place" }, request(1)), /IANA/);
    assert.throws(() => f.schedules.createBriefing(owner, { query: "News", time: "7:00" }, request(1)), /HH:mm/);
    assert.throws(() => f.schedules.createBriefing(owner, { query: "x".repeat(1025), time: "07:00" }, request(1)), /maximum/);
    for (let n = 0; n < 20; n++) f.schedules.createReminder(owner, { text: `Reminder ${n}`, delay_seconds: 60 }, request(n));
    assert.equal(f.schedules.list(owner).length, 20);
    assert.throws(() => f.schedules.createReminder(owner, { text: "Too many", delay_seconds: 60 }, request(21)), /at most 20/);
    assert.equal(f.schedules.createReminder(second, { text: "Separate owner", delay_seconds: 60 }, request(21)).owner_matrix_id, second.owner_matrix_id);
  } finally { f.close(); }
});

test("all routing identity fields scope listing, lookup, cancellation, claims, and idempotency", () => {
  const f = fixture();
  try {
    const schedule = f.schedules.createReminder(owner, { text: "Private reminder", delay_seconds: 1 }, request(1));
    f.now.value += 2000;
    for (const scope of [second, { ...owner, room_id: "!other:example.org" }, { ...owner, homeserver: "https://elsewhere.example.org" },
      { ...owner, owner_matrix_id: "@another:example.org" }, { ...owner, agent_matrix_id: "@another-bot:example.org" }]) {
      assert.deepEqual(f.schedules.list(scope), []);
      assert.equal(f.schedules.get(scope, schedule.id), null);
      assert.equal(f.schedules.cancel(scope, schedule.id), null);
      assert.equal(f.schedules.claim(schedule.id, scope), null);
      if (scope.agent_id === owner.agent_id)
        assert.throws(() => f.schedules.createReminder(scope, { text: "Private reminder", delay_seconds: 1 }, request(1)), /different details/);
    }
    assert.equal(f.schedules.get(owner, schedule.id)!.state, "pending");
    assert.equal(f.schedules.cancel(owner, schedule.id)!.state, "cancelled");
    assert.equal(f.schedules.claim(schedule.id, owner), null);
    assert.deepEqual(f.schedules.list(owner), []);
  } finally { f.close(); }
});

test("reminder completion commits a single durable outbox transaction atomically, including late delivery", () => {
  const f = fixture();
  try {
    const schedule = f.schedules.createReminder(owner, { text: "Still deliver after downtime", delay_seconds: 1 }, request(1));
    assert.equal(f.schedules.due().length, 0);
    f.now.value += 3 * 86400_000;
    assert.equal(f.schedules.due()[0].id, schedule.id);
    const claim = f.schedules.claim(schedule.id, owner)!;
    assert.ok(claim && claim.occurrence_at < f.now.value);
    assert.equal(f.schedules.claim(schedule.id, owner), null);
    assert.throws(() => f.schedules.complete(claim, (txn) => {
      f.db.prepare("INSERT INTO outbox VALUES(?,?)").run(txn, schedule.text);
      throw new Error("Simulated transaction failure");
    }), /transaction failure/);
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM outbox").get()!.count, 0);
    assert.equal(f.schedules.get(owner, schedule.id)!.state, "running");
    assert.equal(f.schedules.complete(claim, (txn) => {
      f.db.prepare("INSERT INTO outbox VALUES(?,?)").run(txn, schedule.text);
    }), true);
    assert.equal(f.schedules.get(owner, schedule.id)!.state, "done");
    assert.equal(f.schedules.complete(claim, () => { assert.fail("A completed reminder cannot enqueue again"); }), false);
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM outbox").get()!.count, 1);
    assert.equal(f.schedules.due().length, 0);
  } finally { f.close(); }
});

test("restart retries only safe reminder persistence and never reruns an uncertain briefing", () => {
  const directory = mkdtempSync(join(tmpdir(), "family-schedules-")), path = join(directory, "application.sqlite"), now = clock();
  let db = open(path);
  try {
    let schedules = new ScheduleStore(db, { now: () => now.value });
    const reminder = schedules.createReminder(owner, { text: "Keep the original transaction", delay_seconds: 1 }, request(1));
    const briefing = schedules.createBriefing(owner, { query: "Weather and current news", time: "12:01" }, request(2));
    now.value += 60_000;
    const oldReminder = schedules.claim(reminder.id, owner)!, oldBriefing = schedules.claim(briefing.id, owner)!;
    db.close(); db = open(path); schedules = new ScheduleStore(db, { now: () => now.value });
    assert.equal(schedules.get(owner, reminder.id)!.state, "pending");
    assert.equal(schedules.get(owner, briefing.id)!.state, "needs_attention");
    assert.match(schedules.get(owner, briefing.id)!.last_error!, /not rerun automatically/);
    const newReminder = schedules.claim(reminder.id, owner)!;
    assert.equal(newReminder.txn_id, oldReminder.txn_id);
    assert.notEqual(newReminder.run_id, oldReminder.run_id);
    assert.equal(schedules.complete(oldReminder, () => { assert.fail("Stale claim cannot commit"); }), false);
    assert.equal(schedules.complete(oldBriefing, () => { assert.fail("Uncertain briefing cannot commit"); }), false);
    assert.equal(schedules.complete(newReminder, (txn) => { db.prepare("INSERT INTO outbox VALUES(?,?)").run(txn, "Reminder"); }), true);
    schedules.recoverInterrupted();
    assert.equal(schedules.get(owner, reminder.id)!.state, "done");
    assert.equal(db.prepare("SELECT count(*) AS count FROM outbox").get()!.count, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("daily briefings skip missed bursts, cannot complete after cancellation, and retain failed operations for review", () => {
  const f = fixture();
  try {
    const briefing = f.schedules.createBriefing(owner, { query: "Today's weather and three headlines", time: "07:00" }, request(1));
    assert.equal(briefing.next_run_local, "2026-11-07 07:00 Asia/Singapore");
    f.now.value = Date.parse("2026-11-11T02:00:00Z");
    const claim = f.schedules.claim(briefing.id, owner)!;
    assert.equal(f.schedules.complete(claim, () => {}), true);
    assert.equal(f.schedules.get(owner, briefing.id)!.next_run_local, "2026-11-12 07:00 Asia/Singapore");
    assert.equal(f.schedules.due().length, 0);
    f.now.value = Date.parse("2026-11-12T00:00:00Z");
    const failed = f.schedules.claim(briefing.id, owner)!;
    assert.equal(f.schedules.fail(failed, "Search access is unavailable for this connection."), true);
    assert.equal(f.schedules.get(owner, briefing.id)!.state, "needs_attention");
    assert.equal(f.schedules.claim(briefing.id, owner), null);
    assert.equal(f.schedules.list(owner, "briefing").length, 1);
    assert.equal(f.schedules.cancel(owner, briefing.id)!.state, "cancelled");
    const next = f.schedules.createReminder(owner, { text: "Cancel during execution", delay_seconds: 1 }, request(2));
    f.now.value += 1000;
    const cancelled = f.schedules.claim(next.id, owner)!;
    f.schedules.cancel(owner, next.id);
    assert.equal(f.schedules.complete(cancelled, () => { assert.fail("Cancelled operations cannot deliver"); }), false);
  } finally { f.close(); }
});

test("daily wall-clock times handle half-hour offsets, DST gaps, and repeated hours without duplicate daily delivery", () => {
  assert.equal(new Date(nextDailyTime("07:00", "Asia/Kolkata", Date.parse("2026-11-06T00:00:00Z"))).toISOString(), "2026-11-06T01:30:00.000Z");
  assert.equal(new Date(nextDailyTime("07:00", "Asia/Kathmandu", Date.parse("2026-11-06T00:00:00Z"))).toISOString(), "2026-11-06T01:15:00.000Z");
  assert.equal(new Date(nextDailyTime("02:30", "America/New_York", Date.parse("2026-03-08T05:00:00Z"))).toISOString(), "2026-03-08T07:00:00.000Z");
  const firstFold = nextDailyTime("01:30", "America/New_York", Date.parse("2026-11-01T04:00:00Z"));
  assert.equal(new Date(firstFold).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(nextDailyTime("01:30", "America/New_York", Date.parse("2026-11-01T05:40:00Z"))).toISOString(), "2026-11-01T06:30:00.000Z");
  assert.equal(new Date(nextDailyTime("01:30", "America/New_York", Date.parse("2026-11-01T06:10:00Z"), firstFold)).toISOString(), "2026-11-02T06:30:00.000Z");
  assert.throws(() => nextDailyTime("24:00", "UTC", Date.now()), /HH:mm/);
});

test("due batches use the current Matrix identity and invalid rooms can be held without blocking other jobs", () => {
  const f = fixture();
  try {
    const oldIdentity = { ...owner, homeserver: "https://old.example.org" };
    const anotherRoom = { ...owner, room_id: "!other-owner-dm:example.org" };
    f.schedules.createReminder(oldIdentity, { text: "Old server", delay_seconds: 1 }, request(1));
    f.schedules.createReminder(second, { text: "Another account", delay_seconds: 1 }, request(2));
    const invalidRoom = f.schedules.createReminder(owner, { text: "Review the room", delay_seconds: 1 }, request(3));
    const validRoom = f.schedules.createReminder(anotherRoom, { text: "Still deliver", delay_seconds: 1 }, request(4));
    f.now.value += 1000;
    assert.deepEqual(new Set(f.schedules.dueForIdentity(owner).map((job) => job.id)), new Set([invalidRoom.id, validRoom.id]));
    assert.equal(f.schedules.hold(second, invalidRoom.id, "Invalid room"), false);
    assert.equal(f.schedules.hold(owner, invalidRoom.id, "The original room is no longer an encrypted owner-only direct message."), true);
    assert.deepEqual(f.schedules.dueForIdentity(owner).map((job) => job.id), [validRoom.id]);
    assert.equal(f.schedules.get(owner, invalidRoom.id)!.state, "needs_attention");
    assert.equal(f.schedules.claim(invalidRoom.id, owner), null);
    assert.equal(f.schedules.hold(owner, invalidRoom.id, "No second change"), false);
  } finally { f.close(); }
});

test("Agent identity cancellation invalidates all old claims and releases quota without affecting another owner", () => {
  const f = fixture();
  try {
    const jobs = Array.from({ length: 20 }, (_, index) => f.schedules.createReminder(owner, { text: `Old identity ${index}`, delay_seconds: 1 }, request(index)));
    const retained = f.schedules.createReminder(second, { text: "Another owner", delay_seconds: 1 }, request(1));
    f.now.value += 1000;
    const active = f.schedules.claim(jobs[0].id, owner)!;
    f.schedules.hold(owner, jobs[1].id, "Room needs review");
    assert.throws(() => f.schedules.createReminder(owner, { text: "Before reset", delay_seconds: 1 }, request(21)), /at most 20/);
    assert.equal(f.schedules.cancelAgent(owner.agent_id), 20);
    assert.equal(f.schedules.cancelAgent(owner.agent_id), 0);
    assert.deepEqual(f.schedules.list(owner), []);
    assert.equal(f.schedules.complete(active, () => { assert.fail("An old identity cannot deliver"); }), false);
    assert.equal(f.schedules.get(second, retained.id)!.state, "pending");
    assert.equal(f.schedules.get(owner, jobs[1].id)!.last_error, null);
    const replacement = f.schedules.createReminder({ ...owner, owner_matrix_id: "@new-owner:example.org" }, { text: "New owner", delay_seconds: 1 }, request(21));
    assert.equal(replacement.state, "pending");
    assert.deepEqual(f.schedules.list(owner), []);
  } finally { f.close(); }
});

test("returning a pre-delivery reminder preserves its deadline and transaction while rejecting stale or briefing claims", () => {
  const f = fixture();
  try {
    const reminder = f.schedules.createReminder(owner, { text: "Resume after the transition", delay_seconds: 1 }, request(1));
    const briefing = f.schedules.createBriefing(owner, { query: "Current news", time: "12:01" }, request(2));
    f.now.value += 60_000;
    const original = f.schedules.claim(reminder.id, owner)!, briefingClaim = f.schedules.claim(briefing.id, owner)!;
    assert.equal(f.schedules.returnReminder(briefingClaim), false);
    assert.equal(f.schedules.returnReminder({ ...original, txn_id: "wrong-transaction" }), false);
    assert.equal(f.schedules.returnReminder(original), true);
    assert.equal(f.schedules.returnReminder(original), false);
    assert.equal(f.schedules.get(owner, reminder.id)!.next_run, reminder.next_run);
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM outbox").get()!.count, 0);
    const retry = f.schedules.claim(reminder.id, owner)!;
    assert.equal(retry.txn_id, original.txn_id);
    assert.notEqual(retry.run_id, original.run_id);
    assert.equal(f.schedules.returnReminder(original), false);
    assert.equal(f.schedules.complete(retry, (txn) => { f.db.prepare("INSERT INTO outbox VALUES(?,?)").run(txn, "Reminder"); }), true);
    assert.equal(f.schedules.returnReminder(retry), false);
    assert.equal(f.schedules.get(owner, reminder.id)!.state, "done");
  } finally { f.close(); }
});
