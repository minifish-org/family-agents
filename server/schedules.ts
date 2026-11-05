import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, required } from "./store.js";

export type ScheduleScope = {
  agent_id: string;
  room_id: string;
  homeserver: string;
  agent_matrix_id: string;
  owner_matrix_id: string;
};
export type ScheduleIdentity = Omit<ScheduleScope, "room_id">;
export type ScheduleState = "pending" | "running" | "needs_attention" | "done" | "cancelled";
export type ScheduleKind = "reminder" | "briefing";
export type Schedule = ScheduleScope & {
  id: string;
  kind: ScheduleKind;
  text: string;
  time_zone: string;
  time: string | null;
  next_run: number;
  next_run_local: string;
  state: ScheduleState;
  active_run: string | null;
  last_error: string | null;
  created: number;
  updated: number;
};
export type ScheduleClaim = {
  schedule: Schedule;
  run_id: string;
  txn_id: string;
  occurrence_at: number;
};
export type ScheduleRequest = { source_event_id: string; call_id: string };
type Options = { now?: () => number; defaultTimeZone?: string; maxActivePerAgent?: number; recover?: boolean };
type StoredSchedule = Omit<Schedule, "next_run_local"> & { source_event_id: string; call_id: string; request_hash: string };

const DAY = 86_400_000;
const YEAR = 365 * DAY;
const scopeColumns = ["agent_id", "room_id", "homeserver", "agent_matrix_id", "owner_matrix_id"] as const;
const scopeWhere = scopeColumns.map((column) => `${column}=?`).join(" AND ");
const formatters = new Map<string, Intl.DateTimeFormat>();

function timeZone(value: unknown): string {
  const zone = required(value, "Time zone", 100);
  if (zone !== "UTC" && !zone.includes("/")) throw new AppError(400, "Use an IANA time zone, such as Asia/Singapore or America/New_York.");
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; }
  catch { throw new AppError(400, "Choose a valid IANA time zone."); }
}

function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    if (formatters.size >= 64) formatters.clear();
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(zone, value);
  }
  return value;
}

function localParts(instant: number, zone: string) {
  const fields = Object.fromEntries(formatter(zone).formatToParts(instant).map(({ type, value }) => [type, value]));
  return { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day), hour: Number(fields.hour), minute: Number(fields.minute) };
}

function localDay(instant: number, zone: string) {
  const p = localParts(instant, zone);
  return Date.UTC(p.year, p.month - 1, p.day);
}

function localDisplay(instant: number, zone: string) {
  const p = localParts(instant, zone), pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zone}`;
}

/** Daily wall-clock occurrences are resolved locally, including DST gaps and folds. */
export function nextDailyTime(time: string, zoneInput: string, after: number, previousOccurrence?: number): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError(400, "Use a daily time in HH:mm format.");
  if (!Number.isFinite(after)) throw new AppError(400, "The schedule time is invalid.");
  const zone = timeZone(zoneInput), [hour, minute] = time.split(":").map(Number);
  let firstDay = localDay(after, zone);
  if (previousOccurrence !== undefined) firstDay = Math.max(firstDay, localDay(previousOccurrence, zone) + DAY);
  for (let dayIndex = 0; dayIndex < 8; dayIndex++) {
    const day = firstDay + dayIndex * DAY, desired = day + (hour * 60 + minute) * 60_000;
    const offsets = new Set<number>();
    for (let sample = desired - 36 * 3_600_000; sample <= desired + 36 * 3_600_000; sample += 6 * 3_600_000) {
      const p = localParts(sample, zone);
      offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
    }
    // A skipped time runs at the first valid minute afterward, once on that local day.
    for (let wall = desired; wall < day + DAY; wall += 60_000) {
      const expected = new Date(wall);
      const candidates = [...offsets].map((offset) => wall - offset).filter((candidate) => {
        const p = localParts(candidate, zone);
        return p.year === expected.getUTCFullYear() && p.month === expected.getUTCMonth() + 1 && p.day === expected.getUTCDate()
          && p.hour === expected.getUTCHours() && p.minute === expected.getUTCMinutes();
      });
      if (!candidates.length) continue;
      const future = candidates.filter((candidate) => candidate > after);
      if (future.length) return Math.min(...future);
      break;
    }
  }
  throw new AppError(400, "The next daily time could not be resolved. Choose another time zone or time.");
}

function absoluteTime(value: unknown): number {
  const text = required(value, "Reminder time", 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) throw new AppError(400, "Use an ISO date and time with an explicit UTC offset, such as 2026-11-06T19:00:00+08:00.");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const offset = match[8];
  if (year < 2000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)))
    throw new AppError(400, "The reminder date or time is invalid.");
  const result = Date.parse(text);
  if (!Number.isFinite(result)) throw new AppError(400, "The reminder date or time is invalid.");
  return result;
}

function scopeValues(scope: ScheduleScope): string[] {
  return scopeColumns.map((column) => required(scope[column], "Schedule routing", 2048));
}

/** Safe tool receipt: routing and idempotency fields remain application-internal. */
export function scheduleReceipt(schedule: Schedule) {
  return {
    id: schedule.id, kind: schedule.kind, text: schedule.text, state: schedule.state, time_zone: schedule.time_zone,
    ...(schedule.time ? { time: schedule.time } : {}),
    scheduled_for: new Date(schedule.next_run).toISOString(), local_time: schedule.next_run_local,
    ...(schedule.last_error ? { message: schedule.last_error } : {}),
  };
}

/** Durable jobs only; Manager owns serialized execution, room checks, and delivery. */
export class ScheduleStore {
  private readonly now: () => number;
  private readonly defaultTimeZone: string;
  private readonly maximum: number;
  private savepoint = 0;

  constructor(private readonly db: DatabaseSync, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTimeZone = timeZone(options.defaultTimeZone ?? "Asia/Singapore");
    this.maximum = options.maxActivePerAgent ?? 20;
    if (!Number.isInteger(this.maximum) || this.maximum < 1 || this.maximum > 100) throw new Error("Invalid schedule limit.");
    this.init();
    if (options.recover !== false) this.recoverInterrupted();
  }

  init() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(
      id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,room_id TEXT NOT NULL,
      homeserver TEXT NOT NULL,agent_matrix_id TEXT NOT NULL,owner_matrix_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reminder','briefing')),text TEXT NOT NULL,time_zone TEXT NOT NULL,time TEXT,
      next_run INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','needs_attention','done','cancelled')),
      active_run TEXT,last_error TEXT,source_event_id TEXT NOT NULL,call_id TEXT NOT NULL,request_hash TEXT NOT NULL,
      created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(agent_id,source_event_id,call_id));
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state,next_run);
      CREATE TABLE IF NOT EXISTS schedule_runs(
      id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      occurrence_at INTEGER NOT NULL,txn_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,
      error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(schedule_id,occurrence_at));`);
  }

  private atomic<T>(operation: () => T): T {
    const name = `schedule_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const value = operation(); this.db.exec(`RELEASE ${name}`); return value; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error; }
  }

  private record(row: unknown): Schedule | null {
    if (!row) return null;
    const value = row as StoredSchedule;
    const { source_event_id: _, call_id: __, request_hash: ___, ...publicValue } = value;
    return { ...publicValue, next_run_local: localDisplay(value.next_run, value.time_zone) };
  }

  get(scope: ScheduleScope, id: string): Schedule | null {
    return this.record(this.db.prepare(`SELECT * FROM schedules WHERE id=? AND ${scopeWhere}`).get(id, ...scopeValues(scope)));
  }

  list(scope: ScheduleScope, kind?: ScheduleKind): Schedule[] {
    if (kind !== undefined && kind !== "reminder" && kind !== "briefing") throw new AppError(400, "Choose reminders or briefings.");
    return this.db.prepare(`SELECT * FROM schedules WHERE ${scopeWhere} AND state IN ('pending','running','needs_attention')${kind ? " AND kind=?" : ""} ORDER BY next_run,id`)
      .all(...scopeValues(scope), ...(kind ? [kind] : [])).map((row) => this.record(row)!);
  }

  private create(scope: ScheduleScope, kind: ScheduleKind, text: string, zone: string, time: string | null,
    next: number, request: ScheduleRequest, requestHash: string): Schedule {
    const values = scopeValues(scope), event = required(request.source_event_id, "Source event", 2048), call = required(request.call_id, "Tool call", 1024);
    return this.atomic(() => {
      const existing = this.db.prepare("SELECT * FROM schedules WHERE agent_id=? AND source_event_id=? AND call_id=?").get(values[0], event, call) as StoredSchedule | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash || scopeColumns.some((column, index) => existing[column] !== values[index]))
          throw new AppError(409, "This scheduling request already completed with different details. List schedules before trying again.");
        return this.record(existing)!;
      }
      const active = this.db.prepare("SELECT count(*) AS count FROM schedules WHERE agent_id=? AND state IN ('pending','running','needs_attention')").get(values[0])!.count as number;
      if (active >= this.maximum) throw new AppError(400, `An Agent can have at most ${this.maximum} active reminders and briefings. Cancel one before adding another.`);
      const id = randomUUID(), now = this.now();
      this.db.prepare("INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,?,?,?,?,?)")
        .run(id, ...values, kind, text, zone, time, next, event, call, requestHash, now, now);
      return this.get(scope, id)!;
    });
  }

  createReminder(scope: ScheduleScope, input: { text: string; time_zone?: string; at?: string; delay_seconds?: number }, request: ScheduleRequest): Schedule {
    const text = required(input.text, "Reminder text", 2048), zone = timeZone(input.time_zone ?? this.defaultTimeZone), now = this.now();
    if ((input.at !== undefined) === (input.delay_seconds !== undefined)) throw new AppError(400, "Choose exactly one absolute reminder time or delay in seconds.");
    let next: number;
    if (input.delay_seconds !== undefined) {
      if (!Number.isInteger(input.delay_seconds) || input.delay_seconds < 1 || input.delay_seconds > YEAR / 1000)
        throw new AppError(400, "Reminder delay must be a whole number of seconds between 1 second and 365 days.");
      next = now + input.delay_seconds * 1000;
    } else next = absoluteTime(input.at);
    const requestHash = createHash("sha256").update(JSON.stringify(["reminder", text, zone, input.at !== undefined ? new Date(next).toISOString() : null, input.delay_seconds ?? null])).digest("hex");
    // An idempotent retry retains its original deadline even if it has since passed.
    const event = required(request.source_event_id, "Source event", 2048), call = required(request.call_id, "Tool call", 1024);
    const existing = this.db.prepare("SELECT id FROM schedules WHERE agent_id=? AND source_event_id=? AND call_id=?").get(scope.agent_id, event, call);
    if (!existing && (next < now + 1000 || next > now + YEAR)) throw new AppError(400, "Choose a reminder time at least one second and at most 365 days from now.");
    return this.create(scope, "reminder", text, zone, null, next, request, requestHash);
  }

  createBriefing(scope: ScheduleScope, input: { query: string; time_zone?: string; time: string }, request: ScheduleRequest): Schedule {
    const text = required(input.query, "Briefing request", 1024), zone = timeZone(input.time_zone ?? this.defaultTimeZone);
    const time = required(input.time, "Daily briefing time", 5), next = nextDailyTime(time, zone, this.now());
    const hash = createHash("sha256").update(JSON.stringify(["briefing", text, zone, time])).digest("hex");
    return this.create(scope, "briefing", text, zone, time, next, request, hash);
  }

  cancel(scope: ScheduleScope, id: string): Schedule | null {
    return this.atomic(() => {
      const schedule = this.get(scope, required(id, "Schedule ID", 100));
      if (!schedule) return null;
      if (schedule.state !== "done" && schedule.state !== "cancelled") {
        this.db.prepare("UPDATE schedules SET state='cancelled',active_run=NULL,last_error=NULL,updated=? WHERE id=?").run(this.now(), schedule.id);
        this.db.prepare("UPDATE schedule_runs SET state='cancelled',updated=? WHERE schedule_id=? AND state IN ('pending','running','needs_attention')").run(this.now(), schedule.id);
      }
      return this.get(scope, schedule.id);
    });
  }

  /** Application lifecycle only: invalidate all prior jobs before changing an Agent identity. */
  cancelAgent(agentId: string): number {
    const id = required(agentId, "Agent ID", 256);
    return this.atomic(() => {
      const now = this.now();
      this.db.prepare("UPDATE schedule_runs SET state='cancelled',updated=? WHERE state IN ('pending','running','needs_attention') AND schedule_id IN (SELECT id FROM schedules WHERE agent_id=?)")
        .run(now, id);
      return Number(this.db.prepare("UPDATE schedules SET state='cancelled',active_run=NULL,last_error=NULL,updated=? WHERE agent_id=? AND state IN ('pending','running','needs_attention')")
        .run(now, id).changes);
    });
  }

  due(limit = 50): Schedule[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "The schedule batch limit is invalid.");
    return this.db.prepare("SELECT * FROM schedules WHERE state='pending' AND next_run<=? ORDER BY next_run,id LIMIT ?")
      .all(this.now(), limit).map((row) => this.record(row)!);
  }

  /** Scope each batch to a currently running identity so paused accounts cannot starve it. */
  dueForIdentity(identity: ScheduleIdentity, limit = 20): Schedule[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "The schedule batch limit is invalid.");
    const columns = scopeColumns.filter((column) => column !== "room_id");
    const values = columns.map((column) => required(identity[column], "Schedule routing", 2048));
    return this.db.prepare(`SELECT * FROM schedules WHERE ${columns.map((column) => `${column}=?`).join(" AND ")} AND state='pending' AND next_run<=? ORDER BY next_run,id LIMIT ?`)
      .all(...values, this.now(), limit).map((row) => this.record(row)!);
  }

  /** Invalid routing is terminal until the owner reviews or replaces the schedule. */
  hold(scope: ScheduleScope, id: string, message: string): boolean {
    return this.atomic(() => {
      const schedule = this.get(scope, id);
      if (!schedule || schedule.state !== "pending") return false;
      const error = required(message, "Schedule error", 1024);
      this.db.prepare("UPDATE schedules SET state='needs_attention',last_error=?,updated=? WHERE id=? AND state='pending'")
        .run(error, this.now(), schedule.id);
      return true;
    });
  }

  claim(id: string, scope: ScheduleScope): ScheduleClaim | null {
    return this.atomic(() => {
      const schedule = this.get(scope, id), now = this.now();
      if (!schedule || schedule.state !== "pending" || schedule.next_run > now) return null;
      const occurrence = createHash("sha256").update(`${schedule.id}:${schedule.next_run}`).digest("hex"), txn = `schedule-${occurrence}`, run = randomUUID();
      this.db.prepare("INSERT INTO schedule_runs VALUES(?,?,?,?,'running',NULL,?,?) ON CONFLICT(schedule_id,occurrence_at) DO UPDATE SET id=excluded.id,txn_id=excluded.txn_id,state='running',error=NULL,updated=excluded.updated")
        .run(run, schedule.id, schedule.next_run, txn, now, now);
      this.db.prepare("UPDATE schedules SET state='running',active_run=?,last_error=NULL,updated=? WHERE id=? AND state='pending'").run(run, now, schedule.id);
      return { schedule: this.get(scope, id)!, run_id: run, txn_id: txn, occurrence_at: schedule.next_run };
    });
  }

  /** A reminder has no model execution to replay before its atomic outbox commit. */
  returnReminder(claim: ScheduleClaim): boolean {
    return this.atomic(() => {
      const current = this.get(claim.schedule, claim.schedule.id);
      if (!current || current.kind !== "reminder" || current.state !== "running" || current.active_run !== claim.run_id
        || current.next_run !== claim.occurrence_at) return false;
      const run = this.db.prepare("SELECT txn_id FROM schedule_runs WHERE id=? AND schedule_id=? AND occurrence_at=? AND state='running'")
        .get(claim.run_id, current.id, claim.occurrence_at);
      if (!run || run.txn_id !== claim.txn_id) return false;
      const now = this.now();
      this.db.prepare("UPDATE schedule_runs SET state='pending',updated=? WHERE id=? AND state='running'").run(now, claim.run_id);
      this.db.prepare("UPDATE schedules SET state='pending',active_run=NULL,last_error=NULL,updated=? WHERE id=? AND active_run=?")
        .run(now, current.id, claim.run_id);
      return true;
    });
  }

  /** The callback must synchronously persist outbox delivery using this stable transaction ID. */
  complete(claim: ScheduleClaim, enqueue: (txnId: string) => string | void): boolean {
    return this.atomic(() => {
      const current = this.get(claim.schedule, claim.schedule.id);
      if (!current || current.state !== "running" || current.active_run !== claim.run_id || current.next_run !== claim.occurrence_at) return false;
      const run = this.db.prepare("SELECT txn_id FROM schedule_runs WHERE id=? AND schedule_id=? AND occurrence_at=? AND state='running'")
        .get(claim.run_id, current.id, claim.occurrence_at);
      if (!run || run.txn_id !== claim.txn_id) return false;
      const result = enqueue(claim.txn_id);
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Scheduled outbox persistence must be synchronous.");
      const now = this.now();
      this.db.prepare("UPDATE schedule_runs SET state='done',updated=? WHERE id=? AND state='running'").run(now, claim.run_id);
      if (current.kind === "reminder")
        this.db.prepare("UPDATE schedules SET state='done',active_run=NULL,last_error=NULL,updated=? WHERE id=?").run(now, current.id);
      else this.db.prepare("UPDATE schedules SET state='pending',next_run=?,active_run=NULL,last_error=NULL,updated=? WHERE id=?")
        .run(nextDailyTime(current.time!, current.time_zone, now, claim.occurrence_at), now, current.id);
      return true;
    });
  }

  fail(claim: ScheduleClaim, message = "This scheduled operation did not complete. Review or cancel it before creating a replacement."): boolean {
    return this.atomic(() => {
      const current = this.get(claim.schedule, claim.schedule.id);
      if (!current || current.state !== "running" || current.active_run !== claim.run_id) return false;
      const error = required(message, "Schedule error", 1024), now = this.now();
      this.db.prepare("UPDATE schedules SET state='needs_attention',active_run=NULL,last_error=?,updated=? WHERE id=?").run(error, now, current.id);
      this.db.prepare("UPDATE schedule_runs SET state='needs_attention',error=?,updated=? WHERE id=?").run(error, now, claim.run_id);
      return true;
    });
  }

  recoverInterrupted() {
    return this.atomic(() => {
      const now = this.now(), message = "The briefing was interrupted. It was not rerun automatically; cancel and recreate it to resume.";
      const reminders = this.db.prepare("UPDATE schedule_runs SET state='pending',updated=? WHERE state='running' AND schedule_id IN (SELECT id FROM schedules WHERE kind='reminder' AND state='running')").run(now).changes;
      this.db.prepare("UPDATE schedules SET state='pending',active_run=NULL,last_error=NULL,updated=? WHERE kind='reminder' AND state='running'").run(now);
      const briefings = this.db.prepare("UPDATE schedule_runs SET state='needs_attention',error=?,updated=? WHERE state='running' AND schedule_id IN (SELECT id FROM schedules WHERE kind='briefing' AND state='running')").run(message, now).changes;
      this.db.prepare("UPDATE schedules SET state='needs_attention',active_run=NULL,last_error=?,updated=? WHERE kind='briefing' AND state='running'").run(message, now);
      return { reminders, briefings };
    });
  }
}
