import { mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Gateway } from "./gateway.js";
import {
  Store,
  Serial,
  AppError,
  image,
  matrixId,
  required,
  password,
  type Agent,
  type Image,
} from "./store.js";
import { PiService } from "./pi.js";

export class Manager {
  serial = new Serial();
  closing = false;
  private recovering = false;
  private initialized = false;
  private retryTimer?: NodeJS.Timeout;
  constructor(
    public store: Store,
    public pi: PiService,
    public gateway: Gateway,
  ) {
    gateway.on("event", (e) => {
      if (e.event === "message")
        void this.receive(e).catch((error) => {
          try {
            store.status(e.agent_id, "Error", this.error(error));
          } catch {}
        });
      if (e.event === "status" && e.agent_id) {
        try {
          const a = store.agent(e.agent_id);
          if (a.desired)
            store.status(
              a.id,
              e.status === "Running" || e.status === "running"
                ? "Running"
                : e.status === "Error" || e.status === "error"
                  ? "Error"
                  : "Stopped",
              e.error ? this.error(e.error) : null,
            );
        } catch {}
      }
    });
    gateway.on("crash", () => {
      if (!this.closing && this.initialized) void this.recover();
    });
  }
  async init() {
    await this.pi.ready;
    await this.gateway.start();
    this.initialized = true;
    await this.restore();
    this.retryTimer = setInterval(() => {
      if (this.closing) return;
      for (const a of this.store
        .agents()
        .filter(
          (a) =>
            a.desired &&
            (a.status === "Running" ||
              a.error?.startsWith("Reply delivery pending:")),
        ))
        void this.serial
          .run(a.id, async () => {
            if (await this.flush(a.id)) await this.process(a.id);
          })
          .catch(() => {});
    }, 15_000);
    this.retryTimer.unref();
  }
  private async recover() {
    if (this.recovering) return;
    this.recovering = true;
    for (const a of this.store.agents())
      if (a.desired)
        this.store.status(
          a.id,
          "Error",
          "Matrix Gateway disconnected. Reconnecting.",
        );
    try {
      for (let n = 0; n < 3 && !this.closing; n++) {
        await new Promise((r) => setTimeout(r, (n + 1) * 1000));
        try {
          await this.gateway.start();
          await this.restore();
          return;
        } catch {}
      }
    } finally {
      this.recovering = false;
    }
  }
  async restore() {
    await Promise.allSettled(
      this.store
        .agents()
        .filter((a) => a.desired)
        .map((a) => this.serial.run(a.id, () => this.start(a.id))),
    );
  }
  private async start(id: string) {
    const a = this.store.agent(id),
      s = this.store.settings(),
      p = this.store.person(a.person_id);
    try {
      if (!s.homeserver)
        throw new Error("Configure Matrix Server in Settings first.");
      if (!s.provider || !s.model)
        throw new Error("Configure a default model in Settings first.");
      await this.pi.initializeAgent({ id, instructions: a.instructions }, s);
      const dir = join(this.store.dir, "matrix", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await this.gateway.request("start", {
        agent_id: id,
        homeserver: s.homeserver,
        matrix_id: a.matrix_id,
        password: this.store.password(id),
        owner_id: p.matrix_id,
        store_path: dir,
        display_name: a.display_name,
        avatar: a.avatar ? JSON.parse(a.avatar) : null,
      });
      const interrupted = this.store.db
        .prepare(
          "SELECT count(*) AS count FROM inbox WHERE agent_id=? AND state='interrupted'",
        )
        .get(id)!.count;
      this.store.status(
        id,
        "Running",
        Number(interrupted) > 0
          ? "A previous reply was interrupted. Send a new message to continue."
          : null,
      );
      if (await this.flush(id)) await this.process(id);
    } catch (e) {
      this.store.status(id, "Error", this.error(e));
    }
  }
  private error(e: unknown) {
    return this.pi.sanitizeError(
      e instanceof Error ? e.message : "Operation failed.",
    );
  }
  async create(body: any) {
    const person = this.store.person(required(body.person_id, "Person"));
    const mxid = matrixId(body.matrix_id);
    if (person.matrix_id === mxid)
      throw new AppError(
        400,
        "Agent and owner must have different Matrix accounts.",
      );
    const secret = password(body.password),
      name = required(body.display_name, "Display Name", 255),
      avatar = image(body.avatar);
    const instructions =
      typeof body.instructions === "string" ? body.instructions : "";
    if (instructions.length > 65536)
      throw new AppError(400, "Instructions are too long.");
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO agents(id,person_id,matrix_id,display_name,avatar,instructions) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          person.id,
          mxid,
          name,
          avatar ? JSON.stringify(avatar) : null,
          instructions,
        );
      this.store.setPassword(id, secret);
    });
    await this.serial.run(id, () => this.start(id));
    return this.public(this.store.agent(id));
  }
  async edit(id: string, body: any) {
    return this.serial.run(id, async () => {
      const old = this.store.checkVersion(id, body.version);
      const mxid = matrixId(body.matrix_id),
        name = required(body.display_name, "Display Name", 255),
        avatar = body.avatar === undefined ? old.avatar : image(body.avatar);
      const instructions =
        typeof body.instructions === "string" ? body.instructions : "";
      if (instructions.length > 65536)
        throw new AppError(400, "Instructions are too long.");
      if (mxid === this.store.person(old.person_id).matrix_id)
        throw new AppError(400, "Agent and owner must differ.");
      const changedIdentity = old.matrix_id !== mxid;
      if (changedIdentity && !body.password)
        throw new AppError(
          400,
          "Enter the password for the new Matrix account.",
        );
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE agents SET matrix_id=?,display_name=?,avatar=?,instructions=?,version=version+1 WHERE id=?",
          )
          .run(
            mxid,
            name,
            typeof avatar === "string"
              ? avatar
              : avatar
                ? JSON.stringify(avatar)
                : null,
            instructions,
            id,
          );
        if (body.password) this.store.setPassword(id, password(body.password));
      });
      if (old.desired || changedIdentity) {
        await this.pi.stopAgent(id);
        await this.gateway.request("stop", { agent_id: id });
      }
      if (changedIdentity) this.resetMatrix(id);
      if (old.desired) await this.start(id);
      return this.public(this.store.agent(id));
    });
  }
  async lifecycle(id: string, op: string, version: unknown) {
    return this.serial.run(id, async () => {
      this.store.checkVersion(id, version);
      this.store.db
        .prepare("UPDATE agents SET desired=?,version=version+1 WHERE id=?")
        .run(op === "stop" ? 0 : 1, id);
      if (op !== "start") {
        await this.pi.stopAgent(id);
        await this.gateway.request("stop", { agent_id: id });
        this.store.status(id, "Stopped");
      }
      if (op !== "stop") await this.start(id);
      return this.public(this.store.agent(id));
    });
  }
  async delete(id: string, version: unknown) {
    await this.serial.run(id, async () => {
      this.store.checkVersion(id, version);
      await this.pi.stopAgent(id);
      await this.gateway.request("stop", { agent_id: id });
      this.store.db.prepare("DELETE FROM agents WHERE id=?").run(id);
      for (const type of ["matrix", "agents"])
        rmSync(join(this.store.dir, type, id), {
          recursive: true,
          force: true,
        });
    });
  }
  public(a: Agent) {
    return {
      ...a,
      avatar: a.avatar
        ? `data:${(JSON.parse(a.avatar) as Image).mime_type};base64,${(JSON.parse(a.avatar) as Image).data}`
        : null,
    };
  }
  private resetMatrix(id: string) {
    const current = join(this.store.dir, "matrix", id);
    if (existsSync(current)) {
      const archive = join(this.store.dir, "matrix-archives");
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      renameSync(current, join(archive, `${id}-${randomUUID()}`));
    }
    this.store.transaction(() => {
      this.store.db.prepare("DELETE FROM inbox WHERE agent_id=?").run(id);
      this.store.db.prepare("DELETE FROM outbox WHERE agent_id=?").run(id);
    });
  }
  async reconnectAll() {
    await Promise.allSettled(
      this.store.agents().map((a) =>
        this.serial.run(a.id, async () => {
          await this.pi.stopAgent(a.id);
          await this.gateway.request("stop", { agent_id: a.id });
          this.resetMatrix(a.id);
          if (a.desired) await this.start(a.id);
        }),
      ),
    );
  }
  async receive(e: any) {
    if (this.closing) return;
    const a = this.store.agent(e.agent_id),
      p = this.store.person(a.person_id);
    if (
      !a.desired ||
      e.sender !== p.matrix_id ||
      e.sender === a.matrix_id ||
      e.is_direct !== true ||
      !Array.isArray(e.members) ||
      e.members.length !== 2 ||
      !e.members.includes(p.matrix_id) ||
      !e.members.includes(a.matrix_id) ||
      typeof e.event_id !== "string" ||
      typeof e.room_id !== "string"
    )
      return;
    let rejection: string | undefined;
    try {
      if (e.media) image(e.media);
      if (typeof e.body !== "string" || e.body.length > 65536)
        throw new AppError(400, "The incoming message exceeds the text limit.");
    } catch (error) {
      rejection = this.error(error);
    }
    const admitted = this.store.transaction(() => {
      const fresh = this.store.enqueue(
        a.id,
        e.event_id,
        e.room_id,
        rejection ? { body: "", rejected: rejection } : e,
      );
      if (fresh && rejection) this.store.mark(a.id, e.event_id, "rejected");
      return fresh;
    });
    await this.gateway.request("ack_event", {
      agent_id: a.id,
      event_id: e.event_id,
    });
    if (rejection) {
      this.store.status(a.id, a.status, rejection);
      return;
    }
    await this.serial.run(a.id, async () => {
      const current = this.store.agent(a.id);
      if (!current.desired) return;
      // A new, verified message can continue after an earlier model/input error.
      // Previously interrupted or failed turns remain terminal and are never rerun.
      if (admitted && current.status === "Error")
        this.store.status(a.id, "Running");
      if (this.store.agent(a.id).status !== "Running") return;
      if (!(await this.flush(a.id))) return;
      await this.process(a.id);
    });
  }
  private async validate(id: string, room: string) {
    const v = await this.gateway.request("validate_room", {
      agent_id: id,
      room_id: room,
    });
    const a = this.store.agent(id),
      p = this.store.person(a.person_id);
    if (
      v?.is_direct !== true ||
      v?.encrypted !== true ||
      !Array.isArray(v.members) ||
      v.members.length !== 2 ||
      !v.members.includes(a.matrix_id) ||
      !v.members.includes(p.matrix_id)
    )
      throw new Error(
        "This room is no longer an encrypted owner-only direct message.",
      );
  }
  private async process(id: string) {
    if (this.closing) return;
    for (const item of this.store.pending(id)) {
      const a = this.store.agent(id);
      if (!a.desired || a.status !== "Running" || this.closing) return;
      let started = false;
      try {
        await this.validate(id, item.room_id);
        const e = JSON.parse(item.payload);
        this.store.mark(id, item.event_id, "running");
        started = true;
        const result = await this.pi.run(
          { id, instructions: a.instructions },
          this.store.settings(),
          e.body,
          e.media
            ? [
                {
                  type: "image",
                  data: e.media.data,
                  mimeType: e.media.mime_type,
                },
              ]
            : [],
        );
        this.store.transaction(() => {
          if (result.text.trim())
            this.store.addOutbox(id, item.room_id, { text: result.text });
          for (const img of result.images)
            this.store.addOutbox(id, item.room_id, {
              media: {
                data: img.data,
                mime_type: img.mimeType,
                filename: img.name ?? "image.png",
              },
            });
          this.store.mark(id, item.event_id, "done");
        });
        this.store.status(id, "Running");
        await this.flush(id);
      } catch (e) {
        if (started) this.store.mark(id, item.event_id, "failed");
        this.store.status(id, "Error", this.error(e));
        return;
      }
    }
  }
  private async flush(id: string) {
    const hadPending = this.store.outbox(id).length > 0;
    for (const out of this.store.outbox(id)) {
      try {
        await this.validate(id, out.room_id);
        const p = JSON.parse(out.payload);
        await this.gateway.request(p.media ? "send_media" : "send_message", {
          agent_id: id,
          room_id: out.room_id,
          txn_id: out.id,
          ...(p.media ? p.media : { text: p.text }),
        });
        this.store.sent(out.id);
      } catch (e) {
        this.store.status(
          id,
          "Error",
          `Reply delivery pending: ${this.error(e)}`,
        );
        return false;
      }
    }
    if (hadPending) this.store.status(id, "Running");
    return true;
  }
  async proactive(id: string, body: any) {
    return this.serial.run(id, async () => {
      const a = this.store.agent(id);
      if (a.status !== "Running")
        throw new AppError(409, "Start the Agent first.");
      const room = required(body.room_id, "Room ID", 255);
      await this.validate(id, room);
      const txn = required(body.txn_id, "Transaction ID", 255);
      const media = body.media ? image(body.media) : null;
      if (!media && !body.text)
        throw new AppError(400, "Text or an image is required.");
      const payload = JSON.stringify(
        media
          ? { media: { ...media, filename: "image.png" } }
          : { text: required(body.text, "Text") },
      );
      const old = this.store.db
        .prepare("SELECT * FROM outbox WHERE id=?")
        .get(txn);
      if (
        old &&
        (old.agent_id !== id || old.room_id !== room || old.payload !== payload)
      )
        throw new AppError(
          409,
          "That transaction ID was already used for a different message.",
        );
      this.store.db
        .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,0,?)")
        .run(txn, id, room, payload, Date.now());
      const sent = await this.flush(id);
      return { txn_id: txn, sent };
    });
  }
  async close() {
    this.closing = true;
    clearInterval(this.retryTimer);
    await this.pi.close();
    await this.serial.drain();
    await this.gateway.close();
    this.store.close();
  }
}
