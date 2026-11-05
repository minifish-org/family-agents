import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  randomUUID,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function required(value: unknown, name: string, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(400, `${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export function password(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    throw new AppError(400, "Password is required (maximum 4096 characters).");
  return value;
}
export function matrixId(value: unknown): string {
  const id = required(value, "Matrix ID", 255);
  if (!/^@[^\s:]+:[^\s/#?]+$/.test(id))
    throw new AppError(400, "Use a full Matrix ID, such as @name:example.org.");
  return id;
}
export interface Person {
  id: string;
  matrix_id: string;
  display_name: string;
}
export interface Agent {
  id: string;
  person_id: string;
  matrix_id: string;
  display_name: string;
  avatar: string | null;
  instructions: string;
  status: string;
  error: string | null;
  version: number;
  desired: number;
}
export interface Settings {
  version: number;
  homeserver: string;
  provider: string;
  model: string;
  thinking_level: string;
  runtime: "pi" | "codex";
}
export type Image = { data: string; mime_type: string };
export function image(value: unknown): Image | null {
  if (value == null) return null;
  const v = value as Image;
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      v.mime_type,
    ) ||
    typeof v.data !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data) ||
    !v.data.length ||
    v.data.length > 11_184_812
  )
    throw new AppError(
      400,
      "Upload a PNG, JPEG, WebP, or GIF image up to 8 MiB.",
    );
  return { data: v.data, mime_type: v.mime_type };
}

export class Store {
  db: DatabaseSync;
  private key: Buffer;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const keyPath = join(dir, "credentials.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    chmodSync(keyPath, 0o600);
    this.db = new DatabaseSync(join(dir, "application.sqlite"));
    chmodSync(join(dir, "application.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,matrix_id TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),matrix_id TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,avatar TEXT,instructions TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'Stopped',error TEXT,version INTEGER NOT NULL DEFAULT 1,desired INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS credentials(agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,secret BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,homeserver TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,thinking_level TEXT NOT NULL);
      INSERT OR IGNORE INTO settings(id,version,homeserver,provider,model,thinking_level) VALUES(1,1,'','','','off');
      CREATE TABLE IF NOT EXISTS inbox(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,event_id TEXT NOT NULL,room_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',created INTEGER NOT NULL,PRIMARY KEY(agent_id,event_id));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,room_id TEXT NOT NULL,payload TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
      UPDATE agents SET status='Stopped',error=NULL;
      UPDATE inbox SET state='interrupted' WHERE state='running';`);
    // Additive upgrade preserves existing Pi defaults and all business records.
    const columns = this.db.prepare("PRAGMA table_info(settings)").all();
    if (!columns.some((column) => column.name === "runtime"))
      this.db.exec("ALTER TABLE settings ADD COLUMN runtime TEXT NOT NULL DEFAULT 'pi'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_defaults(
      runtime TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,thinking_level TEXT NOT NULL);
      INSERT OR IGNORE INTO runtime_defaults SELECT runtime,provider,model,thinking_level FROM settings WHERE id=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  people() {
    return this.db
      .prepare("SELECT * FROM people ORDER BY rowid")
      .all() as unknown as Person[];
  }
  person(id: string) {
    const p = this.db
      .prepare("SELECT * FROM people WHERE id=?")
      .get(id) as unknown as Person;
    if (!p) throw new AppError(404, "Person not found.");
    return p;
  }
  addPerson(mxid: string, name: string) {
    const p = { id: randomUUID(), matrix_id: mxid, display_name: name };
    this.db
      .prepare("INSERT INTO people VALUES(?,?,?)")
      .run(p.id, p.matrix_id, p.display_name);
    return p;
  }
  agents(person?: string) {
    return (person
      ? this.db
          .prepare("SELECT * FROM agents WHERE person_id=? ORDER BY rowid")
          .all(person)
      : this.db
          .prepare("SELECT * FROM agents ORDER BY rowid")
          .all()) as unknown as Agent[];
  }
  agent(id: string) {
    const a = this.db
      .prepare("SELECT * FROM agents WHERE id=?")
      .get(id) as unknown as Agent;
    if (!a) throw new AppError(404, "Agent not found.");
    return a;
  }
  checkVersion(id: string, version: unknown) {
    const a = this.agent(id);
    if (a.version !== version)
      throw new AppError(
        409,
        "This Agent changed in another browser. Reload before saving.",
      );
    return a;
  }
  password(id: string): string {
    const row = this.db
      .prepare("SELECT secret FROM credentials WHERE agent_id=?")
      .get(id) as { secret: Uint8Array } | undefined;
    if (!row) return "";
    const b = Buffer.from(row.secret);
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
  }
  setPassword(id: string, password: string) {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      nonce,
      c.update(password),
      c.final(),
      c.getAuthTag(),
    ]);
    this.db
      .prepare(
        "INSERT INTO credentials VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET secret=excluded.secret",
      )
      .run(id, data);
  }
  status(id: string, status: string, error: string | null = null) {
    this.db
      .prepare("UPDATE agents SET status=?,error=? WHERE id=?")
      .run(status, error, id);
  }
  settings() {
    const { id: _, ...s } = this.db
      .prepare("SELECT * FROM settings WHERE id=1")
      .get()!;
    return s as unknown as Settings;
  }
  saveSettings(s: Settings) {
    return this.transaction(() => {
      const r = this.db
        .prepare(
          "UPDATE settings SET version=version+1,homeserver=?,provider=?,model=?,thinking_level=?,runtime=? WHERE id=1 AND version=?",
        )
        .run(s.homeserver, s.provider, s.model, s.thinking_level, s.runtime ?? "pi", s.version);
      if (!r.changes)
        throw new AppError(
          409,
          "Settings changed in another browser. Reload before saving.",
        );
      this.db.prepare(`INSERT INTO runtime_defaults VALUES(?,?,?,?) ON CONFLICT(runtime)
        DO UPDATE SET provider=excluded.provider,model=excluded.model,thinking_level=excluded.thinking_level`)
        .run(s.runtime ?? "pi", s.provider, s.model, s.thinking_level);
      return this.settings();
    });
  }
  runtimeDefaults(runtime: "pi" | "codex") {
    return this.db.prepare("SELECT provider,model,thinking_level FROM runtime_defaults WHERE runtime=?").get(runtime)
      ?? { provider: runtime === "codex" ? "codex" : "", model: "", thinking_level: "" };
  }
  enqueue(id: string, event: string, room: string, payload: unknown) {
    return !!this.db
      .prepare("INSERT OR IGNORE INTO inbox VALUES(?,?,?,?,?,?)")
      .run(id, event, room, JSON.stringify(payload), "queued", Date.now())
      .changes;
  }
  pending(id: string) {
    return this.db
      .prepare(
        "SELECT * FROM inbox WHERE agent_id=? AND state='queued' ORDER BY created,rowid",
      )
      .all(id) as unknown as Array<{
      event_id: string;
      room_id: string;
      payload: string;
    }>;
  }
  mark(id: string, event: string, state: string) {
    this.db
      .prepare("UPDATE inbox SET state=? WHERE agent_id=? AND event_id=?")
      .run(state, id, event);
  }
  addOutbox(id: string, room: string, payload: unknown, txn: string = randomUUID()) {
    this.db
      .prepare("INSERT INTO outbox VALUES(?,?,?,?,0,?)")
      .run(txn, id, room, JSON.stringify(payload), Date.now());
    return txn;
  }
  outbox(id: string) {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE agent_id=? AND sent=0 ORDER BY created,rowid",
      )
      .all(id) as unknown as Array<{
      id: string;
      room_id: string;
      payload: string;
    }>;
  }
  sent(id: string) {
    this.db.prepare("UPDATE outbox SET sent=1 WHERE id=?").run(id);
  }
  close() {
    this.db.close();
  }
}

export class Serial {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    this.tails.set(id, result);
    void result
      .finally(() => {
        if (this.tails.get(id) === result) this.tails.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async drain() {
    await Promise.allSettled([...this.tails.values()]);
  }
}
